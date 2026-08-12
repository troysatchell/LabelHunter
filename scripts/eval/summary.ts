/**
 * Aggregates per-case extraction and verdict scores into the summary
 * numbers `check.ts`, `benchmark.ts`, and the committed report/baseline
 * artifacts all read (LH-030 / TRO-470). Pure — no I/O.
 */
import type { RouterFieldKey } from "../../src/server/router/types";
import {
  ROUTER_FIELD_KEYS,
  type AccuracySummary,
  type EvalReportSummary,
  type ExtractionCaseScore,
  type ExtractionFieldKey,
  type ExtractionFieldScore,
  type ReliabilityBucket,
  type VerdictCaseScore,
  type WarningSegmentationSummary,
} from "./types";
import { segmentWarningCheckOutcomes } from "./warning-segmentation";

const EXTRACTION_FIELD_KEYS: readonly ExtractionFieldKey[] = [
  "brandName",
  "classType",
  "abv",
  "netContents",
  "governmentWarning",
];

/** CP-1 §4.5 step 2's reliability diagram has ten confidence deciles. */
const RELIABILITY_DECILE_COUNT = 10;

/** `correct / total`, or `0` on an empty population — see `AccuracySummary`'s
 * own doc comment for why `0`, not `NaN`, is the honest empty answer. */
export function summarize(total: number, correct: number): AccuracySummary {
  return { total, correct, rate: total === 0 ? 0 : correct / total };
}

/** Summarizes a boolean predicate over an array into one `AccuracySummary` —
 * the one place every summary in this module counts "how many are true". */
function summarizeBy<T>(items: readonly T[], isCorrect: (item: T) => boolean): AccuracySummary {
  return summarize(items.length, items.filter(isCorrect).length);
}

/**
 * Groups `items` by `keyOf(item)` into one `AccuracySummary` per key in
 * `keys` — the one place `summarizeExtraction` and `summarizeVerdict` each
 * built their own per-field breakdown (a PR review finding: two near-
 * identical `Object.fromEntries` calls, one per function, that could drift
 * from each other). `keys` is the full, fixed key set (not derived from
 * `items`), so a key with zero matching items still gets a real, zeroed
 * `AccuracySummary` rather than being silently absent from the result.
 */
function summarizeByKey<T, K extends string>(
  items: readonly T[],
  keys: readonly K[],
  keyOf: (item: T) => K,
  isCorrect: (item: T) => boolean,
): Record<K, AccuracySummary> {
  return Object.fromEntries(keys.map((key) => [key, summarizeBy(items.filter((item) => keyOf(item) === key), isCorrect)])) as Record<
    K,
    AccuracySummary
  >;
}

export interface ExtractionSummary {
  overall: AccuracySummary;
  byField: Record<ExtractionFieldKey, AccuracySummary>;
}

/** Overall extraction accuracy = correct FIELDS over total fields scored
 * across every case (not "cases where every field was correct") — TH-R17
 * asks "did the model read the fields right, field by field", a per-field
 * question, not a per-case all-or-nothing one. */
export function summarizeExtraction(cases: readonly ExtractionCaseScore[]): ExtractionSummary {
  const allFields = cases.flatMap((c) => c.fields);
  const byField = summarizeByKey(allFields, EXTRACTION_FIELD_KEYS, (f) => f.field, (f) => f.correct);
  return { overall: summarizeBy(allFields, (f) => f.correct), byField };
}

/**
 * CP-1 §4.5 step 2's reliability diagram (TRO-538 / LH-033): every scored
 * extraction field bucketed by its own confidence, rounded down to the
 * nearest tenth, with each bucket's own measured accuracy. Always returns
 * exactly `RELIABILITY_DECILE_COUNT` buckets, in order, even when a
 * bucket's `n` is 0 — a reader should see an empty decile, not a missing
 * key.
 */
export function buildExtractionReliabilityDiagram(fields: readonly ExtractionFieldScore[]): ReliabilityBucket[] {
  const buckets: { n: number; correct: number }[] = Array.from({ length: RELIABILITY_DECILE_COUNT }, () => ({ n: 0, correct: 0 }));
  for (const field of fields) {
    // Clamped into [0, RELIABILITY_DECILE_COUNT - 1]: confidence is
    // documented as 0.00-1.00 (`ExtractedField`'s own doc comment), so a
    // value of exactly 1.0 must land in the last bucket, not overflow one
    // past it, and a boundary-violating value from a malformed response
    // still lands somewhere rather than throwing this diagnostic-only
    // diagram off a live run.
    const decile = Math.min(RELIABILITY_DECILE_COUNT - 1, Math.max(0, Math.floor(field.confidence * RELIABILITY_DECILE_COUNT)));
    buckets[decile].n += 1;
    if (field.correct) buckets[decile].correct += 1;
  }
  return buckets.map((bucket, decile) => ({
    decile,
    n: bucket.n,
    correct: bucket.correct,
    rate: bucket.n === 0 ? 0 : bucket.correct / bucket.n,
  }));
}

export interface VerdictSummary {
  labelVerdictAccuracy: AccuracySummary;
  fieldVerdictAccuracyByField: Record<RouterFieldKey, AccuracySummary>;
  reviewReasonAccuracy: AccuracySummary;
  /** PRD §3.7 / CP-2 §8.4's warning upgrade-ladder segmentation (TRO-469 /
   * LH-021) — computed here, not `check.ts`, so `benchmark.ts`'s two arms
   * (`ArmSummary extends VerdictSummary`) get it for free too: the
   * cascade-vs-Sonnet-only comparison can show whether the resolution-
   * suspect rate itself would change under the benchmark's alternate arm,
   * the same real-Sonnet-per-field question §3.7's ladder ultimately asks. */
  warningSegmentation: WarningSegmentationSummary;
}

/**
 * `reviewReasonAccuracy` is scored only over cases the golden set expects
 * to REVIEW — `VerdictCaseScore.reviewReasonCorrect` is vacuously `true` on
 * a PASS/FAIL case (`verdict-scoring.ts`'s own doc comment), and folding
 * those in would inflate the reason-accuracy number with cases that never
 * had a reason to get right.
 */
export function summarizeVerdict(cases: readonly VerdictCaseScore[]): VerdictSummary {
  const allFields = cases.flatMap((c) => c.fields);
  const fieldVerdictAccuracyByField = summarizeByKey(allFields, ROUTER_FIELD_KEYS, (f) => f.field, (f) => f.correct);
  const reviewCases = cases.filter((c) => c.expectedLabelVerdict === "REVIEW");
  return {
    labelVerdictAccuracy: summarizeBy(cases, (c) => c.labelVerdictCorrect),
    fieldVerdictAccuracyByField,
    reviewReasonAccuracy: summarizeBy(reviewCases, (c) => c.reviewReasonCorrect),
    warningSegmentation: segmentWarningCheckOutcomes(cases),
  };
}

/** Builds the full `EvalReportSummary` the committed report and baseline
 * artifacts both carry. `extractionCases`, `routerVerdictCases`, and
 * `cascadeVerdictCases` must all cover the same case set — callers build
 * all three from the same run.
 *
 * `routerVerdictCases` and `cascadeVerdictCases` (TRO-538 / LH-033) are
 * deliberately TWO separate lists, not one: the per-field breakdown
 * (`fieldVerdictAccuracyByField`), `reviewReasonAccuracy`, and
 * `warningSegmentation` are all scored at the ROUTER stage only — see
 * `EvalReportSummary.routerVerdictAccuracy`'s own doc comment for why
 * doubling every one of those into a cascade-stage twin is out of this
 * ticket's scope. `cascadeVerdictCases` feeds exactly one number:
 * `cascadeVerdictAccuracy`.
 */
export function buildEvalReportSummary(
  extractionCases: readonly ExtractionCaseScore[],
  routerVerdictCases: readonly VerdictCaseScore[],
  cascadeVerdictCases: readonly VerdictCaseScore[],
): EvalReportSummary {
  const extraction = summarizeExtraction(extractionCases);
  const routerVerdict = summarizeVerdict(routerVerdictCases);
  return {
    extractionAccuracy: extraction.overall,
    extractionAccuracyByField: extraction.byField,
    routerVerdictAccuracy: routerVerdict.labelVerdictAccuracy,
    fieldVerdictAccuracyByField: routerVerdict.fieldVerdictAccuracyByField,
    reviewReasonAccuracy: routerVerdict.reviewReasonAccuracy,
    warningSegmentation: routerVerdict.warningSegmentation,
    cascadeVerdictAccuracy: summarizeBy(cascadeVerdictCases, (c) => c.labelVerdictCorrect),
    extractionReliabilityDiagram: buildExtractionReliabilityDiagram(extractionCases.flatMap((c) => c.fields)),
  };
}
