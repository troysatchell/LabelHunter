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
  type VerdictCaseScore,
} from "./types";

const EXTRACTION_FIELD_KEYS: readonly ExtractionFieldKey[] = [
  "brandName",
  "classType",
  "abv",
  "netContents",
  "governmentWarning",
];

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

export interface VerdictSummary {
  labelVerdictAccuracy: AccuracySummary;
  fieldVerdictAccuracyByField: Record<RouterFieldKey, AccuracySummary>;
  reviewReasonAccuracy: AccuracySummary;
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
  };
}

/** Builds the full `EvalReportSummary` the committed report and baseline
 * artifacts both carry. `extractionCases` and `verdictCases` must cover the
 * same case set — callers build both from the same run. */
export function buildEvalReportSummary(
  extractionCases: readonly ExtractionCaseScore[],
  verdictCases: readonly VerdictCaseScore[],
): EvalReportSummary {
  const extraction = summarizeExtraction(extractionCases);
  const verdict = summarizeVerdict(verdictCases);
  return {
    extractionAccuracy: extraction.overall,
    extractionAccuracyByField: extraction.byField,
    labelVerdictAccuracy: verdict.labelVerdictAccuracy,
    fieldVerdictAccuracyByField: verdict.fieldVerdictAccuracyByField,
    reviewReasonAccuracy: verdict.reviewReasonAccuracy,
  };
}
