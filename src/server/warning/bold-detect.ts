/**
 * The stroke-width-ratio bold advisory check (LH-025 / TRO-532, CP-2 §7.2,
 * TH-R9). CP-2 §7.2 named a technique and did not try it: "binarize the
 * crop, measure mean stroke width by morphological erosion, and compare
 * the prefix's stroke width to the body's at matched x-height." TRO-532's
 * own investigation (2026-08-12, five real label photographs plus the
 * golden-set corpus) tried it. It works inside a boundary the measurement
 * itself defines — see `BoldSignalResult.reason` and this module's own
 * test file for the specific cases that pass and the specific cases that
 * do not.
 *
 * BOUNDARY — READ THIS BEFORE WIRING `measureBoldSignal` IN ANYWHERE.
 * This signal is advisory. It must never produce a hard FAIL by itself,
 * and it must never gate a MATCH. CP-2 §7.2's own reasoning still holds: a
 * prototype that turned this signal into a failure would accuse a
 * compliant label of a violation it cannot prove. Nothing in this repo
 * calls `measureBoldSignal` yet (TRO-532's own scope). TRO-533 wires it
 * in, deliberately sequenced after this ticket, and must keep it advisory
 * only — standing rule 10 and CP-2 §7.2 both say so.
 *
 * Two matching regimes already coexist in this subsystem on purpose
 * (`caps.ts`'s header: TH-R8 fuzzy wording vs TH-R9 exact capitalization).
 * This is a third, narrower thing — bold-or-not, advisory, three-valued —
 * and it does not reuse or extend either existing regime's logic.
 *
 * The measurement, in order:
 * 1. Binarize the crop (`toInkRaster`) — greyscale, contrast-normalize
 *    (rule 4 of the ticket's own "Do" list: case-22 was undetectable
 *    under a global threshold and clean afterward), then Otsu-threshold.
 *    Ink is the minority class by pixel count, not "the dark pixels" —
 *    that reads correctly on light-on-dark print (crown-royal's gold
 *    text on maroon) as well as the usual dark-on-light case.
 * 2. Find the crop's first text line (`findInkRuns`, imported from
 *    `./region-detect` — the same pure row-run grouper LH-020 already
 *    built and tested, reused here as a utility, not as a dependency on
 *    that module's detection behavior). The prefix always starts line 1.
 * 3. Within that line, run a changepoint search for the prefix/body
 *    boundary (rule 2), constrained to `SPLIT_SEARCH_MIN_FRACTION`
 *    through `SPLIT_SEARCH_MAX_FRACTION` of the line's own ink width
 *    (rule 3) — an unconstrained search always finds some ratio above 1
 *    on a degenerate split; see that constant's own comment.
 * 4. At the winning split, measure stroke width as the median horizontal
 *    ink-run length on each side (rule 1), each normalized by that side's
 *    OWN local cap height (rule 1's "matched x-height", CP-2 §7.2) —
 *    computed locally per side, not once for the whole line, because a
 *    title-case body's local cap height varies enough to distort a
 *    single shared divisor (rule 3's case-08/case-09 finding).
 * 5. Classify: below the `STROKE_WIDTH_FLOOR_PX` floor (rule 5), or no
 *    stable split found at all, or the two sides' stroke-width ranges
 *    overlap (no clean separation) — `uncertain`. Otherwise `bold` at or
 *    above `BOLD_RATIO_THRESHOLD`, `not-bold` below it.
 *
 * Deliberately NOT used: fill ratio (rule 6 — measured 0.85 for a window
 * and 0.87 for a real label in TRO-532's own investigation; it does not
 * discriminate bold from not-bold).
 */
import sharp from "sharp";
import { findInkRuns } from "./region-detect";

export type BoldSignal = "bold" | "not-bold" | "uncertain";

export interface BoldSignalResult {
  readonly signal: BoldSignal;
  /** ASD-STE100, written for the same compliance-agent audience as every
   * other reason string in this subsystem (CP-2 §6.3) — even though this
   * signal has no UI wiring yet (that is TRO-533's job). */
  readonly reason: string;
  /** Prefix stroke width ÷ body stroke width, both cap-height-normalized.
   * `null` when no split was found. Not a pass/fail input — exposed for
   * tests and future telemetry only. */
  readonly ratio: number | null;
  /** Where in the line's own ink width the prefix/body boundary was
   * found, 0-1. `null` when no split was found. */
  readonly splitFraction: number | null;
  /** Raw, non-normalized median stroke width in pixels, each side. `null`
   * when no split was found. */
  readonly prefixStrokeWidthPx: number | null;
  readonly bodyStrokeWidthPx: number | null;
}

function uncertainResult(reason: string): BoldSignalResult {
  return {
    signal: "uncertain",
    reason,
    ratio: null,
    splitFraction: null,
    prefixStrokeWidthPx: null,
    bodyStrokeWidthPx: null,
  };
}

/** Proposed (TRO-532; LH-030's sweep replaces every "proposed" number in
 * this file with a measured one — CP-2 §12's own convention). Stroke
 * width below this many pixels is not a reliable measurement: at that
 * scale, JPEG compression and antialiasing are the same order of
 * magnitude as the bold/regular difference itself. TRO-532's own
 * investigation measured crown-royal's stroke at 1-3px and case-23's
 * (9px type) at 2px — both below this floor. Rule 5 of the ticket's own
 * "Do" list: return `uncertain`, never guess. */
export const STROKE_WIDTH_FLOOR_PX = 3;

/** Proposed. Constrains the changepoint search to this fraction of the
 * line's own ink width. TRO-532's own investigation (2026-08-12) found an
 * unconstrained search always finds SOME ratio above 1 on a degenerate
 * split: case-08 (title-case prefix only) picked split 0.88 for a false
 * ratio of 1.50; case-09 (the whole statement title-case) picked split
 * 0.11 for a false ratio of 1.29. Both are artifacts of a split slicing
 * off a small chunk of text whose local cap-height divisor (the
 * per-side `prefixCapHeight`/`suffixCapHeight` `findBoldChangepoint`
 * computes below) happens to be small, not a real bold/regular
 * difference. The true split on the flat reference photograph
 * (case-35-clean-match-real-photo-flat-scan) sits at 0.49 — the actual
 * colon position — comfortably inside this window. Rule 3. */
export const SPLIT_SEARCH_MIN_FRACTION = 0.15;
export const SPLIT_SEARCH_MAX_FRACTION = 0.65;

/** Proposed. A candidate split needs at least this many ink runs on EACH
 * side before its median is trusted — fewer than this and a single
 * stray run can swing the median. */
export const MIN_RUNS_PER_SIDE = 3;

/** Proposed. At or above this ratio (prefix's normalized stroke width ÷
 * body's), call the prefix bold. Calibrated against the one clean
 * measurement TRO-532's investigation trusts without qualification:
 * case-35's flat, straight-on photograph measures 2.0-2.25
 * (`docs/reference-photo-provenance.md`, file 1), stable across three
 * thresholds. LH-030's sweep is what turns this into a measured value. */
export const BOLD_RATIO_THRESHOLD = 1.3;

/** Proposed. A row counts as part of a text line when at least this
 * fraction of its pixels are ink — filters stray noise, not real print.
 * Reuses `region-detect.ts`'s own `MIN_INK_FRACTION` value on the
 * reasoning that both are "is this row real text" questions, though this
 * module computes its own ink raster and does not import that constant. */
const MIN_ROW_INK_FRACTION = 0.01;
/** Proposed. Above this fraction, a row is a solid fill, not print — a
 * defensive upper bound; a tight warning-region crop rarely needs it. */
const MAX_ROW_INK_FRACTION = 0.95;

/** Proposed. A warning-region crop holds a whole paragraph — measured at
 * 3-5 lines for a rendered label (`region-detect.ts`'s own header
 * comment) and up to 7 for a real, more tightly-leaded photograph
 * (case-35: 7 lines at ~11% of crop height each). A single real physical
 * line should never fill anywhere close to half the crop. TRO-532's own
 * investigation found the opposite on the three hardest curved
 * photographs: the blank-row gap between physical lines never reaches
 * near-zero ink (curvature, tilt, and blur fill it in), so the row scan
 * reads the WHOLE multi-line paragraph as one 100%-of-crop-height "line"
 * — measured directly on case-36/37/39's own crops before this check
 * existed. That is exactly "the window straddles arced lines" in the
 * ticket's own table. This check catches that failure and reports
 * `uncertain` instead of measuring a changepoint across several unrelated
 * physical lines. */
const MAX_LINE_HEIGHT_FRACTION = 0.4;

/** The smallest crop this measurement can possibly work on — below this,
 * there is not enough room for a line, a split, and two measurable
 * sides. Not a calibrated number, just a sanity floor (standing rule 13:
 * validate the input's shape before trusting it). */
const MIN_CROP_DIMENSION_PX = 8;

interface InkRun {
  readonly start: number;
  readonly end: number;
}

interface InkRaster {
  readonly width: number;
  readonly height: number;
  readonly isInk: (x: number, y: number) => boolean;
}

/**
 * Otsu's method: the threshold that maximizes between-class variance for
 * a bimodal (ink vs. background) grey histogram. Pure and exported for
 * direct unit testing on synthetic histograms — this repo's own house
 * style for a small numeric algorithm (`region-detect.ts`'s
 * `rowPercentileGrey`, `findInkRuns`).
 */
export function otsuThreshold(histogram: readonly number[]): number {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 128;

  let sumAll = 0;
  for (let level = 0; level < histogram.length; level++) sumAll += level * histogram[level];

  let weightBackground = 0;
  let sumBackground = 0;
  let bestThreshold = 0;
  let bestVariance = -1;

  for (let level = 0; level < histogram.length; level++) {
    weightBackground += histogram[level];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += level * histogram[level];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;

    const betweenClassVariance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (betweenClassVariance > bestVariance) {
      bestVariance = betweenClassVariance;
      bestThreshold = level;
    }
  }
  return bestThreshold;
}

/** Middle value of a sorted-in-place copy of `values`. Callers only ever
 * pass a non-empty array — `measureBoldSignal` enforces `MIN_RUNS_PER_SIDE`
 * before calling this. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Linear-interpolated quartile (`q` in `[0, 1]`) of an ALREADY-SORTED
 * array — the standard definition used by, e.g., numpy's default
 * `interpolation="linear"`. Used only for the ranges-overlap check
 * (`sideRangesOverlap`), so a simple, well-known definition is enough. */
function sortedQuartile(sortedValues: readonly number[], q: number): number {
  const position = (sortedValues.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sortedValues[base + 1];
  return next === undefined ? sortedValues[base] : sortedValues[base] + rest * (next - sortedValues[base]);
}

/** True when two sides' stroke-width distributions (each already
 * normalized by its own local cap height) overlap at the interquartile
 * range — TRO-532's own investigation described exactly this failure
 * mode on 39cdef's curved photograph: "no separation; ranges overlap."
 * IQR, not min/max, so one stray long horizontal-serif run does not by
 * itself force an "overlap" verdict. */
function sideRangesOverlap(leftValues: readonly number[], rightValues: readonly number[]): boolean {
  const left = [...leftValues].sort((a, b) => a - b);
  const right = [...rightValues].sort((a, b) => a - b);
  const leftQ1 = sortedQuartile(left, 0.25);
  const leftQ3 = sortedQuartile(left, 0.75);
  const rightQ1 = sortedQuartile(right, 0.25);
  const rightQ3 = sortedQuartile(right, 0.75);
  return !(leftQ3 < rightQ1 || rightQ3 < leftQ1);
}

/**
 * Greyscale, contrast-normalized, Otsu-binarized reading of `image`.
 * Flattens any alpha channel onto white first, matching
 * `region-detect.ts`'s `cropForOcr` convention, so a PNG crop with
 * transparency does not corrupt the grey values. Ink is the minority
 * pixel class by count, not "the darker class" — text is normally a
 * small fraction of a crop's area regardless of whether it prints dark
 * on light (the common case) or light on dark (crown-royal: gold text on
 * a maroon background). Returns `null` when the image has no readable
 * dimensions.
 */
async function toInkRaster(image: Buffer): Promise<InkRaster | null> {
  const { data, info } = await sharp(image)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .normalise()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!info.width || !info.height) return null;

  const histogram = new Array<number>(256).fill(0);
  for (let i = 0; i < data.length; i++) histogram[data[i]]++;
  const threshold = otsuThreshold(histogram);

  let belowCount = 0;
  for (let level = 0; level <= threshold; level++) belowCount += histogram[level];
  const aboveCount = data.length - belowCount;
  const inkIsBelow = belowCount <= aboveCount;

  return {
    width: info.width,
    height: info.height,
    isInk: (x, y) => {
      const value = data[y * info.width + x];
      return inkIsBelow ? value <= threshold : value > threshold;
    },
  };
}

/** All ink runs (maximal contiguous spans of ink pixels) in one row. */
function findRowInkRuns(raster: InkRaster, y: number): InkRun[] {
  const runs: InkRun[] = [];
  let start: number | null = null;
  for (let x = 0; x < raster.width; x++) {
    const ink = raster.isInk(x, y);
    if (ink && start === null) start = x;
    if (!ink && start !== null) {
      runs.push({ start, end: x - 1 });
      start = null;
    }
  }
  if (start !== null) runs.push({ start, end: raster.width - 1 });
  return runs;
}

export interface StrokeRun {
  readonly length: number;
  readonly mid: number;
}

export interface ChangepointCandidate {
  readonly splitX: number;
  readonly leftNorm: number;
  readonly rightNorm: number;
  readonly leftRawMedian: number;
  readonly rightRawMedian: number;
  readonly leftNormValues: readonly number[];
  readonly rightNormValues: readonly number[];
}

/**
 * The changepoint search (rule 2 of the ticket's own "Do" list): among
 * candidate splits in `[searchStart, searchEnd]` — already the caller's
 * job to constrain to `SPLIT_SEARCH_MIN_FRACTION`-`SPLIT_SEARCH_MAX_FRACTION`
 * of the line, per rule 3 — picks the split that maximizes the gap
 * between the two sides' cap-height-normalized median stroke width.
 *
 * `prefixCapHeight`/`suffixCapHeight` are indexed by x: `prefixCapHeight[x]`
 * is the local cap height of every ink pixel at or left of x;
 * `suffixCapHeight[x]` is the same, at or right of x. Both carry `-1`
 * where no ink has been seen yet. `measureBoldSignal` is this function's
 * only production caller, but it is exported and takes plain arrays
 * (not a raster) specifically so a test can hand it small, hand-built
 * numbers instead of rendering pixels — the ticket's own instruction for
 * the case-08/case-09 boundary behavior: "these may be synthetic unit
 * tests of the changepoint logic in isolation."
 */
export function findBoldChangepoint(
  taggedRuns: readonly StrokeRun[],
  searchStart: number,
  searchEnd: number,
  prefixCapHeight: readonly number[],
  suffixCapHeight: readonly number[],
  minRunsPerSide: number = MIN_RUNS_PER_SIDE,
): ChangepointCandidate | null {
  let best: ChangepointCandidate | null = null;
  let bestScore = -Infinity;

  for (let splitX = searchStart; splitX <= searchEnd; splitX++) {
    const leftLengths = taggedRuns.filter((r) => r.mid < splitX).map((r) => r.length);
    const rightLengths = taggedRuns.filter((r) => r.mid >= splitX).map((r) => r.length);
    if (leftLengths.length < minRunsPerSide || rightLengths.length < minRunsPerSide) continue;

    const leftCapHeight = prefixCapHeight[splitX - 1];
    const rightCapHeight = suffixCapHeight[splitX];
    if (!(leftCapHeight > 0) || !(rightCapHeight > 0)) continue;

    const leftRawMedian = medianOf(leftLengths);
    const rightRawMedian = medianOf(rightLengths);
    const leftNorm = leftRawMedian / leftCapHeight;
    const rightNorm = rightRawMedian / rightCapHeight;
    if (!Number.isFinite(leftNorm) || !Number.isFinite(rightNorm)) continue;

    const score = Math.abs(leftNorm - rightNorm);
    if (score > bestScore) {
      bestScore = score;
      best = {
        splitX,
        leftNorm,
        rightNorm,
        leftRawMedian,
        rightRawMedian,
        leftNormValues: leftLengths.map((l) => l / leftCapHeight),
        rightNormValues: rightLengths.map((l) => l / rightCapHeight),
      };
    }
  }
  return best;
}

/**
 * The measurement (LH-025 / TRO-532). Takes an already-cropped
 * warning-region image (`region-detect.ts`'s `cropForOcr` output, or
 * equivalent) and returns a three-valued advisory signal. Never throws —
 * an unreadable or malformed input degrades to `uncertain`, the same
 * "never fail the request" posture `index.ts`'s `runOcrChannel` already
 * uses for this subsystem's other pixel-reading path.
 */
export async function measureBoldSignal(image: Buffer): Promise<BoldSignalResult> {
  if (!Buffer.isBuffer(image) || image.length === 0) {
    return uncertainResult("the input image is empty");
  }

  let raster: InkRaster | null;
  try {
    raster = await toInkRaster(image);
  } catch {
    return uncertainResult("the input image could not be read");
  }
  if (!raster) return uncertainResult("the input image has no readable dimensions");
  if (raster.width < MIN_CROP_DIMENSION_PX || raster.height < MIN_CROP_DIMENSION_PX) {
    return uncertainResult("the crop is too small to measure");
  }

  const rowInkFractions: number[] = [];
  for (let y = 0; y < raster.height; y++) {
    let count = 0;
    for (let x = 0; x < raster.width; x++) if (raster.isInk(x, y)) count++;
    rowInkFractions.push(count / raster.width);
  }

  const lineRuns = findInkRuns(rowInkFractions, MIN_ROW_INK_FRACTION, MAX_ROW_INK_FRACTION);
  if (lineRuns.length === 0) return uncertainResult("no text line found in the crop");
  const line = lineRuns[0]; // topmost line — the prefix always starts line 1

  const lineHeightFraction = (line.end - line.start + 1) / raster.height;
  if (lineHeightFraction > MAX_LINE_HEIGHT_FRACTION) {
    return uncertainResult("the detected line spans too much of the crop; the paragraph's lines likely merged into one");
  }

  // Column-trim the line to where its own ink actually is.
  let lineLeft = raster.width;
  let lineRight = -1;
  for (let y = line.start; y <= line.end; y++) {
    for (let x = 0; x < raster.width; x++) {
      if (raster.isInk(x, y)) {
        if (x < lineLeft) lineLeft = x;
        if (x > lineRight) lineRight = x;
      }
    }
  }
  if (lineRight < lineLeft) return uncertainResult("the detected text line has no ink columns");
  const lineWidth = lineRight - lineLeft + 1;

  // Per-column local vertical ink extent within the line's own row band —
  // the raw material for each candidate split's LOCAL cap height
  // (rule 1's "matched x-height"; rule 3's case-08/case-09 finding on
  // why this must be local per side, not one shared value for the line).
  const columnTop = new Array<number>(raster.width).fill(-1);
  const columnBottom = new Array<number>(raster.width).fill(-1);
  for (let y = line.start; y <= line.end; y++) {
    for (let x = lineLeft; x <= lineRight; x++) {
      if (raster.isInk(x, y)) {
        if (columnTop[x] === -1) columnTop[x] = y;
        columnBottom[x] = y;
      }
    }
  }

  // Running prefix (left-to-right) and suffix (right-to-left) top/bottom,
  // so each candidate split's two local cap heights are an O(1) lookup
  // instead of an O(width) rescan per candidate.
  const prefixTop = new Array<number>(raster.width).fill(-1);
  const prefixBottom = new Array<number>(raster.width).fill(-1);
  let runningTop = -1;
  let runningBottom = -1;
  for (let x = lineLeft; x <= lineRight; x++) {
    if (columnTop[x] !== -1) {
      runningTop = runningTop === -1 ? columnTop[x] : Math.min(runningTop, columnTop[x]);
      runningBottom = Math.max(runningBottom, columnBottom[x]);
    }
    prefixTop[x] = runningTop;
    prefixBottom[x] = runningBottom;
  }
  const suffixTop = new Array<number>(raster.width).fill(-1);
  const suffixBottom = new Array<number>(raster.width).fill(-1);
  runningTop = -1;
  runningBottom = -1;
  for (let x = lineRight; x >= lineLeft; x--) {
    if (columnTop[x] !== -1) {
      runningTop = runningTop === -1 ? columnTop[x] : Math.min(runningTop, columnTop[x]);
      runningBottom = Math.max(runningBottom, columnBottom[x]);
    }
    suffixTop[x] = runningTop;
    suffixBottom[x] = runningBottom;
  }

  // Every ink run in the line's row band, tagged by its horizontal
  // midpoint — the unit the changepoint search assigns to one side or
  // the other of a candidate split.
  const taggedRuns: { length: number; mid: number }[] = [];
  for (let y = line.start; y <= line.end; y++) {
    for (const run of findRowInkRuns(raster, y)) {
      taggedRuns.push({ length: run.end - run.start + 1, mid: (run.start + run.end) / 2 });
    }
  }

  const searchStart = Math.max(lineLeft + 1, lineLeft + Math.round(SPLIT_SEARCH_MIN_FRACTION * lineWidth));
  const searchEnd = Math.min(lineRight, lineLeft + Math.round(SPLIT_SEARCH_MAX_FRACTION * lineWidth));

  // Collapse the running prefix/suffix top-bottom pairs into per-x local
  // cap heights — the shape `findBoldChangepoint` takes, and a shape a
  // test can hand-build without rendering any pixels.
  const prefixCapHeight = new Array<number>(raster.width).fill(-1);
  const suffixCapHeight = new Array<number>(raster.width).fill(-1);
  for (let x = lineLeft; x <= lineRight; x++) {
    prefixCapHeight[x] = prefixTop[x] === -1 ? -1 : prefixBottom[x] - prefixTop[x] + 1;
    suffixCapHeight[x] = suffixTop[x] === -1 ? -1 : suffixBottom[x] - suffixTop[x] + 1;
  }

  const best = findBoldChangepoint(taggedRuns, searchStart, searchEnd, prefixCapHeight, suffixCapHeight);
  if (!best) return uncertainResult("no reliable prefix/body split found in the constrained search window");

  const splitFraction = (best.splitX - lineLeft) / lineWidth;
  const prefixStrokeWidthPx = best.leftRawMedian;
  const bodyStrokeWidthPx = best.rightRawMedian;
  const ratio = best.leftNorm / best.rightNorm;

  if (!Number.isFinite(ratio) || ratio <= 0) {
    return uncertainResult("the measured stroke-width ratio is not a usable number");
  }

  const rangesOverlap = sideRangesOverlap(best.leftNormValues, best.rightNormValues);
  const classification = classifyBoldSignal(ratio, prefixStrokeWidthPx, bodyStrokeWidthPx, rangesOverlap);

  return {
    signal: classification.signal,
    reason: classification.reason,
    ratio,
    splitFraction,
    prefixStrokeWidthPx,
    bodyStrokeWidthPx,
  };
}

/**
 * The final bold/not-bold/uncertain decision, given an already-measured
 * ratio and the two reliability checks (rules 5 and the ranges-overlap
 * check). Split out as its own pure function so the decision itself is
 * directly unit-testable on synthetic numbers — the same house-style
 * reason the changepoint search's boundary behavior gets synthetic tests
 * too (this ticket's own instructions). Proven three ways in this file's
 * test suite: directly, on hand-picked numbers; against a controlled
 * synthetic image; and against `golden-set/manifest.json`'s
 * `case-33-not-bold-warning-prefix` — a real, rendered, non-synthetic
 * image TRO-527's own CHANGES.md entry had already flagged as missing
 * ("None of these 32 cases tests a bold violation").
 */
export function classifyBoldSignal(
  ratio: number,
  prefixStrokeWidthPx: number,
  bodyStrokeWidthPx: number,
  rangesOverlap: boolean,
): { signal: BoldSignal; reason: string } {
  if (Math.min(prefixStrokeWidthPx, bodyStrokeWidthPx) < STROKE_WIDTH_FLOOR_PX) {
    return { signal: "uncertain", reason: "stroke width is below the reliable measurement floor" };
  }
  if (rangesOverlap) {
    return { signal: "uncertain", reason: "prefix and body stroke-width ranges overlap; no clean separation" };
  }
  if (ratio >= BOLD_RATIO_THRESHOLD) {
    return { signal: "bold", reason: "the prefix's stroke width measures wider than the body's" };
  }
  return { signal: "not-bold", reason: "the prefix's stroke width does not measure wider than the body's" };
}
