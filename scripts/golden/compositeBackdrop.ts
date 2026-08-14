/**
 * Warps the renderer's exact-text label into a backdrop photo's detected
 * blank region and composites it there (design doc §5,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md).
 * `build.ts` calls this on every rebuild, using a case's committed
 * `labelPlacement` quad — no network, no re-detection, matching the
 * existing `rendered`/`rendered+degraded` determinism contract even though
 * the backdrop photo itself was generated once and is not reproducible.
 */
import sharp from "sharp";
import type { Point, Quad } from "./blankRegionDetector";

interface Matrix2x2 {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

function edgeLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Target size for the pre-resize below: the quad's top-edge length
 * (topLeft to topRight) and left-edge length (topLeft to bottomLeft),
 * rounded to whole pixels. `quad.bottomRight` is not used, the same
 * omission `solveLinearMap` documents below. A quad's edges are not
 * always the same length (a real detected quad can be a trapezoid), so
 * this is an approximation of the destination extent, not an exact
 * width and height. Clamped to a 1-pixel minimum so a degenerate
 * (zero-area) quad still reaches `invert`'s own check below instead of
 * failing inside `sharp.resize` first.
 */
export function computePreResizeTarget(quad: Quad): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(edgeLength(quad.topLeft, quad.topRight))),
    height: Math.max(1, Math.round(edgeLength(quad.topLeft, quad.bottomLeft))),
  };
}

/**
 * Downsamples (or upsamples) `labelImage` to approximately the
 * destination quad's own extent, ahead of the nearest-neighbor warp in
 * `compositeLabelOntoBackdrop` below.
 *
 * WHY. The renderer's label canvas is a fixed 1000x800
 * (`render.ts`'s `CANVAS_WIDTH`/`CANVAS_HEIGHT`). A typical detected
 * quad is much smaller and a different shape — for example roughly
 * 300x500. Sampling that directly with nearest-neighbor, one destination
 * pixel at a time, is a point-sample downsample: it skips most of the
 * source pixels and can lose or duplicate fine detail (a thin warning-text
 * stroke) unpredictably. Lanczos3 here does the antialiasing a proper
 * downsample needs; the nearest-neighbor step afterward only has to
 * sample a source already close to 1:1 with its destination.
 *
 * ASPECT-RATIO DECISION: resize non-uniformly (`fit: "fill"`) to the
 * quad's own edge lengths. Do not letterbox to the label's original
 * aspect ratio first. The warp that follows is already a general affine
 * map driven entirely by the quad's geometry — it stretches the label to
 * fit whatever shape the quad is, independent of any pre-resize choice.
 * Letterboxing first would only add blank padding bars inside the label
 * image; that same affine warp would then stretch those bars into the
 * composited photo as visible padding. Matching the pre-resize to the
 * warp's own eventual stretch fixes the sampling problem without adding a
 * second, new distortion.
 */
async function preResizeLabelToQuad(labelImage: Buffer, quad: Quad): Promise<Buffer> {
  const { width, height } = computePreResizeTarget(quad);
  return sharp(labelImage).resize(width, height, { fit: "fill", kernel: "lanczos3" }).toBuffer();
}

/**
 * Solves the 2x2 linear map that carries a label image's (0,0)/(W,0)/(0,H)
 * corners onto `quad`'s topLeft/topRight/bottomLeft corners (relative to
 * topLeft, the map's implicit origin). 3 point correspondences exactly
 * determine an affine transform's remaining 4 degrees of freedom — no
 * least-squares fit needed. `quad.bottomRight` is unused: this repo has no
 * true 4-point projective (homography) warp dependency, the same
 * limitation `degrade.ts`'s `applyPerspective` already documents for its
 * own shear approximation. When the detected quad is a true trapezoid
 * (real camera perspective foreshortening) rather than a parallelogram,
 * this warp will not exactly reach the detected bottomRight corner — an
 * accepted approximation (design doc §11, "not a true ... projection").
 */
function solveLinearMap(labelWidth: number, labelHeight: number, quad: Quad): Matrix2x2 {
  const { topLeft, topRight, bottomLeft } = quad;
  return {
    a: (topRight.x - topLeft.x) / labelWidth,
    c: (topRight.y - topLeft.y) / labelWidth,
    b: (bottomLeft.x - topLeft.x) / labelHeight,
    d: (bottomLeft.y - topLeft.y) / labelHeight,
  };
}

function invert(m: Matrix2x2): Matrix2x2 {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-9) {
    throw new RangeError("compositeLabelOntoBackdrop: detected quad is degenerate (zero area)");
  }
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det };
}

/**
 * Perspective-warps `labelImage` into `quad`'s position on `backdropImage`
 * by direct inverse-mapped pixel sampling: for every destination pixel in
 * the quad's bounding box, compute where it came from in the label image
 * (via the inverse linear map) and copy that pixel — nearest-neighbor, no
 * interpolation. This avoids `sharp`'s `.affine()`, which auto-expands its
 * output canvas and reports no offset back to the caller, making exact
 * placement on the backdrop unreliable to reason about without empirical
 * testing this plan cannot do ahead of running it.
 *
 * `labelImage` is pre-resized (`preResizeLabelToQuad`, above) before this
 * nearest-neighbor step runs — see that function's own comment for why and
 * for the aspect-ratio decision.
 */
export async function compositeLabelOntoBackdrop(
  backdropImage: Buffer,
  labelImage: Buffer,
  quad: Quad,
): Promise<Buffer> {
  const resizedLabel = await preResizeLabelToQuad(labelImage, quad);
  const labelRaw = await sharp(resizedLabel).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const backdropRaw = await sharp(backdropImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const labelWidth = labelRaw.info.width;
  const labelHeight = labelRaw.info.height;
  const bgWidth = backdropRaw.info.width;
  const bgHeight = backdropRaw.info.height;
  const channels = backdropRaw.info.channels;

  const linear = solveLinearMap(labelWidth, labelHeight, quad);
  const inverse = invert(linear);

  // The warp above uses only topLeft/topRight/bottomLeft (see
  // solveLinearMap's docstring). Its own implied 4th corner is
  // topRight + bottomLeft - topLeft, not the detected quad.bottomRight. On
  // a true trapezoid quad, those two points differ. A bounding box built
  // from the four detected corners can then be smaller than the
  // parallelogram the warp actually draws. Pixels in that gap never get
  // drawn (TRO-509). Use the implied corner instead. The box then always
  // covers everything the loop below can draw.
  const impliedBottomRight = {
    x: quad.topRight.x + quad.bottomLeft.x - quad.topLeft.x,
    y: quad.topRight.y + quad.bottomLeft.y - quad.topLeft.y,
  };
  const xs = [quad.topLeft.x, quad.topRight.x, quad.bottomLeft.x, impliedBottomRight.x];
  const ys = [quad.topLeft.y, quad.topRight.y, quad.bottomLeft.y, impliedBottomRight.y];
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(bgWidth - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(bgHeight - 1, Math.ceil(Math.max(...ys)));

  const output = Buffer.from(backdropRaw.data);

  for (let dy = minY; dy <= maxY; dy++) {
    for (let dx = minX; dx <= maxX; dx++) {
      const rx = dx - quad.topLeft.x;
      const ry = dy - quad.topLeft.y;
      const sx = Math.round(inverse.a * rx + inverse.b * ry);
      const sy = Math.round(inverse.c * rx + inverse.d * ry);
      if (sx < 0 || sx >= labelWidth || sy < 0 || sy >= labelHeight) continue;

      const srcOffset = (sy * labelWidth + sx) * labelRaw.info.channels;
      const dstOffset = (dy * bgWidth + dx) * channels;
      output[dstOffset] = labelRaw.data[srcOffset];
      output[dstOffset + 1] = labelRaw.data[srcOffset + 1];
      output[dstOffset + 2] = labelRaw.data[srcOffset + 2];
      output[dstOffset + 3] = 255;
    }
  }

  return sharp(output, { raw: { width: bgWidth, height: bgHeight, channels } })
    .png()
    .toBuffer();
}
