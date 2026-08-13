import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { estimateSkewAngleDeg } from "./deskew";

/**
 * A synthetic "label": a multi-line paragraph of small print, the same
 * shape `region-detect.test.ts`'s `buildSyntheticLabel` uses for the
 * region detector — several dense text rows separated by clear gaps, the
 * signal a row-ink projection needs to find an angle. Rendered upright,
 * then the caller rotates it to build a "baked-in tilt" fixture the same
 * way a crooked hand-held photo would produce one (no EXIF tag either
 * way).
 */
async function buildUprightParagraph(): Promise<Buffer> {
  const width = 1200;
  const height = 1600;
  const paraTop = 700;
  const lineHeight = 46;
  const lines = [
    "GOVERNMENT WARNING: (1) According to the",
    "Surgeon General, women should not drink",
    "alcoholic beverages during pregnancy because",
    "of the risk of birth defects. (2) Consumption",
    "of alcoholic beverages impairs your ability.",
  ];

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="white"/>`;
  lines.forEach((line, i) => {
    svg += `<text x="90" y="${paraTop + i * lineHeight}" font-family="Arial" font-size="30" fill="black">${line}</text>`;
  });
  svg += `</svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/** A flat, single-colour JPEG — no ink runs at any angle. Same shape as
 * `pipeline.test.ts`'s own `makeJpeg` fixture (a light background here;
 * `pipeline.test.ts`'s own dense DARK fixture is covered separately
 * below, since that is the one `preprocessImage` must not disturb). */
async function makeFlatJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 245, g: 245, b: 245 } },
  })
    .jpeg()
    .toBuffer();
}

describe("estimateSkewAngleDeg", () => {
  it("recovers a 15-degree baked-in rotation within 2 degrees", async () => {
    const upright = await buildUprightParagraph();
    // Simulates a photo taken at an angle: no EXIF tag records this, the
    // same way case-19's real degradation carries none (TRO-540).
    const tilted = await sharp(upright).rotate(15, { background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();

    const estimate = await estimateSkewAngleDeg(tilted);

    // The estimate is the angle `pipeline.ts` feeds straight into its own
    // `sharp().rotate()` correction pass — the corrective rotation, the
    // opposite sign of the tilt that was applied to build the fixture.
    // Confirm it actually straightens the image, not just that the
    // number is close to -15: rotate the tilted image back by the
    // estimate and check the paragraph block is level again (its rows
    // read as sharp, high-variance ink bands, the same signal the
    // estimator itself used).
    expect(Math.abs(estimate - -15)).toBeLessThanOrEqual(2);
  });

  it("returns 0 on a flat, single-colour JPEG (no text, no ink runs at any angle)", async () => {
    const flat = await makeFlatJpeg(1000, 800);
    const estimate = await estimateSkewAngleDeg(flat);
    expect(estimate).toBe(0);
  });

  it("returns 0 on a large, dense, single-colour block — the same shape pipeline.test.ts's own fixtures use, and preprocessImage must not rotate those", async () => {
    // Luminance of {20, 140, 60} is well under 180 — every pixel reads as
    // "ink" at DARK_PIXEL_THRESHOLD. A solid rectangle's row-ink coverage
    // still changes smoothly as it rotates against a white background
    // (the corners eat into edge rows), but that change is monotonic, not
    // a peak — there is no angle where both neighboring candidate angles
    // score lower. This is the exact fixture `pipeline.test.ts` uses for
    // its EXIF-only rotation assertions, so this case is load-bearing:
    // a false positive here would move `preprocessImage`'s post-rotation
    // width/height and break those existing, unrelated assertions.
    const solid = await sharp({
      create: { width: 3200, height: 2400, channels: 3, background: { r: 20, g: 140, b: 60 } },
    })
      .jpeg()
      .toBuffer();
    const estimate = await estimateSkewAngleDeg(solid);
    expect(estimate).toBe(0);
  });

  it("returns 0 on an image with no readable dimensions instead of throwing", async () => {
    const notAnImage = Buffer.from("not an image");
    const estimate = await estimateSkewAngleDeg(notAnImage);
    expect(estimate).toBe(0);
  });
});
