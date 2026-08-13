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
 * The constants below started **proposed** (LH-020), tuned against that
 * ticket's own synthetic fixtures and six real golden-set images.
 * `DARK_RATIO`, `BACKGROUND_PERCENTILE`, `ROW_MARGIN_PX`, and
 * `COLUMN_MARGIN_PX` are now measured values (TRO-546): swept and checked
 * against the full 32-case golden set via `pnpm eval:ocr-floor-sweep`, not
 * just a sample — see each constant's own comment for the specific sweep.
 */
import sharp from "sharp";
import { clampRegionToBounds, type PixelRegion } from "../preprocessing/region";

/** Downscale target for the row-density analysis pass — large enough to
 * resolve individual lines of small print, small enough to run in
 * milliseconds (CP-2 §8.2's whole reason for choosing this method). */
const ANALYSIS_WIDTH_PX = 500;

/**
 * A pixel counts as "ink" when it is darker than `DARK_RATIO` times its OWN
 * row's `BACKGROUND_PERCENTILE`-th grey value — not darker than one fixed
 * absolute value (TRO-546; CP-2 §4.5's "OCR unavailable" split, §8.2).
 *
 * The original rule ("below 180 on a 0-255 scale") assumes the row's
 * background sits near white. On a well-lit label that is true, so
 * `DARK_RATIO * 255 ≈ 180` reproduces the original constant exactly and
 * every currently-passing golden-set case keeps its measured behavior
 * (verified: `pnpm eval:ocr-floor-sweep`, no regression across the other
 * 31 golden-set cases). It stops being true the moment a real photo's
 * ambient light is uneven: golden-set case-22 darkens ONLY the warning
 * block (`brightnessFactor: 0.3`), so the block's own background lands at
 * roughly grey 76, not 255 — comfortably under the fixed 180 cutoff. Every
 * pixel in that block, ink or paper, then reads as "dark", so the
 * row-density scan sees ~88% ink coverage (measured), exceeds
 * `MAX_INK_FRACTION`, and the classifier discards the whole block as "a
 * solid fill, not print" — the opposite of the truth. Region detection
 * returns `null`, OCR never runs, and CP-2 §4.5's OCR-unavailable path
 * falls back to whatever the vision channel alone says (see this ticket's
 * CHANGES.md entry for the measured before/after).
 */
const DARK_RATIO = 180 / 255;

/**
 * Which percentile of a row's own grey values stands in for "this row's
 * background level" (TRO-546). Print, even a dense paragraph, is a
 * documented minority of any row (`MAX_INK_FRACTION` below caps it at 60%,
 * and real warning text measures far under that) — so a HIGH percentile,
 * not the median, lands on background almost everywhere ink can plausibly
 * be. The median (50th) was the first thing tried and it regressed
 * case-23/24 (`tiny-warning-text`): at that print size, after the row
 * downscale to `ANALYSIS_WIDTH_PX`, a large share of a text row's pixels
 * are antialiased edge grey rather than clean black or white, which can
 * pull a 50th-percentile estimate down far enough to misprice the row's
 * OWN background, discarding real (if faint) ink signal the original fixed
 * threshold used to keep. 85 was measured, not assumed: swept 0.5 through
 * 0.9 against case-22, 23, and 24 together (the darkened case and the two
 * tiny-print cases at risk of a regression) — 0.5 through 0.8 leave
 * case-23/24 with no region at all (a real regression); 0.9 loses case-22
 * again (the percentile pixel starts landing on the SAME hard illumination
 * edge `ROW_MARGIN_PX`/`COLUMN_MARGIN_PX` below has to dodge). 0.85 is the
 * value that keeps all three — confirmed against the full 32-case corpus
 * via `pnpm eval:ocr-floor-sweep`, not just these three.
 */
const BACKGROUND_PERCENTILE = 0.85;

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

/**
 * Padding added around the winning block before cropping, in
 * analysis-resolution pixels — avoids clipping ascenders/descenders at the
 * block's own edges.
 *
 * TRO-546 shrank both values (row 2->1, column 4->1). Measured on case-22:
 * the found ink already sits flush against the darkened block's true edge
 * (the fixture's own `LABEL_REGIONS.warning` box), so the ORIGINAL padding
 * (4 analysis px, 8 original px, each side) pushed the crop a few pixels
 * past that edge into the undegraded pixels next to it — and tesseract's
 * single-block page segmentation reads that hard illumination seam as
 * structure, returning empty text at 0 confidence for the whole crop
 * (measured directly: same content, padding-only difference, confidence
 * 95 -> 0). A real photo has no such knife-edge lighting boundary; this is
 * this fixture's own artifact, not a property of dim lighting in general.
 * The smaller padding still guards the common case (verified: no
 * regression across the other 31 golden-set cases,
 * `pnpm eval:ocr-floor-sweep`) while no longer reaching past it here.
 */
const ROW_MARGIN_PX = 1;
const COLUMN_MARGIN_PX = 1;

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
 * The `percentile`-th grey value of one row of a greyscale raster (values
 * 0-255) — e.g. `percentile=0.5` is the median, `0.85` is the 85th
 * percentile. Computed via a 256-bucket cumulative histogram rather than a
 * sort — the whole point of this module is milliseconds, and a row is
 * re-scanned for this exactly once per `detectWarningRegionClassical` call.
 * Exported for direct unit testing.
 */
export function rowPercentileGrey(
  data: Uint8Array | Buffer,
  rowStart: number,
  width: number,
  percentile: number,
): number {
  const hist = new Array<number>(256).fill(0);
  for (let x = 0; x < width; x++) hist[data[rowStart + x]]++;
  const target = width * percentile;
  let cumulative = 0;
  for (let value = 0; value < 256; value++) {
    cumulative += hist[value];
    if (cumulative > target) return value;
  }
  return 255;
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

  // One threshold per row, anchored to that row's OWN background estimate
  // — see DARK_RATIO's and BACKGROUND_PERCENTILE's comments for why a
  // fixed absolute cutoff misreads a row whose whole background has been
  // darkened, not just its ink, and why the estimate is a high percentile
  // rather than the median.
  const rowDarkThreshold: number[] = [];
  for (let y = 0; y < info.height; y++) {
    rowDarkThreshold.push(rowPercentileGrey(data, y * info.width, info.width, BACKGROUND_PERCENTILE) * DARK_RATIO);
  }
  const isInk = (x: number, y: number): boolean => data[y * info.width + x] < rowDarkThreshold[y];

  const rowInkFractions: number[] = [];
  for (let y = 0; y < info.height; y++) {
    let dark = 0;
    for (let x = 0; x < info.width; x++) {
      if (isInk(x, y)) dark++;
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
      if (isInk(x, y)) {
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
