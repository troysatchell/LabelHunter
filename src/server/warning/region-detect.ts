/**
 * Warning-region detection (LH-020 / TRO-468, CP-2 §8.2, §8.3).
 *
 * CP-2 §8.2 finds a real conflict: a model-reported bounding box cannot
 * exist before the Haiku call returns, which breaks PRD §3.8's "OCR runs
 * concurrently with Haiku". Open question 3's recommendation, adopted:
 *
 *   1. Classical detection (this file's `detectWarningRegionClassical`) —
 *      milliseconds, no OCR, so OCR can start immediately. PRIMARY.
 *   2. Band search (`detectWarningRegionByBandSearch`) — four fixed
 *      regions, OCR each, keep whichever contains "GOVERNMENT". FALLBACK.
 *   3. If both fail, `detectWarningRegion` returns `null` and the caller
 *      runs single-channel (`reconcile.ts`'s OCR-unavailable path) — a
 *      REVIEW-biased outcome, never a wrong one.
 *
 * Classical detection is a row-density line/paragraph clusterer: it finds
 * horizontal bands of "ink" at a downscaled resolution, groups nearby
 * bands into blocks, and picks the block with the most distinct lines —
 * the warning is the only multi-line dense-text block on a typical label
 * (measured: 3-5 lines; a brand name or net-contents line is one line).
 * This is a deliberately simple stand-in for "morphological gradient plus
 * connected components" (CP-2 §8.2's own phrase) — sharp/libvips has no
 * connected-components primitive, and a row-projection profile is the
 * cheapest thing that reaches the same answer for this specific shape of
 * input (dense small print in a roughly axis-aligned block).
 *
 * The constants below are **proposed**, tuned against this ticket's own
 * synthetic fixtures and validated against six real, varied golden-set
 * label images (case-01, 03, 08, 10, 14, 23 — every one with a warning
 * present) plus two with no warning (case-12, 13, correctly returning
 * `null`) — not against the full golden set, which is LH-030's job
 * (CP-2 §12: "any threshold as a final value... LH-030's sweep replaces
 * them with measured values").
 */
import sharp from "sharp";
import { clampRegionToBounds, type PixelRegion } from "../preprocessing/region";

/** Downscale target for the row-density analysis pass — large enough to
 * resolve individual lines of small print, small enough to run in
 * milliseconds (CP-2 §8.2's whole reason for choosing this method). */
const ANALYSIS_WIDTH_PX = 500;

/** A greyscale pixel below this value (0-255) counts as "ink". */
const DARK_PIXEL_THRESHOLD = 180;

/** A row's ink-pixel fraction must fall in this band to count as a text
 * row — below it, the row is blank; above it, it is a solid fill or
 * graphic, not print. */
const MIN_INK_FRACTION = 0.01;
const MAX_INK_FRACTION = 0.6;

/** Two ink runs (analysis-resolution rows apart) merge into the same
 * block when their gap is at most this many rows — bridges the ~7-8px
 * inter-line gap measured within a real warning paragraph, while staying
 * well under the ~40-50px gap measured between unrelated label fields. */
const MAX_LINE_GAP_PX = 15;

/** A block must span at least this many distinct line runs to be a
 * paragraph candidate — excludes a single-line brand name or net-contents
 * statement. The warning is the only field this long on a typical label. */
const MIN_LINES_FOR_CANDIDATE = 3;

/** Padding added around the winning block before cropping, in
 * analysis-resolution pixels — avoids clipping ascenders/descenders at
 * the block's own edges. */
const ROW_MARGIN_PX = 2;
const COLUMN_MARGIN_PX = 4;

export interface InkRun {
  start: number;
  end: number;
}

export interface ParagraphBlock {
  start: number;
  end: number;
  lines: number;
}

/** Groups consecutive in-band rows into runs — CP-2 §8.2's "line" unit.
 * Exported for direct, fast, exact unit testing on small numeric arrays. */
export function findInkRuns(rowInkFractions: readonly number[], minFraction: number, maxFraction: number): InkRun[] {
  const runs: InkRun[] = [];
  let start: number | null = null;
  for (let y = 0; y < rowInkFractions.length; y++) {
    const isTextRow = rowInkFractions[y] >= minFraction && rowInkFractions[y] <= maxFraction;
    if (isTextRow && start === null) start = y;
    if (!isTextRow && start !== null) {
      runs.push({ start, end: y - 1 });
      start = null;
    }
  }
  if (start !== null) runs.push({ start, end: rowInkFractions.length - 1 });
  return runs;
}

/** Merges nearby line runs into paragraph-block candidates. */
export function groupRunsIntoBlocks(runs: readonly InkRun[], maxGapPx: number): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  let current: ParagraphBlock | null = null;
  for (const run of runs) {
    if (current === null) {
      current = { start: run.start, end: run.end, lines: 1 };
    } else if (run.start - current.end <= maxGapPx) {
      current.end = run.end;
      current.lines += 1;
    } else {
      blocks.push(current);
      current = { start: run.start, end: run.end, lines: 1 };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Picks the most line-dense block meeting the minimum, tie-broken toward
 * the block closer to the bottom of the image — the government warning is
 * conventionally printed low on a label. This is a documented, unverified
 * heuristic tiebreak, not a requirement; it only matters when two blocks
 * tie on line count. */
export function pickBestParagraphBlock(blocks: readonly ParagraphBlock[], minLines: number): ParagraphBlock | null {
  const candidates = blocks.filter((block) => block.lines >= minLines);
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b.lines - a.lines || b.start - a.start)[0];
}

/**
 * Classical detection (CP-2 §8.2 option C, primary): finds the most
 * paragraph-like block of dense small text and returns its bounding box
 * in the ORIGINAL image's pixel coordinates. Returns `null` when no block
 * has at least `MIN_LINES_FOR_CANDIDATE` lines — the caller falls back to
 * `detectWarningRegionByBandSearch`.
 */
export async function detectWarningRegionClassical(image: Buffer): Promise<PixelRegion | null> {
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) return null;

  const scale = ANALYSIS_WIDTH_PX / metadata.width;
  const analysisHeight = Math.max(1, Math.round(metadata.height * scale));

  const { data, info } = await sharp(image)
    .resize(ANALYSIS_WIDTH_PX, analysisHeight, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rowInkFractions: number[] = [];
  for (let y = 0; y < info.height; y++) {
    let dark = 0;
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] < DARK_PIXEL_THRESHOLD) dark++;
    }
    rowInkFractions.push(dark / info.width);
  }

  const runs = findInkRuns(rowInkFractions, MIN_INK_FRACTION, MAX_INK_FRACTION);
  const blocks = groupRunsIntoBlocks(runs, MAX_LINE_GAP_PX);
  const winner = pickBestParagraphBlock(blocks, MIN_LINES_FOR_CANDIDATE);
  if (!winner) return null;

  const y0 = Math.max(0, winner.start - ROW_MARGIN_PX);
  const y1 = Math.min(info.height - 1, winner.end + ROW_MARGIN_PX);

  // Column-trim within the winning row range, so the crop is not the
  // full image width — narrows the box to where the ink actually is.
  let minX = info.width;
  let maxX = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] < DARK_PIXEL_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (minX > maxX) {
    minX = 0;
    maxX = info.width - 1;
  }
  const x0 = Math.max(0, minX - COLUMN_MARGIN_PX);
  const x1 = Math.min(info.width - 1, maxX + COLUMN_MARGIN_PX);

  const region: PixelRegion = {
    x: Math.round(x0 / scale),
    y: Math.round(y0 / scale),
    width: Math.round((x1 - x0 + 1) / scale),
    height: Math.round((y1 - y0 + 1) / scale),
  };
  return clampRegionToBounds(region, metadata.width, metadata.height);
}

/** CP-2 §8.2 option B's four fixed candidate bands: top, bottom, left,
 * right thirds of the full image. Deliberately simple, fixed geometry —
 * this is the fallback for when classical detection already failed, so
 * it does not need to be adaptive, only to try a few plausible places. */
function bandSearchRegions(width: number, height: number): PixelRegion[] {
  const thirdW = Math.round(width / 3);
  const thirdH = Math.round(height / 3);
  return [
    { x: 0, y: 0, width, height: thirdH }, // top
    { x: 0, y: height - thirdH, width, height: thirdH }, // bottom
    { x: 0, y: 0, width: thirdW, height }, // left
    { x: width - thirdW, y: 0, width: thirdW, height }, // right
  ];
}

/**
 * Band search (CP-2 §8.2 option B, fallback): OCRs each of the four fixed
 * bands and keeps the first whose recognized text contains "GOVERNMENT",
 * case-insensitively. `recognize` is injected so this module does not
 * hard-depend on `ocr.ts` for its own tests — the real caller
 * (`index.ts`) passes `runWarningOcr`.
 */
export async function detectWarningRegionByBandSearch(
  image: Buffer,
  recognize: (crop: Buffer) => Promise<{ text: string; confidence: number } | null>,
): Promise<PixelRegion | null> {
  const metadata = await sharp(image).metadata();
  if (!metadata.width || !metadata.height) return null;

  for (const region of bandSearchRegions(metadata.width, metadata.height)) {
    const clamped = clampRegionToBounds(region, metadata.width, metadata.height);
    const crop = await cropForOcr(image, clamped);
    const result = await recognize(crop);
    if (result && /GOVERNMENT/i.test(result.text)) {
      return clamped;
    }
  }
  return null;
}

export interface WarningRegionDetectionResult {
  region: PixelRegion;
  method: "classical" | "band-search";
}

/**
 * The full CP-2 §8.2 detection ladder: classical first (so OCR can start
 * without waiting on it), band search if classical finds nothing, `null`
 * (single-channel final fallback) if both fail.
 */
export async function detectWarningRegion(
  image: Buffer,
  recognize: (crop: Buffer) => Promise<{ text: string; confidence: number } | null>,
): Promise<WarningRegionDetectionResult | null> {
  const classical = await detectWarningRegionClassical(image);
  if (classical) return { region: classical, method: "classical" };

  const bandSearch = await detectWarningRegionByBandSearch(image, recognize);
  if (bandSearch) return { region: bandSearch, method: "band-search" };

  return null;
}

/**
 * Crops `region` out of `source` for the OCR channel — PNG output, never
 * JPEG. CP-2 §8.3 / open question 6: `../preprocessing/constants.ts`'s
 * `OUTPUT_MEDIA_TYPE = "image/jpeg"` (and `../preprocessing/pipeline.ts`'s
 * `cropRegion`, which always encodes to JPEG) exist for the Claude
 * vision-API-bound variants. Tesseract is not an API and needs no
 * re-encode; a lossy JPEG round trip would add compression artifacts to
 * exactly the small print this channel exists to read. This function is
 * this module's own crop, not a call into `cropRegion` — reuses
 * `clampRegionToBounds` (the intended shared piece, per that file's own
 * header) but not the JPEG-only encode step.
 */
export async function cropForOcr(source: Buffer, region: PixelRegion): Promise<Buffer> {
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("cropForOcr: source image has no readable dimensions");
  }
  const clamped = clampRegionToBounds(region, metadata.width, metadata.height);
  return sharp(source)
    .extract({ left: clamped.x, top: clamped.y, width: clamped.width, height: clamped.height })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}
