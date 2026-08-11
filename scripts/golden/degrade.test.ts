/**
 * Tests for the golden-set degrader (TRO-497 / LH-004).
 *
 * These tests never launch a browser — `makeSyntheticLabel` builds a small
 * synthetic canvas (sharp rasterizing an inline SVG, no network) with dark
 * "ink" in the named regions, so region-targeted effects have something
 * measurable to brighten, darken, or blur. This keeps the suite fast and
 * decoupled from `render.ts`'s Chromium dependency.
 *
 * Every `apply*` function validates its numeric/region parameters before
 * calling sharp (CLAUDE.md rule 13 — a prior ticket shipped a NaN-clamp bug
 * exactly at a sharp boundary). The "rejects ..." tests below are red-first
 * for that reason: each one asserts a specific bad input throws, not just
 * that *something* throws.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  applyBlur,
  applyDegradation,
  applyGlare,
  applyLowLight,
  applyPerspective,
  applyRotate,
} from "./degrade";
import { CANVAS_HEIGHT, CANVAS_WIDTH, LABEL_REGIONS } from "./render";

function toExtract(region: { x: number; y: number; width: number; height: number }) {
  return { left: region.x, top: region.y, width: region.width, height: region.height };
}

async function makeSyntheticLabel(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}">
    <rect width="100%" height="100%" fill="white" />
    <rect x="${LABEL_REGIONS.brand.x}" y="${LABEL_REGIONS.brand.y + 40}" width="400" height="30" fill="black" />
    <rect x="${LABEL_REGIONS.warning.x}" y="${LABEL_REGIONS.warning.y + 20}" width="600" height="30" fill="black" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Mean brightness of one region. Materializes the crop into its own buffer
 * with a real encode step (`.toBuffer()`) BEFORE calling `.stats()` on it,
 * as two separate sharp pipelines. Chaining `.extract(region).stats()`
 * directly on one pipeline was measured (this ticket, sharp 0.35.3 / vips
 * 8.18.3) to silently return whole-image stats, ignoring the extract —
 * confirmed with a minimal repro (a 100x100 canvas, a 10x10 black corner:
 * `.extract().stats()` reported the same mean for the black corner, a
 * white corner, and the full image; materializing first gave the correct
 * 0 / 255 / blended values). This is a measured tool quirk, not a
 * `degrade.ts` bug — `degrade.ts` never calls `.stats()`.
 */
async function meanBrightness(
  image: Buffer,
  region: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const cropped = await sharp(image).extract(toExtract(region)).toBuffer();
  const stats = await sharp(cropped).stats();
  return stats.channels[0].mean;
}

describe("applyRotate", () => {
  it("expands the canvas and changes pixel content for a non-right-angle rotation", async () => {
    const base = await makeSyntheticLabel();
    const rotated = await applyRotate(base, { angleDegrees: 15 });

    const metadata = await sharp(rotated).metadata();
    expect(metadata.width).toBeGreaterThan(CANVAS_WIDTH);
    expect(metadata.height).toBeGreaterThan(CANVAS_HEIGHT);
    expect(rotated.equals(base)).toBe(false);
  });

  it("leaves canvas size unchanged for a 180 degree rotation", async () => {
    const base = await makeSyntheticLabel();
    const rotated = await applyRotate(base, { angleDegrees: 180 });
    const metadata = await sharp(rotated).metadata();
    expect(metadata.width).toBe(CANVAS_WIDTH);
    expect(metadata.height).toBe(CANVAS_HEIGHT);
  });

  it("rejects a non-finite angle", async () => {
    const base = await makeSyntheticLabel();
    await expect(applyRotate(base, { angleDegrees: NaN })).rejects.toThrow(RangeError);
    await expect(applyRotate(base, { angleDegrees: Infinity })).rejects.toThrow(RangeError);
    await expect(applyRotate(base, { angleDegrees: "15" })).rejects.toThrow(RangeError);
  });
});

describe("applyBlur", () => {
  it("reduces high-frequency variance (pushes the image toward unreadable, rubric V9)", async () => {
    const base = await makeSyntheticLabel();
    const blurred = await applyBlur(base, { sigma: 20 });

    const beforeStats = await sharp(base).stats();
    const afterStats = await sharp(blurred).stats();
    expect(afterStats.channels[0].stdev).toBeLessThan(beforeStats.channels[0].stdev);
  });

  it("rejects a sigma below sharp's supported minimum", async () => {
    const base = await makeSyntheticLabel();
    await expect(applyBlur(base, { sigma: 0 })).rejects.toThrow(RangeError);
    await expect(applyBlur(base, { sigma: -5 })).rejects.toThrow(RangeError);
  });

  it("rejects a non-finite sigma", async () => {
    const base = await makeSyntheticLabel();
    await expect(applyBlur(base, { sigma: NaN })).rejects.toThrow(RangeError);
  });
});

describe("applyPerspective", () => {
  it("returns a valid, differently-shaped image for a nonzero shear", async () => {
    const base = await makeSyntheticLabel();
    const sheared = await applyPerspective(base, { shear: 0.15 });

    const metadata = await sharp(sheared).metadata();
    expect(metadata.width).toBeGreaterThan(CANVAS_WIDTH);
    expect(sheared.equals(base)).toBe(false);
  });

  it("rejects a non-finite shear", async () => {
    const base = await makeSyntheticLabel();
    await expect(applyPerspective(base, { shear: NaN })).rejects.toThrow(RangeError);
  });

  it("rejects a shear magnitude beyond the bound, in either direction", async () => {
    const base = await makeSyntheticLabel();
    await expect(applyPerspective(base, { shear: 3.5 })).rejects.toThrow(RangeError);
    await expect(applyPerspective(base, { shear: -3.5 })).rejects.toThrow(RangeError);
  });

  it("accepts a shear exactly at the bound", async () => {
    const base = await makeSyntheticLabel();
    await expect(applyPerspective(base, { shear: 3 })).resolves.toBeInstanceOf(Buffer);
    await expect(applyPerspective(base, { shear: -3 })).resolves.toBeInstanceOf(Buffer);
  });
});

describe("applyGlare", () => {
  it("brightens the targeted region without changing an untouched region", async () => {
    const base = await makeSyntheticLabel();
    const glared = await applyGlare(base, { region: "brand" });

    const brandBefore = await meanBrightness(base, LABEL_REGIONS.brand);
    const brandAfter = await meanBrightness(glared, LABEL_REGIONS.brand);
    expect(brandAfter).toBeGreaterThan(brandBefore);

    const warningBefore = await meanBrightness(base, LABEL_REGIONS.warning);
    const warningAfter = await meanBrightness(glared, LABEL_REGIONS.warning);
    expect(warningAfter).toBeCloseTo(warningBefore, 3);
  });

  it("rejects an unknown region name", async () => {
    const base = await makeSyntheticLabel();
    await expect(applyGlare(base, { region: "back-label" })).rejects.toThrow(RangeError);
  });

  it("rejects opacity outside (0, 1]", async () => {
    const base = await makeSyntheticLabel();
    await expect(applyGlare(base, { region: "brand", opacity: 0 })).rejects.toThrow(RangeError);
    await expect(applyGlare(base, { region: "brand", opacity: 1.5 })).rejects.toThrow(RangeError);
  });
});

describe("applyLowLight", () => {
  it("darkens the targeted region without changing an untouched region", async () => {
    const base = await makeSyntheticLabel();
    const dimmed = await applyLowLight(base, { region: "warning", brightnessFactor: 0.3 });

    const warningBefore = await meanBrightness(base, LABEL_REGIONS.warning);
    const warningAfter = await meanBrightness(dimmed, LABEL_REGIONS.warning);
    expect(warningAfter).toBeLessThan(warningBefore);

    const brandBefore = await meanBrightness(base, LABEL_REGIONS.brand);
    const brandAfter = await meanBrightness(dimmed, LABEL_REGIONS.brand);
    expect(brandAfter).toBeCloseTo(brandBefore, 3);
  });

  it("rejects brightnessFactor outside (0, 1]", async () => {
    const base = await makeSyntheticLabel();
    await expect(
      applyLowLight(base, { region: "warning", brightnessFactor: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      applyLowLight(base, { region: "warning", brightnessFactor: 1.2 }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects an unknown region name", async () => {
    const base = await makeSyntheticLabel();
    await expect(
      applyLowLight(base, { region: "nowhere", brightnessFactor: 0.3 }),
    ).rejects.toThrow(RangeError);
  });
});

describe("applyDegradation dispatcher", () => {
  it("routes every known degradation type to a working transform", async () => {
    const base = await makeSyntheticLabel();

    const rotated = await applyDegradation(base, { type: "rotate", params: { angleDegrees: 10 } });
    expect(rotated.length).toBeGreaterThan(0);

    const blurred = await applyDegradation(base, { type: "blur", params: { sigma: 5 } });
    expect(blurred.length).toBeGreaterThan(0);

    const sheared = await applyDegradation(base, { type: "perspective", params: { shear: 0.1 } });
    expect(sheared.length).toBeGreaterThan(0);

    const glared = await applyDegradation(base, {
      type: "glare",
      params: { region: "brand", angleDegrees: 25, opacity: 0.7 },
    });
    expect(glared.length).toBeGreaterThan(0);

    const dimmed = await applyDegradation(base, {
      type: "low-light",
      params: { region: "warning", brightnessFactor: 0.3 },
    });
    expect(dimmed.length).toBeGreaterThan(0);
  });

  it("throws for an unrecognized degradation type", async () => {
    const base = await makeSyntheticLabel();
    // @ts-expect-error -- intentionally invalid type for the red-first test
    await expect(applyDegradation(base, { type: "sepia", params: {} })).rejects.toThrow(RangeError);
  });
});
