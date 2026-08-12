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
 * Gates on the four headline `EvalReportSummary` rates (extraction,
 * router-verdict, cascade-verdict, review-reason — TRO-538 / LH-033 added
 * cascade-verdict) — never the per-field breakdowns. The breakdowns are
 * real, reported diagnostic detail (which field is driving a change), but
 * gating on all of them too would make the check brittle: a single field's
 * small-sample noise (the default sample runs eight cases) could fail the
 * whole gate while the headline numbers the ticket asks for are unchanged
 * or improved. A human reads the breakdown in the committed report to see
 * WHY; the gate only asks WHETHER.
 *
 * Also rejects a comparison whose current run's `manifestContentHash`
 * disagrees with the baseline's (TRO-538 / LH-033) — a check
 * `manifestVersion` alone cannot make, since seven straight commits that
 * edited `golden-set/manifest.json` all left `version` at `"1.0.0"`
 * (`docs/diagnostics/2026-08-12-verdict-miss-triage.md` §5 S5).
 *
 * `warningSegmentation` (TRO-469 / LH-021, PRD §3.7) is the same kind of
 * reported-not-gated detail, for a sharper reason than sample noise: it
 * feeds a five-way human decision (CP-2 §8.4's upgrade ladder — keep
 * Haiku, fix the crop pipeline, upgrade the warning field, or upgrade the
 * whole extractor), not a pass/fail question this script could answer on
 * its own. PRD §3.7's own framing is "a number in CI output, not a
 * judgment call mid-week" — reported, so the judgment call is informed;
 * never gated, because the judgment call still belongs to a person.
 */
import type { EvalBaseline, EvalReportSummary } from "./types";

export interface RegressionCheckInput {
  manifestVersion: string;
  /** SHA-256 of `golden-set/manifest.json`'s raw content (TRO-538 / LH-033,
   * `manifest-hash.ts`) — see this file's own module comment. */
  manifestContentHash: string;
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

  if (current.manifestContentHash !== baseline.manifestContentHash) {
    reasons.push(
      `manifest content changed: current run's manifest hash "${current.manifestContentHash}" does not match the baseline's ` +
        `"${baseline.manifestContentHash}" — golden-set/manifest.json's content moved since the baseline was established, even if ` +
        "manifestVersion did not; re-run --live --update-baseline to refresh it.",
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
    ["router-verdict accuracy", current.summary.routerVerdictAccuracy.rate, baseline.summary.routerVerdictAccuracy.rate],
    ["cascade-verdict accuracy", current.summary.cascadeVerdictAccuracy.rate, baseline.summary.cascadeVerdictAccuracy.rate],
    ["review-reason accuracy", current.summary.reviewReasonAccuracy.rate, baseline.summary.reviewReasonAccuracy.rate],
  ];
  for (const [label, currentRate, baselineRate] of rateChecks) {
    if (currentRate < baselineRate) {
      reasons.push(`${label} regressed: ${formatRate(currentRate)} (current) < ${formatRate(baselineRate)} (baseline)`);
    }
  }

  return { regressed: reasons.length > 0, reasons };
}
