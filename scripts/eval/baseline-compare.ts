/**
 * The eval harness's regression decision (LH-030 / TRO-470, rewritten by
 * TRO-561) — gate G8 (`scripts/factory/gate.sh`) fails on a live-mode
 * comparison carrying any problem, and on a cheap-mode one carrying an
 * `"accuracy-below-band"` or `"coverage-mismatch"` problem (see
 * `check.ts`'s own `runCheap`/`runLive` for exactly where that mode split
 * lives — this file stays pure and mode-agnostic).
 *
 * THREE DISTINCT PROBLEM CLASSES (TRO-561's own Do item 3/4), never
 * conflated into one undifferentiated list the way the pre-TRO-561 version
 * of this file did:
 *
 *   - `"accuracy-below-band"` — a headline rate fell below its own measured
 *     band floor. A REAL regression question.
 *   - `"stale-baseline"` — the current run's manifest hash (or version)
 *     disagrees with the baseline's. The corpus moved since the baseline
 *     band was measured; the comparison itself cannot be trusted until
 *     someone re-runs the re-baseline protocol
 *     (`scripts/eval/variance.ts`'s `--establish-baseline`). This is a
 *     STALENESS question, not a regression one — the two have different
 *     fixes, and reporting them as one list (the pre-TRO-561 shape) hid
 *     that difference.
 *   - `"coverage-mismatch"` — the current run's case set does not cover
 *     every case the baseline band was measured over. A COVERAGE question:
 *     run `--live --full`, not a real regression.
 *
 * Gates on the two BANDED headline rates only (extraction accuracy,
 * cascade-verdict accuracy — `EvalBaseline`'s own doc comment, `types.ts`,
 * explains why `routerVerdictAccuracy`/`reviewReasonAccuracy` are reported
 * but not banded) — never the per-field breakdowns. The breakdowns are
 * real, reported diagnostic detail (which field is driving a change), but
 * gating on all of them too would make the check brittle: a single field's
 * small-sample noise (the default sample runs eight cases) could fail the
 * whole gate while the headline numbers the ticket asks for are unchanged
 * or improved. A human reads the breakdown in the committed report to see
 * WHY; the gate only asks WHETHER.
 *
 * `warningSegmentation` (TRO-469 / LH-021, PRD §3.7) is the same kind of
 * reported-not-gated detail, for a sharper reason than sample noise: it
 * feeds a five-way human decision (CP-2 §8.4's upgrade ladder — keep
 * Haiku, fix the crop pipeline, upgrade the warning field, or upgrade the
 * whole extractor), not a pass/fail question this script could answer on
 * its own. PRD §3.7's own framing is "a number in CI output, not a
 * judgment call mid-week" — reported, so the judgment call is informed;
 * never gated, because the judgment call still belongs to a person.
 *
 * Pure — no I/O, no live call. `check.ts` loads the report and baseline
 * JSON files from disk and hands their already-parsed contents here.
 */
import type { AccuracyBand, EvalBaseline, EvalReportSummary } from "./types";

export interface RegressionCheckInput {
  manifestVersion: string;
  /** SHA-256 of `golden-set/manifest.json`'s raw content (TRO-538 / LH-033,
   * `manifest-hash.ts`) — see this file's own module comment. */
  manifestContentHash: string;
  caseIds: readonly string[];
  summary: EvalReportSummary;
}

export type ComparisonProblemClass = "accuracy-below-band" | "stale-baseline" | "coverage-mismatch";

export interface ComparisonProblem {
  readonly problemClass: ComparisonProblemClass;
  readonly message: string;
}

export interface RegressionCheckResult {
  /** Every problem found, not just the first — same "collect every
   * problem" convention as `src/lib/golden-set/loader.ts`'s
   * `validateManifest`. Empty means a clean comparison. Each problem
   * carries its own `problemClass` — callers decide pass/fail per mode by
   * inspecting these, never a single collapsed boolean (see this file's
   * own module comment for why `"stale-baseline"` alone gets different
   * treatment in `check.ts`'s cheap mode). */
  readonly problems: readonly ComparisonProblem[];
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

const REBASELINE_HINT = "Run the re-baseline protocol: pnpm eval:variance -- --live --full --repeats=3 --establish-baseline.";

/** One banded metric's pass/fail line, in the variance-aware language
 * TRO-561's own Do item 3 asks for — "78.1% is within the measured
 * 78.1-81.3% band" on a pass, "74% is below the band" on a fail. Exported
 * so `check.ts` can print the SAME line on both a pass and a fail — a
 * silent pass on a banded metric would leave a reader unable to tell
 * "within band" from "not checked at all". */
export function formatBandLine(label: string, rate: number, band: AccuracyBand, k: number): string {
  const rangeText = `${formatRate(band.min)}-${formatRate(band.max)}`;
  if (rate < band.min) {
    return `${label} ${formatRate(rate)} is BELOW the measured ${rangeText} band (K=${k}).`;
  }
  return `${label} ${formatRate(rate)} is within the measured ${rangeText} band (K=${k}).`;
}

/**
 * Compares `current` (a fresh `--live` run, or the last committed report)
 * against the committed band `baseline`. Returns every problem found,
 * classified. An empty `problems` array means: the manifest matches, every
 * baseline case is covered, and both banded rates sit at or above their
 * own band floor (`>=`, not `>` — the floor is "at or above," matching how
 * a floor is meant to function).
 */
export function compareToBaseline(current: RegressionCheckInput, baseline: EvalBaseline): RegressionCheckResult {
  const problems: ComparisonProblem[] = [];

  // --- stale-baseline: the corpus moved since this band was measured -----
  if (current.manifestVersion !== baseline.manifestVersion) {
    problems.push({
      problemClass: "stale-baseline",
      message:
        `manifest version mismatch: current run used "${current.manifestVersion}", the baseline band was established from ` +
        `"${baseline.manifestVersion}" — the golden set changed shape since the band was measured. ${REBASELINE_HINT}`,
    });
  }
  if (current.manifestContentHash !== baseline.manifestContentHash) {
    problems.push({
      problemClass: "stale-baseline",
      message:
        `manifest content changed: current run's manifest hash "${current.manifestContentHash}" does not match the baseline band's ` +
        `"${baseline.manifestContentHash}" — golden-set/manifest.json's content moved since the band was measured, even if ` +
        `manifestVersion did not. ${REBASELINE_HINT}`,
    });
  }

  // --- coverage-mismatch: current run does not cover the band's cases ----
  const currentCaseIds = new Set(current.caseIds);
  const missingCases = baseline.caseIds.filter((id) => !currentCaseIds.has(id));
  if (missingCases.length > 0) {
    problems.push({
      problemClass: "coverage-mismatch",
      message:
        `coverage mismatch: current run did not include ${missingCases.length} case(s) the baseline band was measured over ` +
        `(${missingCases.join(", ")}) — run --live --full to cover the whole golden set before comparing.`,
    });
  }

  // --- accuracy-below-band: the two banded headline rates ----------------
  const bandChecks: readonly [label: string, rate: number, band: AccuracyBand][] = [
    ["extraction accuracy", current.summary.extractionAccuracy.rate, baseline.extractionAccuracyBand],
    ["cascade-verdict accuracy", current.summary.cascadeVerdictAccuracy.rate, baseline.cascadeVerdictAccuracyBand],
  ];
  for (const [label, rate, band] of bandChecks) {
    if (rate < band.min) {
      problems.push({ problemClass: "accuracy-below-band", message: formatBandLine(label, rate, band, baseline.k) });
    }
  }

  return { problems };
}

/** `true` when `result` carries at least one problem in `problemClass`. */
export function hasProblemClass(result: RegressionCheckResult, problemClass: ComparisonProblemClass): boolean {
  return result.problems.some((p) => p.problemClass === problemClass);
}
