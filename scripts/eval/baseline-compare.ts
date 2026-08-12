/**
 * The eval harness's regression decision (LH-030 / TRO-470) — gate G8
 * (`scripts/factory/gate.sh`) fails on this function's `regressed: true`,
 * the same "adapt the exit-code logic, don't copy it" relationship this
 * ticket's brief asks for against `scripts/latency/exit-status.ts`'s
 * `computeExitCode`. The two differ in kind: `computeExitCode` asks "did
 * every run finish cleanly," a run-health question; `compareToBaseline`
 * asks "did accuracy hold at or above the committed floor," a numbers
 * question that needs a baseline to compare against.
 *
 * Pure — no I/O, no live call. `check.ts` loads the report and baseline
 * JSON files from disk and hands their already-parsed contents here.
 *
 * Gates on the three headline `EvalReportSummary` rates (extraction,
 * label-verdict, review-reason) — never the per-field breakdowns. The
 * breakdowns are real, reported diagnostic detail (which field is driving
 * a change), but gating on all of them too would make the check brittle:
 * a single field's small-sample noise (the default sample runs eight
 * cases) could fail the whole gate while the headline numbers the ticket
 * asks for are unchanged or improved. A human reads the breakdown in the
 * committed report to see WHY; the gate only asks WHETHER.
 */
import type { EvalBaseline, EvalReportSummary } from "./types";

export interface RegressionCheckInput {
  manifestVersion: string;
  caseIds: readonly string[];
  summary: EvalReportSummary;
}

export interface RegressionCheckResult {
  regressed: boolean;
  /** Every problem found, not just the first — same "collect every
   * problem" convention as `src/lib/golden-set/loader.ts`'s
   * `validateManifest`. Empty when `regressed` is `false`. */
  reasons: string[];
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Compares `current` (a fresh `--live` run, or the last committed report)
 * against the committed `baseline`. `regressed: true` when the manifest
 * version differs, when `current` does not cover every case `baseline` was
 * built from (coverage staleness — see this file's module comment), or when
 * any of the three headline accuracy rates falls below the baseline's own
 * rate. Ties (equal rate) are NOT a regression — the floor is "at or
 * above," matching how a baseline is meant to function.
 */
export function compareToBaseline(current: RegressionCheckInput, baseline: EvalBaseline): RegressionCheckResult {
  const reasons: string[] = [];

  if (current.manifestVersion !== baseline.manifestVersion) {
    reasons.push(
      `manifest version mismatch: current run used "${current.manifestVersion}", baseline was built from "${baseline.manifestVersion}" — ` +
        "the golden set changed shape since the baseline was established; re-run --live --update-baseline to refresh it.",
    );
  }

  const currentCaseIds = new Set(current.caseIds);
  const missingCases = baseline.caseIds.filter((id) => !currentCaseIds.has(id));
  if (missingCases.length > 0) {
    reasons.push(
      `stale coverage: current run did not include ${missingCases.length} case(s) the baseline was built from ` +
        `(${missingCases.join(", ")}) — run --live --full to cover the whole golden set before comparing.`,
    );
  }

  const rateChecks: readonly [label: string, current: number, baseline: number][] = [
    ["extraction accuracy", current.summary.extractionAccuracy.rate, baseline.summary.extractionAccuracy.rate],
    ["label-verdict accuracy", current.summary.labelVerdictAccuracy.rate, baseline.summary.labelVerdictAccuracy.rate],
    ["review-reason accuracy", current.summary.reviewReasonAccuracy.rate, baseline.summary.reviewReasonAccuracy.rate],
  ];
  for (const [label, currentRate, baselineRate] of rateChecks) {
    if (currentRate < baselineRate) {
      reasons.push(`${label} regressed: ${formatRate(currentRate)} (current) < ${formatRate(baselineRate)} (baseline)`);
    }
  }

  return { regressed: reasons.length > 0, reasons };
}
