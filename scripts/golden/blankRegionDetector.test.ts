import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { DETECTION_WIDTH, detectBlankRegionQuad } from "./blankRegionDetector";

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

  it("returns null when the matching region is too large (blown highlight/loose tolerance)", async () => {
    const fixture = await makeFixture(2, 2, 796, 596);
    const quad = await detectBlankRegionQuad(fixture, TARGET_COLOR, 10);
    expect(quad).toBeNull();
  });

  it("rescales the y coordinate with an independent vertical factor when the detection height rounds to a non-integer", async () => {
    // originalHeight * DETECTION_WIDTH / originalWidth = 605 * 240 / 2401 =
    // 60.4748..., not an integer: sharp resizes to Math.round(...) = 60. The
    // bug this covers reused the horizontal rescale factor
    // (originalWidth / DETECTION_WIDTH) for the vertical axis too, which is
    // only correct when this rounding is a no-op.
    const originalWidth = 2401;
    const originalHeight = 605;
    const exactDetectionHeight = (originalHeight * DETECTION_WIDTH) / originalWidth;
    expect(Number.isInteger(exactDetectionHeight)).toBe(false);
    const detectionHeight = Math.max(1, Math.round(exactDetectionHeight));

    // A "[" bracket — a full-width band at the top, a full-width band at
    // the bottom, and a full-height strip on the left, all one connected
    // component — instead of a free-floating rectangle. Its bounding
    // corners touch the image's own edges, so the flood fill's detected
    // extremes are exact: the bottom band spans the full width, so
    // "bottomRight" is necessarily the detection image's own last pixel
    // (width - 1, detectionHeight - 1), not an estimate subject to resize
    // antialiasing blur the way a free-floating rectangle's edge is.
    const band = 36;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${originalWidth}" height="${originalHeight}">
      <rect width="${originalWidth}" height="${originalHeight}" fill="rgb(${BACKGROUND_COLOR.r},${BACKGROUND_COLOR.g},${BACKGROUND_COLOR.b})" />
      <rect x="0" y="0" width="${originalWidth}" height="${band}" fill="rgb(${TARGET_COLOR.r},${TARGET_COLOR.g},${TARGET_COLOR.b})" />
      <rect x="0" y="${originalHeight - band}" width="${originalWidth}" height="${band}" fill="rgb(${TARGET_COLOR.r},${TARGET_COLOR.g},${TARGET_COLOR.b})" />
      <rect x="0" y="0" width="${band}" height="${originalHeight}" fill="rgb(${TARGET_COLOR.r},${TARGET_COLOR.g},${TARGET_COLOR.b})" />
    </svg>`;
    const fixture = await sharp(Buffer.from(svg)).png().toBuffer();

    const quad = await detectBlankRegionQuad(fixture, TARGET_COLOR, 10);
    expect(quad).not.toBeNull();

    // The correct inverse of a `fit: "fill"` resize is independent per
    // axis: y_original = y_detected * originalHeight / detectionHeight. The
    // old code used originalWidth / DETECTION_WIDTH (≈10.0042) for this
    // axis instead of originalHeight / detectionHeight (≈10.0833) — for
    // y_detected = detectionHeight - 1 = 59, that is 590 vs the correct 595,
    // a 5px miss the generic corner tests' 15px tolerance would absorb
    // without ever noticing.
    const expectedY = Math.round(((detectionHeight - 1) * originalHeight) / detectionHeight);
    expect(quad!.bottomRight.y).toBe(expectedY);
  });
});
