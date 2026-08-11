import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { detectBlankRegionQuad } from "./blankRegionDetector";

const TARGET_COLOR = { r: 240, g: 233, b: 220 };
const BACKGROUND_COLOR = { r: 40, g: 60, b: 90 };

async function makeFixture(
  rectX: number,
  rectY: number,
  rectW: number,
  rectH: number,
  imgW = 800,
  imgH = 600,
): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}">
    <rect width="${imgW}" height="${imgH}" fill="rgb(${BACKGROUND_COLOR.r},${BACKGROUND_COLOR.g},${BACKGROUND_COLOR.b})" />
    ${rectW > 0 && rectH > 0 ? `<rect x="${rectX}" y="${rectY}" width="${rectW}" height="${rectH}" fill="rgb(${TARGET_COLOR.r},${TARGET_COLOR.g},${TARGET_COLOR.b})" />` : ""}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("detectBlankRegionQuad", () => {
  it("finds the corners of a known axis-aligned rectangle", async () => {
    const fixture = await makeFixture(200, 150, 400, 300);
    const quad = await detectBlankRegionQuad(fixture, TARGET_COLOR, 10);
    expect(quad).not.toBeNull();
    const q = quad!;
    const TOLERANCE_PX = 15; // absorbs downsample/rescale rounding
    expect(Math.abs(q.topLeft.x - 200)).toBeLessThanOrEqual(TOLERANCE_PX);
    expect(Math.abs(q.topLeft.y - 150)).toBeLessThanOrEqual(TOLERANCE_PX);
    expect(Math.abs(q.bottomRight.x - 600)).toBeLessThanOrEqual(TOLERANCE_PX);
    expect(Math.abs(q.bottomRight.y - 450)).toBeLessThanOrEqual(TOLERANCE_PX);
  });

  it("returns null when no pixel matches the target color", async () => {
    const fixture = await makeFixture(0, 0, 0, 0);
    const quad = await detectBlankRegionQuad(fixture, TARGET_COLOR, 10);
    expect(quad).toBeNull();
  });

  it("returns null when the matching region is too small to be the label", async () => {
    const fixture = await makeFixture(400, 300, 4, 4);
    const quad = await detectBlankRegionQuad(fixture, TARGET_COLOR, 10);
    expect(quad).toBeNull();
  });

  it("ignores a small unrelated patch of a similar color and still finds the large region", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
      <rect width="800" height="600" fill="rgb(${BACKGROUND_COLOR.r},${BACKGROUND_COLOR.g},${BACKGROUND_COLOR.b})" />
      <rect x="10" y="10" width="6" height="6" fill="rgb(${TARGET_COLOR.r},${TARGET_COLOR.g},${TARGET_COLOR.b})" />
      <rect x="200" y="150" width="400" height="300" fill="rgb(${TARGET_COLOR.r},${TARGET_COLOR.g},${TARGET_COLOR.b})" />
    </svg>`;
    const fixture = await sharp(Buffer.from(svg)).png().toBuffer();
    const quad = await detectBlankRegionQuad(fixture, TARGET_COLOR, 10);
    expect(quad).not.toBeNull();
    expect(Math.abs(quad!.topLeft.x - 200)).toBeLessThanOrEqual(15);
  });
});
