/**
 * Tests for `image.ts` (LH-041 / TRO-474, CP-3 §2.3/§8).
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { resizeStoredOriginalToHaikuVariant, resizeStoredOriginalToSonnetVariant } from "./image";

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 140, b: 60 } } })
    .jpeg()
    .toBuffer();
}

describe("resizeStoredOriginalToHaikuVariant", () => {
  it("resizes to at most the Haiku long-edge cap (1568px), and reports the actual dims it produced", async () => {
    const original = await makeJpeg(3200, 2400);
    const variant = await resizeStoredOriginalToHaikuVariant(original, 3200, 2400);
    const meta = await sharp(variant.buffer).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1568);
    expect(meta.format).toBe("jpeg");
    expect(variant.dims).toEqual({ width: meta.width, height: meta.height });
  });

  it("never enlarges an image already under the cap", async () => {
    const original = await makeJpeg(800, 600);
    const variant = await resizeStoredOriginalToHaikuVariant(original, 800, 600);
    const meta = await sharp(variant.buffer).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
    expect(variant.dims).toEqual({ width: 800, height: 600 });
  });
});

describe("resizeStoredOriginalToSonnetVariant", () => {
  it("resizes to at most the Sonnet long-edge cap (2576px), and reports the actual dims it produced", async () => {
    const original = await makeJpeg(3200, 2400);
    const variant = await resizeStoredOriginalToSonnetVariant(original, 3200, 2400);
    const meta = await sharp(variant.buffer).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(2576);
    expect(meta.format).toBe("jpeg");
    expect(variant.dims).toEqual({ width: meta.width, height: meta.height });
  });

  it("produces a strictly larger (or equal) long edge than the Haiku variant for the same source", async () => {
    const original = await makeJpeg(4000, 3000);
    const haiku = await resizeStoredOriginalToHaikuVariant(original, 4000, 3000);
    const sonnet = await resizeStoredOriginalToSonnetVariant(original, 4000, 3000);
    const haikuMeta = await sharp(haiku.buffer).metadata();
    const sonnetMeta = await sharp(sonnet.buffer).metadata();
    expect(sonnetMeta.width ?? 0).toBeGreaterThan(haikuMeta.width ?? 0);
    expect(sonnet.dims.width).toBeGreaterThan(haiku.dims.width);
  });
});
