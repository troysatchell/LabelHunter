import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compositeLabelOntoBackdrop, computePreResizeTarget } from "./compositeBackdrop";
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

async function makeSolidLabel(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="rgb(${color.r},${color.g},${color.b})" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function pixelAt(image: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
}

/** Decodes once so a full-area scan does not re-decode the PNG per pixel. */
async function loadRaster(
  image: Buffer,
): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function sampleRaster(
  raster: { data: Buffer; width: number; channels: number },
  x: number,
  y: number,
): { r: number; g: number; b: number } {
  const offset = (y * raster.width + x) * raster.channels;
  return { r: raster.data[offset], g: raster.data[offset + 1], b: raster.data[offset + 2] };
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

describe("compositeLabelOntoBackdrop — genuine trapezoid quad (TRO-509)", () => {
  // A real foreshortened bottle-label photo detects as a genuine trapezoid,
  // not a parallelogram: bottomRight does not equal topRight + bottomLeft -
  // topLeft. These four corners are the ticket's own measured reproduction.
  const TRAPEZOID_QUAD: DetectedQuad = {
    topLeft: { x: 100, y: 100 },
    topRight: { x: 400, y: 120 },
    bottomLeft: { x: 130, y: 500 },
    bottomRight: { x: 370, y: 470 },
    pixelCount: 119400,
    imageWidth: 800,
    imageHeight: 600,
  };
  const LABEL_WIDTH = 300;
  const LABEL_HEIGHT = 400;
  const LABEL_COLOR = { r: 0, g: 180, b: 90 };

  // The warp (solveLinearMap in compositeBackdrop.ts) is a 3-point affine map
  // using only topLeft/topRight/bottomLeft. The parallelogram it actually
  // draws reaches a 4th corner the map implies, not the detected
  // bottomRight: topRight + bottomLeft - topLeft.
  const IMPLIED_BOTTOM_RIGHT = {
    x: TRAPEZOID_QUAD.topRight.x + TRAPEZOID_QUAD.bottomLeft.x - TRAPEZOID_QUAD.topLeft.x,
    y: TRAPEZOID_QUAD.topRight.y + TRAPEZOID_QUAD.bottomLeft.y - TRAPEZOID_QUAD.topLeft.y,
  };

  /**
   * Independent membership test for "is (x,y) inside the parallelogram the
   * affine warp draws" — expressed directly from the quad's two edge
   * vectors (topRight-topLeft, bottomLeft-topLeft), not by calling anything
   * from compositeBackdrop.ts. s and t are (x,y)'s coordinates in that edge
   * basis; the point sits inside the parallelogram iff both are in [0,1].
   * This lets the tests below check the *drawn output* against the
   * *geometric definition* of the parallelogram as two independent facts,
   * instead of the test re-deriving its expectation from the same bounding
   * box code under test.
   */
  function parallelogramCoords(x: number, y: number): { s: number; t: number } {
    const { topLeft, topRight, bottomLeft } = TRAPEZOID_QUAD;
    const e1 = { x: topRight.x - topLeft.x, y: topRight.y - topLeft.y };
    const e2 = { x: bottomLeft.x - topLeft.x, y: bottomLeft.y - topLeft.y };
    const det = e1.x * e2.y - e1.y * e2.x;
    const px = x - topLeft.x;
    const py = y - topLeft.y;
    const s = (px * e2.y - py * e2.x) / det;
    const t = (e1.x * py - e1.y * px) / det;
    return { s, t };
  }

  it("draws the destination pixel the affine parallelogram reaches beyond the detected bottomRight's bounding box", async () => {
    const backdrop = await makeBackdrop(800, 600);
    const label = await makeSolidLabel(LABEL_WIDTH, LABEL_HEIGHT, LABEL_COLOR);

    const result = await compositeLabelOntoBackdrop(backdrop, label, TRAPEZOID_QUAD);

    // (420, 510) sits inside the affine-drawn parallelogram (s=0.969,
    // t=0.977 — both in [0,1], measured) and inside the corrected bounding
    // box (derived from IMPLIED_BOTTOM_RIGHT: maxX=430, maxY=520), but
    // OUTSIDE the bounding box the detected corners produce (maxX=400 from
    // topRight.x, maxY=500 from bottomLeft.y — bottomRight.x=370/y=470 pull
    // it in even further). Before TRO-509 this destination pixel is never
    // iterated and stays raw backdrop; the fix must draw label content
    // there.
    const gapPixel = await pixelAt(result, 420, 510);
    expect(gapPixel.g).toBeGreaterThan(150);
    expect(gapPixel.r).toBeLessThan(50);
  });

  it("leaves no gap: every interior point of the affine-drawn parallelogram holds label content, not raw backdrop", async () => {
    const backdrop = await makeBackdrop(800, 600);
    const label = await makeSolidLabel(LABEL_WIDTH, LABEL_HEIGHT, LABEL_COLOR);

    const result = await compositeLabelOntoBackdrop(backdrop, label, TRAPEZOID_QUAD);
    const raster = await loadRaster(result);

    // Stay inset from the exact geometric edge — nearest-neighbor rounding
    // at a sub-pixel boundary is expected and is not the defect under test.
    // The defect is a large swath of clearly-interior pixels never drawn.
    const MARGIN = 0.02;
    const minX = Math.floor(TRAPEZOID_QUAD.topLeft.x);
    const maxX = Math.ceil(IMPLIED_BOTTOM_RIGHT.x);
    const minY = Math.floor(TRAPEZOID_QUAD.topLeft.y);
    const maxY = Math.ceil(IMPLIED_BOTTOM_RIGHT.y);

    let scanned = 0;
    const missed: Array<{ x: number; y: number }> = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const { s, t } = parallelogramCoords(x, y);
        if (s < MARGIN || s > 1 - MARGIN || t < MARGIN || t > 1 - MARGIN) continue;
        scanned++;
        const pixel = sampleRaster(raster, x, y);
        const looksLikeBackdrop =
          Math.abs(pixel.r - BACKDROP_COLOR.r) < 5 &&
          Math.abs(pixel.g - BACKDROP_COLOR.g) < 5 &&
          Math.abs(pixel.b - BACKDROP_COLOR.b) < 5;
        if (looksLikeBackdrop) missed.push({ x, y });
      }
    }

    // Guards the scan itself: measured at 110041 interior points for this
    // quad and MARGIN. A much smaller number would mean the scan is not
    // actually covering the parallelogram's interior, and the "missed"
    // check below would pass vacuously.
    expect(scanned).toBeGreaterThan(100000);
    expect(missed).toEqual([]);
  });
});

describe("computePreResizeTarget", () => {
  it("returns the quad's top-edge and left-edge lengths, rounded", () => {
    const quad: DetectedQuad = {
      topLeft: { x: 300, y: 200 },
      topRight: { x: 600, y: 200 },
      bottomLeft: { x: 300, y: 700 },
      bottomRight: { x: 600, y: 700 },
      pixelCount: 1,
      imageWidth: 1000,
      imageHeight: 1000,
    };
    expect(computePreResizeTarget(quad)).toEqual({ width: 300, height: 500 });
  });

  it("clamps a degenerate (zero-length) edge to a 1-pixel minimum", () => {
    const quad: DetectedQuad = {
      topLeft: { x: 100, y: 100 },
      topRight: { x: 100, y: 100 },
      bottomLeft: { x: 100, y: 100 },
      bottomRight: { x: 100, y: 100 },
      pixelCount: 0,
      imageWidth: 400,
      imageHeight: 300,
    };
    expect(computePreResizeTarget(quad)).toEqual({ width: 1, height: 1 });
  });
});

describe("compositeLabelOntoBackdrop — nearest-neighbor aliasing on minification (TRO-510)", () => {
  /** 1px-wide vertical black/white stripes across the full label width — the highest spatial frequency a raster can carry. */
  async function makeStripedLabel(width: number, height: number): Promise<Buffer> {
    const rects: string[] = [];
    for (let x = 0; x < width; x++) {
      const color = x % 2 === 0 ? "255,255,255" : "0,0,0";
      rects.push(`<rect x="${x}" y="0" width="1" height="${height}" fill="rgb(${color})" />`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects.join("")}</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  it("blends fine label detail to mid-gray under 10x minification instead of aliasing to one solid color", async () => {
    // The renderer's canvas (1000x800, render.ts) is always much larger
    // than a detected label region — real cases minify by roughly 2-3x per
    // axis. This fixture uses a 10x minification on a worst-case
    // alternating pattern to make the aliasing failure unambiguous: with a
    // stride that is an exact multiple of the 2px stripe period, plain
    // nearest-neighbor sampling picks the SAME color every time, not a
    // representative mix. A correct downsample averages many stripes per
    // destination pixel and lands near mid-gray (measured: 128).
    const backdrop = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();
    const label = await makeStripedLabel(200, 100);
    const quad: DetectedQuad = {
      topLeft: { x: 100, y: 100 },
      topRight: { x: 120, y: 100 },
      bottomLeft: { x: 100, y: 120 },
      bottomRight: { x: 120, y: 120 },
      pixelCount: 400,
      imageWidth: 300,
      imageHeight: 300,
    };

    const result = await compositeLabelOntoBackdrop(backdrop, label, quad);

    for (const dx of [102, 105, 108, 110, 112, 115, 118]) {
      const pixel = await pixelAt(result, dx, 110);
      // Measured after the fix: 128-129 at every sampled column. Before
      // the fix, every one of these columns reads pure white (255) --
      // nearest-neighbor's stride (10px) is an exact multiple of the 2px
      // stripe period, so it always lands on the same stripe color.
      expect(pixel.r, `x=${dx}`).toBeGreaterThan(90);
      expect(pixel.r, `x=${dx}`).toBeLessThan(165);
      expect(pixel.g, `x=${dx}`).toBe(pixel.r);
      expect(pixel.b, `x=${dx}`).toBe(pixel.r);
    }
  });
});
