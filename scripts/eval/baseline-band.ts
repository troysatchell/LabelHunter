/**
 * Pure construction of the band baseline artifact and its paired refreshed
 * `eval-report.json`, both from ONE already-run variance sweep (TRO-561's
 * re-baseline protocol). Split from `variance.ts` for the same reason
 * `variance-analysis.ts` is split from it: no network or database call, no
 * side effects at import time, so `baseline-band.test.ts` can exercise this
 * arithmetic against synthetic fixtures — never a real, paid API call just
 * to check it.
 *
 * REUSES THE SWEEP'S OWN DATA, NOT A SECOND CASCADE PATH. Every function
 * here consumes `VarianceCaseRun[]` — the exact rows `variance.ts`'s
 * `runLive` already collected from `runOneCase` (`cascade-runner.ts`) for
 * `variance-report.json`. Establishing a baseline band costs nothing beyond
 * the one sweep TRO-561's brief authorizes; `check.ts`'s own committed
 * `eval-report.json` is refreshed from the SAME sweep's repeat 1, not a
 * second live `--live --full` run (`check.ts`'s own module comment: a live
 * sweep costs real money on purpose, so only one is authorized per
 * re-baseline).
 */
import type { LabelVerdict } from "../../src/lib/golden-set/types";
import { buildEvalReportSummary, summarizeExtraction, summarizeVerdict } from "./summary";
import type { AccuracyBand, BaselineRepeatAccuracy, CascadeCaseResult, EvalBaseline, EvalReport } from "./types";
import type { CaseStability, VarianceCaseRun } from "./variance-analysis";

/** Same tie-break/display order as `variance-analysis.ts`'s own
 * `VERDICT_TIE_BREAK_ORDER` — kept as a separate constant (not imported)
 * because that one is private to `variance-analysis.ts` and this file's use
 * (sorting a per-case DISTINCT-verdict set for display) is a different
 * question than its modal-count tie-break. */
const VERDICT_DISPLAY_ORDER: readonly LabelVerdict[] = ["PASS", "FAIL", "REVIEW"];

/** `max - min` over `rates`, both ends included in the band. Throws on an
 * empty input — a band needs at least one repeat's accuracy to measure a
 * range from; an empty array is a caller bug (see this file's own
 * `computeBaselineRepeats`, which only ever returns one entry per repeat
 * that produced at least one complete-case score). */
export function computeAccuracyBand(rates: readonly number[]): AccuracyBand {
  if (rates.length === 0) {
    throw new Error("computeAccuracyBand: no rates to band — need at least one repeat's accuracy.");
  }
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  return { min, max, spread: max - min };
}

/**
 * Groups `runs` by `repeatIndex`, restricted to `completeCaseIds` (the same
 * "only a case that finished every requested repeat counts as equal-
 * strength evidence" discipline `variance-analysis.ts`'s own
 * `findCompleteCaseIds` already established for `accuracySpread`), and
 * summarizes each repeat's own extraction accuracy and cascade-verdict
 * accuracy via `summary.ts`'s existing aggregators — never a second
 * accuracy computation. Returns one entry per repeat that has at least one
 * qualifying run, sorted by `repeatIndex`.
 */
export function computeBaselineRepeats(
  runs: readonly VarianceCaseRun[],
  completeCaseIds: ReadonlySet<string>,
): BaselineRepeatAccuracy[] {
  const byRepeat = new Map<number, VarianceCaseRun[]>();
  for (const run of runs) {
    if (!completeCaseIds.has(run.caseId)) continue;
    const arr = byRepeat.get(run.repeatIndex) ?? [];
    arr.push(run);
    byRepeat.set(run.repeatIndex, arr);
  }
  return [...byRepeat.entries()]
    .map(([repeatIndex, repeatRuns]) => ({
      repeatIndex,
      extractionAccuracy: summarizeExtraction(repeatRuns.map((r) => r.extraction)).overall,
      cascadeVerdictAccuracy: summarizeVerdict(repeatRuns.map((r) => r.cascadeVerdict)).labelVerdictAccuracy,
    }))
    .sort((a, b) => a.repeatIndex - b.repeatIndex);
}

/** One entry per `perCase` row, mapping `caseId` to the DISTINCT label
 * verdicts observed across its own repeats, in `VERDICT_DISPLAY_ORDER` —
 * deterministic, never `Set` iteration order. Includes every case the
 * sweep attempted, complete or not (the same "nothing dropped" convention
 * `CaseStability`'s own doc comment states) — this is reported evidence,
 * not a gated population. */
export function buildPerCaseVerdictSets(perCase: readonly CaseStability[]): Record<string, LabelVerdict[]> {
  const result: Record<string, LabelVerdict[]> = {};
  for (const c of perCase) {
    const distinct = new Set(c.verdicts);
    result[c.caseId] = VERDICT_DISPLAY_ORDER.filter((v) => distinct.has(v));
  }
  return result;
}

export interface BuildBaselineBandInput {
  readonly ticket: string;
  readonly establishedAt: string;
  readonly manifestVersion: string;
  readonly manifestContentHash: string;
  readonly goldenSetCommitSha: string;
  readonly codeCommitSha: string;
  readonly haikuModel: string;
  readonly sonnetModel: string;
  readonly caseIds: readonly string[];
  readonly repeats: readonly BaselineRepeatAccuracy[];
  readonly perCaseVerdictSets: Readonly<Record<string, readonly LabelVerdict[]>>;
  readonly totalCostUsd: number;
  readonly meanHaikuCallUsd: number;
  readonly meanSonnetCallUsd: number | null;
}

/** Assembles the full band `EvalBaseline` (`types.ts`) from one sweep's
 * already-computed per-repeat accuracies. Pure — `variance.ts` is the only
 * caller that performs I/O (archiving the old baseline, writing this one). */
export function buildBaselineBand(input: BuildBaselineBandInput): EvalBaseline {
  if (input.repeats.length === 0) {
    throw new Error("buildBaselineBand: no complete repeats to build a band from — every case failed at least one repeat.");
  }
  return {
    ticket: input.ticket,
    establishedAt: input.establishedAt,
    k: input.repeats.length,
    repeats: input.repeats,
    extractionAccuracyBand: computeAccuracyBand(input.repeats.map((r) => r.extractionAccuracy.rate)),
    cascadeVerdictAccuracyBand: computeAccuracyBand(input.repeats.map((r) => r.cascadeVerdictAccuracy.rate)),
    perCaseVerdictSets: input.perCaseVerdictSets,
    manifestVersion: input.manifestVersion,
    manifestContentHash: input.manifestContentHash,
    goldenSetCommitSha: input.goldenSetCommitSha,
    caseIds: [...input.caseIds].sort(),
    haikuModel: input.haikuModel,
    sonnetModel: input.sonnetModel,
    codeCommitSha: input.codeCommitSha,
    costUsd: {
      totalUsd: input.totalCostUsd,
      meanHaikuCallUsd: input.meanHaikuCallUsd,
      meanSonnetCallUsd: input.meanSonnetCallUsd,
    },
  };
}

export interface BuildEvalReportFromRepeatInput {
  readonly ticket: string;
  readonly measuredAt: string;
  readonly haikuModel: string;
  readonly sonnetModel: string;
  readonly manifestVersion: string;
  readonly manifestContentHash: string;
  readonly requestedFull: boolean;
  readonly repeatIndex: number;
  /** The full sweep's runs, every repeat — filtered to `repeatIndex`
   * inside this function. */
  readonly runs: readonly VarianceCaseRun[];
}

/**
 * Refreshes `eval-report.json`'s shape (`EvalReport`, `types.ts`) from ONE
 * repeat of an already-run variance sweep — see this file's own module
 * comment for why this avoids a second paid live run. `repeatIndex` is a
 * fixed, arbitrary-but-documented choice (`variance.ts` always passes `1`):
 * every repeat is an equally valid draw from the same measured band, and
 * `eval-report.json`'s own contract (`types.ts`) is "one run's real
 * numbers," so it needs exactly one, not an average across K.
 */
export function buildEvalReportFromRepeat(input: BuildEvalReportFromRepeatInput): EvalReport {
  const repeatRuns = input.runs.filter((r) => r.repeatIndex === input.repeatIndex);
  if (repeatRuns.length === 0) {
    throw new Error(`buildEvalReportFromRepeat: no runs found for repeatIndex ${input.repeatIndex}.`);
  }
  const cases: CascadeCaseResult[] = repeatRuns.map(({ repeatIndex: _repeatIndex, ...rest }) => rest);
  const summary = buildEvalReportSummary(
    cases.map((c) => c.extraction),
    cases.map((c) => c.routerVerdict),
    cases.map((c) => c.cascadeVerdict),
  );
  const totalCostUsd = cases.reduce((sum, c) => sum + c.haikuCost.usd + (c.resolverCost?.usd ?? 0), 0);
  return {
    ticket: input.ticket,
    measuredAt: input.measuredAt,
    mode: "live",
    haikuModel: input.haikuModel,
    sonnetModel: input.sonnetModel,
    manifestVersion: input.manifestVersion,
    manifestContentHash: input.manifestContentHash,
    caseIds: cases.map((c) => c.caseId).sort(),
    requestedFull: input.requestedFull,
    summary,
    cases,
    totalCostUsd,
    failures: [],
  };
}
