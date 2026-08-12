/**
 * Validates the shape of `scripts/eval/results/eval-report.json` and
 * `scripts/eval/baseline.json` before `check.ts` trusts them (LH-030 /
 * TRO-470). Standing rule 13: validate at the boundary where a value's
 * shape is only assumed, not guaranteed — these two files are committed
 * JSON on disk, editable by hand, and could be stale, hand-edited, or from
 * an older schema version by the time cheap-mode `pnpm eval:check` reads
 * them back. A bare `JSON.parse(...) as EvalReport` type assertion (this
 * file's own earlier shape, a PR review finding) trusts that without
 * checking it — the same anti-pattern `response-validation.ts` already
 * guards against for the `/api/verify` response body.
 *
 * Deliberately not exhaustive: only the fields `check.ts` actually reads
 * downstream (`compareToBaseline`, the failures check, the log lines) are
 * checked. The per-field accuracy breakdowns
 * (`extractionAccuracyByField`/`fieldVerdictAccuracyByField`) are real
 * report content but never drive a decision this script makes — see
 * `baseline-compare.ts`'s own module comment for why the gate only reads
 * the three headline rates. `warningSegmentation` (TRO-469 / LH-021, PRD
 * §3.7) gets the same light shape check as those breakdowns — present and
 * well-formed, never compared against a floor — for the same reason:
 * checked here so a malformed committed report fails loudly instead of
 * `check.ts` reading `undefined.resolutionSuspect` further down.
 */
import type { AccuracySummary, EvalBaseline, EvalReport, EvalReportSummary, WarningSegmentationSummary } from "./types";
import type { VarianceReport } from "./variance-analysis";

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteUnitRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isAccuracySummary(value: unknown): value is AccuracySummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonNegativeSafeInteger(candidate.total) &&
    isNonNegativeSafeInteger(candidate.correct) &&
    isFiniteUnitRate(candidate.rate)
  );
}

function isWarningSegmentCount(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return isNonNegativeSafeInteger(candidate.count) && isFiniteUnitRate(candidate.rate);
}

function isWarningSegmentationSummary(value: unknown): value is WarningSegmentationSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonNegativeSafeInteger(candidate.total) &&
    isWarningSegmentCount(candidate.clean) &&
    isWarningSegmentCount(candidate.trueMismatch) &&
    isWarningSegmentCount(candidate.resolutionSuspect) &&
    isWarningSegmentCount(candidate.notFound)
  );
}

function isEvalReportSummary(value: unknown): value is EvalReportSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isAccuracySummary(candidate.extractionAccuracy) &&
    isAccuracySummary(candidate.labelVerdictAccuracy) &&
    isAccuracySummary(candidate.reviewReasonAccuracy) &&
    isWarningSegmentationSummary(candidate.warningSegmentation)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Throws a clear, file-naming error when `parsed` does not have the
 * fields `check.ts` needs from a committed baseline. Returns `parsed`,
 * narrowed to `EvalBaseline`, otherwise. */
export function validateEvalBaseline(parsed: unknown, filePath: string): EvalBaseline {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`report-validation: ${filePath} does not contain a JSON object.`);
  }
  const candidate = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof candidate.manifestVersion !== "string") problems.push('"manifestVersion" must be a string');
  if (!isStringArray(candidate.caseIds)) problems.push('"caseIds" must be an array of strings');
  if (typeof candidate.establishedAt !== "string") problems.push('"establishedAt" must be a string');
  if (!isEvalReportSummary(candidate.summary)) {
    problems.push('"summary" must carry valid extractionAccuracy/labelVerdictAccuracy/reviewReasonAccuracy AccuracySummary objects and a valid warningSegmentation');
  }
  if (problems.length > 0) {
    throw new Error(`report-validation: ${filePath} is not a valid EvalBaseline — ${problems.join("; ")}.`);
  }
  return parsed as EvalBaseline;
}

/** Same contract as `validateEvalBaseline`, for a committed eval report —
 * additionally requires `failures` (an array `check.ts`'s own
 * failures-length check reads). */
export function validateEvalReport(parsed: unknown, filePath: string): EvalReport {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`report-validation: ${filePath} does not contain a JSON object.`);
  }
  const candidate = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof candidate.manifestVersion !== "string") problems.push('"manifestVersion" must be a string');
  if (!isStringArray(candidate.caseIds)) problems.push('"caseIds" must be an array of strings');
  if (typeof candidate.measuredAt !== "string") problems.push('"measuredAt" must be a string');
  if (!isEvalReportSummary(candidate.summary)) {
    problems.push('"summary" must carry valid extractionAccuracy/labelVerdictAccuracy/reviewReasonAccuracy AccuracySummary objects and a valid warningSegmentation');
  }
  if (!Array.isArray(candidate.failures)) problems.push('"failures" must be an array');
  if (problems.length > 0) {
    throw new Error(`report-validation: ${filePath} is not a valid EvalReport — ${problems.join("; ")}.`);
  }
  return parsed as EvalReport;
}

function isRunAccuracyArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Record<string, unknown>;
    return isNonNegativeSafeInteger(candidate.repeatIndex) && isAccuracySummary(candidate.labelVerdictAccuracy);
  });
}

function isAccuracySpread(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return isFiniteUnitRate(candidate.lowestRate) && isFiniteUnitRate(candidate.highestRate) && isRunAccuracyArray(candidate.perRun);
}

function isVarianceReportSummary(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonNegativeSafeInteger(candidate.caseCount) &&
    isNonNegativeSafeInteger(candidate.nominalRepeats) &&
    isAccuracySummary(candidate.stableCaseRate) &&
    isAccuracySpread(candidate.accuracySpread)
  );
}

/**
 * Same contract as `validateEvalReport`, for the variance runner's own
 * committed artifact (LH-038 / TRO-543, `scripts/eval/results/variance-report.json`) —
 * `variance.ts`'s cheap mode reads this back to print a summary, and a
 * hand-edited or stale file should fail loudly here, not several property
 * accesses deeper. Deliberately not exhaustive, the same "only what a
 * caller actually reads" scope this file's own module comment states for
 * `validateEvalReport`: `runs`/`failures` entries are checked for being
 * arrays, never their own full per-row shape.
 */
export function validateVarianceReport(parsed: unknown, filePath: string): VarianceReport {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`report-validation: ${filePath} does not contain a JSON object.`);
  }
  const candidate = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof candidate.measuredAt !== "string") problems.push('"measuredAt" must be a string');
  if (typeof candidate.repeats !== "number" || !Number.isSafeInteger(candidate.repeats) || candidate.repeats < 1) {
    problems.push('"repeats" must be a positive integer');
  }
  if (!isStringArray(candidate.caseIds)) problems.push('"caseIds" must be an array of strings');
  if (!isVarianceReportSummary(candidate.summary)) {
    problems.push('"summary" must carry a valid caseCount/nominalRepeats/stableCaseRate/accuracySpread');
  }
  if (!Array.isArray(candidate.runs)) problems.push('"runs" must be an array');
  if (!Array.isArray(candidate.failures)) problems.push('"failures" must be an array');
  if (typeof candidate.totalCostUsd !== "number" || !Number.isFinite(candidate.totalCostUsd)) {
    problems.push('"totalCostUsd" must be a finite number');
  }
  if (problems.length > 0) {
    throw new Error(`report-validation: ${filePath} is not a valid VarianceReport — ${problems.join("; ")}.`);
  }
  return parsed as VarianceReport;
}
