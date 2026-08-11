import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compositeLabelOntoBackdrop } from "./compositeBackdrop";
import type { DetectedQuad } from "./blankRegionDetector";

const BACKDROP_COLOR = { r: 10, g: 10, b: 10 };

async function makeBackdrop(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: BACKDROP_COLOR } })
    .png()
    .toBuffer();
}

async function makeTwoToneLabel(width: number, height: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect x="0" y="0" width="${width}" height="${height / 2}" fill="rgb(200,0,0)" />
    <rect x="0" y="${height / 2}" width="${width}" height="${height / 2}" fill="rgb(0,0,200)" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function pixelAt(image: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
}

describe("compositeLabelOntoBackdrop", () => {
  it("places the label's top half at the quad's top and bottom half at the quad's bottom, axis-aligned", async () => {
    const backdrop = await makeBackdrop(800, 600);
    const label = await makeTwoToneLabel(200, 100);
    const quad: DetectedQuad = {
      topLeft: { x: 300, y: 200 },
      topRight: { x: 500, y: 200 },
      bottomLeft: { x: 300, y: 300 },
      bottomRight: { x: 500, y: 300 },
      pixelCount: 20000,
      imageWidth: 800,
      imageHeight: 600,
    };

    const result = await compositeLabelOntoBackdrop(backdrop, label, quad);

    const topOfQuad = await pixelAt(result, 400, 220);
    expect(topOfQuad.r).toBeGreaterThan(150);
    expect(topOfQuad.b).toBeLessThan(50);

    const bottomOfQuad = await pixelAt(result, 400, 280);
    expect(bottomOfQuad.b).toBeGreaterThan(150);
    expect(bottomOfQuad.r).toBeLessThan(50);

    const outsideQuad = await pixelAt(result, 50, 50);
    expect(outsideQuad.r).toBe(BACKDROP_COLOR.r);
    expect(outsideQuad.g).toBe(BACKDROP_COLOR.g);
    expect(outsideQuad.b).toBe(BACKDROP_COLOR.b);
  });

  it("throws on a degenerate (zero-area) quad", async () => {
    const backdrop = await makeBackdrop(400, 300);
    const label = await makeTwoToneLabel(100, 100);
    const quad: DetectedQuad = {
      topLeft: { x: 100, y: 100 },
      topRight: { x: 100, y: 100 },
      bottomLeft: { x: 100, y: 100 },
      bottomRight: { x: 100, y: 100 },
      pixelCount: 0,
      imageWidth: 400,
      imageHeight: 300,
    };
    await expect(compositeLabelOntoBackdrop(backdrop, label, quad)).rejects.toThrow(RangeError);
  });
});
