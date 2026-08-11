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

async function makeFourQuadrantLabel(width: number, height: number): Promise<Buffer> {
  const halfW = width / 2;
  const halfH = height / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect x="0" y="0" width="${halfW}" height="${halfH}" fill="rgb(200,0,0)" />
    <rect x="${halfW}" y="0" width="${halfW}" height="${halfH}" fill="rgb(0,200,0)" />
    <rect x="0" y="${halfH}" width="${halfW}" height="${halfH}" fill="rgb(0,0,200)" />
    <rect x="${halfW}" y="${halfH}" width="${halfW}" height="${halfH}" fill="rgb(200,200,0)" />
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

  it("correctly warps all four matrix coefficients on a sheared quad with four-quadrant label", async () => {
    const backdrop = await makeBackdrop(800, 600);
    const label = await makeFourQuadrantLabel(200, 100);

    // Sheared quad: exercises all four matrix terms (a, b, c, d)
    // topLeft=(300,200), topRight=(500,240), bottomLeft=(340,320), bottomRight=(540,360)
    // Matrix: a=1.0, c=0.2, b=0.4, d=1.2
    const quad: DetectedQuad = {
      topLeft: { x: 300, y: 200 },
      topRight: { x: 500, y: 240 },
      bottomLeft: { x: 340, y: 320 },
      bottomRight: { x: 540, y: 360 },
      pixelCount: 20000,
      imageWidth: 800,
      imageHeight: 600,
    };

    const result = await compositeLabelOntoBackdrop(backdrop, label, quad);

    // Four quadrant centers in label space map to these destination coordinates:
    // top-left red (50,25) -> (360,240)
    // top-right green (150,25) -> (460,260)
    // bottom-left blue (50,75) -> (380,300)
    // bottom-right yellow (150,75) -> (480,320)

    // Sample at computed destination + small offset to avoid boundaries
    const topLeftSample = await pixelAt(result, 361, 241);
    expect(topLeftSample.r).toBeGreaterThan(150); // red channel dominant
    expect(topLeftSample.g).toBeLessThan(100);
    expect(topLeftSample.b).toBeLessThan(100);

    const topRightSample = await pixelAt(result, 461, 261);
    expect(topRightSample.g).toBeGreaterThan(150); // green channel dominant
    expect(topRightSample.r).toBeLessThan(100);
    expect(topRightSample.b).toBeLessThan(100);

    const bottomLeftSample = await pixelAt(result, 381, 301);
    expect(bottomLeftSample.b).toBeGreaterThan(150); // blue channel dominant
    expect(bottomLeftSample.r).toBeLessThan(100);
    expect(bottomLeftSample.g).toBeLessThan(100);

    const bottomRightSample = await pixelAt(result, 481, 321);
    expect(bottomRightSample.r).toBeGreaterThan(150); // yellow: red + green
    expect(bottomRightSample.g).toBeGreaterThan(150);
    expect(bottomRightSample.b).toBeLessThan(100);

    // Verify exterior is unchanged backdrop
    const outsideQuad = await pixelAt(result, 50, 50);
    expect(outsideQuad.r).toBe(BACKDROP_COLOR.r);
    expect(outsideQuad.g).toBe(BACKDROP_COLOR.g);
    expect(outsideQuad.b).toBe(BACKDROP_COLOR.b);
  });
});
