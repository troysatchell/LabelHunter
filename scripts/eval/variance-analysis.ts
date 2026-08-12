/**
 * Pure per-case stability and cross-run accuracy-spread computation for the
 * verdict-variance runner (LH-038 / TRO-543, TH-R10 stretch, TH-R17,
 * TH-R19).
 *
 * Split from `variance.ts` for the same reason `summary.ts` and `args.ts`
 * are split from `check.ts`: this file makes no network or database call
 * and has no side effects at import time, so its own test file
 * (`variance-analysis.test.ts`) can exercise the math against synthetic
 * `VerdictCaseScore` fixtures — never a real, paid API call just to check
 * arithmetic.
 *
 * TWO QUESTIONS, kept separate on purpose (the same split `types.ts`'s own
 * module comment draws between extraction accuracy and verdict accuracy):
 *
 *   - Per-case STABILITY: across K repeats of the SAME case, how many
 *     returned the identical label verdict? `computeCaseStability` answers
 *     this for one case; `computeCorpusStability` rolls it up across every
 *     case in the sample — the "28 of 29 stable, case-17 3 REVIEW / 2 PASS"
 *     shape this ticket's own `CHANGES.md` entry reports by hand against
 *     five committed runs. This module computes the identical figure
 *     mechanically, from a live N-case x K-repeat sweep.
 *   - Cross-run ACCURACY SPREAD: across the K repeats, treating each repeat
 *     as one full pass over the N-case sample, what is the lowest and
 *     highest label-verdict accuracy any single pass produced?
 *     `computeAccuracySpread` answers this — the same shape
 *     `CHANGES.md`'s "62.1% and 65.5% on the identical 29 cases" finding
 *     (LH-021 / TRO-469 era) reports by hand for two runs.
 *
 * Neither question is "is the number right" — `verdict-scoring.ts` already
 * answers that, once, per case, per repeat. Both questions here are about
 * whether a SINGLE run's answer is the number to trust, given the model's
 * own call-to-call variance (CP-1's own words: "`temperature: 0` has never
 * guaranteed identical output," cp1:302). This file computes a measured
 * number only. It proposes no fix — LH-038's brief is explicit that the
 * deliverable is a measured number and a written statement, not a
 * mitigation (no retry, no lower temperature, no self-consistency vote).
 */
import type { LabelVerdict } from "../../src/lib/golden-set/types";
import type { ReviewReason } from "../../src/server/router/types";
import { summarize, summarizeVerdict } from "./summary";
import type { AccuracySummary, CascadeCaseResult, EvalCaseFailure, VerdictCaseScore } from "./types";

/** One case's result from one repeat of the sweep. `repeatIndex` is
 * 1-based (1..K), matching how `--repeats=<k>` is described to an
 * operator, not a 0-based array index. */
export interface RepeatedVerdict {
  readonly repeatIndex: number;
  readonly verdict: VerdictCaseScore;
}

/** Deterministic tie-break order for `computeCaseStability`'s modal-verdict
 * count — a fixed, documented order, never "whichever a `Map` iterates
 * first" (insertion order would silently depend on which verdict this
 * case's OWN repeats happened to produce first, not a stated rule). */
const VERDICT_TIE_BREAK_ORDER: readonly LabelVerdict[] = ["PASS", "FAIL", "REVIEW"];

export interface CaseStability {
  readonly caseId: string;
  /** How many repeats this case actually completed — equal to the sweep's
   * nominal K unless a repeat's real cascade run failed (see
   * `VarianceCaseFailure` below). The honest denominator; never assumed to
   * be K (standing rule: uncertain beats wrong). */
  readonly runCount: number;
  /** One label verdict per completed repeat, in `repeatIndex` order. */
  readonly verdicts: readonly LabelVerdict[];
  /** One headline reason per completed repeat, in `repeatIndex` order —
   * `null` on a repeat that returned PASS/FAIL (mirrors
   * `VerdictCaseScore.actualReviewReason`, itself `actual.headlineReason`
   * per `verdict-scoring.ts`'s `scoreVerdict`). */
  readonly headlineReasons: readonly (ReviewReason | null)[];
  readonly modalVerdict: LabelVerdict;
  readonly modalCount: number;
  /** `modalCount / runCount`, or `0` when `runCount` is `0` (the same
   * "empty population reads 0, not NaN" convention as
   * `AccuracySummary.rate`). */
  readonly stabilityRate: number;
  /** `true` exactly when every completed repeat returned the identical
   * label verdict (`modalCount === runCount`, and `runCount > 0`) — the
   * per-case predicate `computeCorpusStability`'s `stableCaseRate` counts. */
  readonly stable: boolean;
}

/**
 * Computes one case's stability across its own repeats. Pure. Throws if
 * `repeats` is empty, or if two entries share a `repeatIndex` — both are
 * caller bugs (an empty group should never have been formed;
 * `computeCorpusStability` never calls this with one — and each repeat of
 * one case gets a distinct index by construction in `variance.ts`).
 */
export function computeCaseStability(caseId: string, repeats: readonly RepeatedVerdict[]): CaseStability {
  if (repeats.length === 0) {
    throw new Error(`computeCaseStability: case "${caseId}" has zero repeats — nothing to compute stability over.`);
  }
  const seenIndices = new Set<number>();
  for (const r of repeats) {
    if (seenIndices.has(r.repeatIndex)) {
      throw new Error(`computeCaseStability: case "${caseId}" has two repeats sharing repeatIndex ${r.repeatIndex}.`);
    }
    seenIndices.add(r.repeatIndex);
  }

  const sorted = [...repeats].sort((a, b) => a.repeatIndex - b.repeatIndex);
  const verdicts = sorted.map((r) => r.verdict.actualLabelVerdict);
  const headlineReasons = sorted.map((r) => r.verdict.actualReviewReason);

  const counts = new Map<LabelVerdict, number>();
  for (const v of verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);
  let modalVerdict: LabelVerdict = VERDICT_TIE_BREAK_ORDER[0];
  let modalCount = 0;
  for (const candidate of VERDICT_TIE_BREAK_ORDER) {
    const count = counts.get(candidate) ?? 0;
    if (count > modalCount) {
      modalVerdict = candidate;
      modalCount = count;
    }
  }

  const runCount = verdicts.length;
  return {
    caseId,
    runCount,
    verdicts,
    headlineReasons,
    modalVerdict,
    modalCount,
    stabilityRate: modalCount / runCount,
    stable: modalCount === runCount,
  };
}

/**
 * Case IDs that completed every one of the `nominalRepeats` requested
 * repeats — the only cases strong enough evidence to count toward
 * `stableCaseRate` or `computeAccuracySpread` (PR review finding, TRO-543).
 * A case with fewer completed repeats than K cannot demonstrate stability
 * OR instability with the same strength a full-K case can (standing rule
 * 12: uncertain beats wrong) — it still appears in `perCase`, in full,
 * never dropped from the report, but it does not get to look like
 * equal-strength evidence in a headline rate.
 *
 * Because `computeCaseStability` already rejects a duplicate `repeatIndex`
 * for one case, a case with exactly `nominalRepeats` completed entries
 * necessarily has ONE entry at every index `1..nominalRepeats` (a
 * same-size subset of a `nominalRepeats`-element set is the whole set) —
 * so filtering `computeAccuracySpread`'s per-run population down to this
 * set is safe: every repeat index still has a score for every case in it.
 */
export function findCompleteCaseIds(byCase: ReadonlyMap<string, readonly RepeatedVerdict[]>, nominalRepeats: number): ReadonlySet<string> {
  return new Set([...byCase.entries()].filter(([, repeats]) => repeats.length === nominalRepeats).map(([caseId]) => caseId));
}

export interface VarianceCorpusSummary {
  /** One entry per distinct case, sorted by `caseId` — deterministic report
   * ordering, never insertion/Map-iteration order. Every case the sweep
   * attempted, complete or not — nothing is dropped here. */
  readonly perCase: readonly CaseStability[];
  /** count/total of cases where `CaseStability.stable` is `true`, over
   * `completeCaseIds` ONLY — the "28 of 29" shape this ticket's
   * retrospective step measured by hand. A case that did not complete
   * every requested repeat never enters this population (see
   * `findCompleteCaseIds`), so it can neither inflate nor deflate the
   * rate on partial evidence. */
  readonly stableCaseRate: AccuracySummary;
}

/** Rolls `computeCaseStability` up across every case in the sample, scoring
 * `stableCaseRate` over `completeCaseIds` only (see `findCompleteCaseIds`).
 * Pure. */
export function computeCorpusStability(
  byCase: ReadonlyMap<string, readonly RepeatedVerdict[]>,
  completeCaseIds: ReadonlySet<string>,
): VarianceCorpusSummary {
  const perCase = [...byCase.entries()]
    .map(([caseId, repeats]) => computeCaseStability(caseId, repeats))
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
  const complete = perCase.filter((c) => completeCaseIds.has(c.caseId));
  return {
    perCase,
    stableCaseRate: summarize(complete.length, complete.filter((c) => c.stable).length),
  };
}

export interface RunAccuracy {
  readonly repeatIndex: number;
  readonly labelVerdictAccuracy: AccuracySummary;
}

export interface AccuracySpread {
  /** `false` when `completeCaseIds` was empty — no case completed every
   * requested repeat, so there is no shared population to compare runs
   * over. `perRun`/`lowestRate`/`highestRate` all read as "no data" then
   * (`[]`/`null`/`null`), never a fabricated `0` that could be misread as
   * "0% accuracy" (standing rule 2: never fabricate a number). */
  readonly available: boolean;
  /** One `AccuracySummary` per repeat actually run, sorted by
   * `repeatIndex` — each treats that repeat's own pass over the SAME
   * shared complete-case population as one independent run, the same "a
   * run = one full sweep over an identical case set" framing
   * `CHANGES.md`'s two-run 62.1%/65.5% finding, and this ticket's own
   * retrospective step, both already use by hand ("restrict to the 29
   * cases present in every run"). Empty when `available` is `false`. */
  readonly perRun: readonly RunAccuracy[];
  /** Lowest `labelVerdictAccuracy.rate` across `perRun`. `null` when
   * `available` is `false`. */
  readonly lowestRate: number | null;
  /** Highest `labelVerdictAccuracy.rate` across `perRun`. `null` when
   * `available` is `false`. */
  readonly highestRate: number | null;
}

/**
 * Computes the cross-run accuracy spread: for each repeat index, one
 * label-verdict-accuracy rate over `completeCaseIds` ONLY (see
 * `findCompleteCaseIds`) — every run's accuracy is computed over the exact
 * same case population, so the spread reflects genuine run-to-run model
 * variance, never an artifact of two runs scoring different, differently
 * sized case sets (PR review finding, TRO-543). Reuses `summarizeVerdict` —
 * the same computation `check.ts`/`benchmark.ts` already trust, not a
 * second implementation. Pure.
 */
export function computeAccuracySpread(
  byRepeat: ReadonlyMap<number, readonly VerdictCaseScore[]>,
  completeCaseIds: ReadonlySet<string>,
): AccuracySpread {
  if (completeCaseIds.size === 0) {
    return { available: false, perRun: [], lowestRate: null, highestRate: null };
  }
  const perRun = [...byRepeat.entries()]
    .map(([repeatIndex, scores]) => ({
      repeatIndex,
      labelVerdictAccuracy: summarizeVerdict(scores.filter((s) => completeCaseIds.has(s.caseId))).labelVerdictAccuracy,
    }))
    .sort((a, b) => a.repeatIndex - b.repeatIndex);
  const rates = perRun.map((r) => r.labelVerdictAccuracy.rate);
  return {
    available: true,
    perRun,
    lowestRate: Math.min(...rates),
    highestRate: Math.max(...rates),
  };
}

/** One (case, repeat) pair's full cascade result — `CascadeCaseResult`
 * (the same row shape `check.ts`'s own report carries) plus which repeat
 * produced it. Never a second result shape: `runOneCase` (`cascade-runner.ts`)
 * is the only cascade path (TH-R19), and this just tags its output. */
export interface VarianceCaseRun extends CascadeCaseResult {
  readonly repeatIndex: number;
}

/** One (case, repeat) pair that failed to produce a result — `EvalCaseFailure`
 * plus which repeat failed. */
export interface VarianceCaseFailure extends EvalCaseFailure {
  readonly repeatIndex: number;
}

export interface VarianceReportSummary {
  /** N — distinct cases with at least one completed repeat. */
  readonly caseCount: number;
  /** K, as requested. A case's own `CaseStability.runCount` can be lower,
   * on a real per-repeat failure. */
  readonly nominalRepeats: number;
  /** How many of `caseCount` cases did NOT complete all `nominalRepeats`
   * repeats — the cases `stableCaseRate`/`accuracySpread` exclude from
   * their own population (see `findCompleteCaseIds`). `0` on a clean sweep
   * with no per-repeat failures; surfaced explicitly here so a partial
   * sweep's headline numbers never look more conclusive than the evidence
   * behind them (PR review finding, TRO-543). */
  readonly incompleteCaseCount: number;
  readonly stableCaseRate: AccuracySummary;
  readonly accuracySpread: AccuracySpread;
  /** Every case's own verdict/headline-reason sequence, modal verdict, and
   * stability rate — LH-038's brief, Do item 4: "for each case record all
   * K verdicts and all K headline reasons, the modal verdict, and a
   * stability rate." Every case the sweep attempted, complete or not
   * (never filtered by `completeCaseIds` — see `CaseStability`'s own doc
   * comment). Sorted by `caseId`. */
  readonly perCase: readonly CaseStability[];
}

/** The committed evidence artifact `pnpm eval:variance -- --live` writes
 * (`scripts/eval/results/variance-report.json`) — LH-038 / TRO-543's
 * equivalent of `EvalReport` (`types.ts`), following the same discipline:
 * real measured costs, an explicit `measuredAt`, exact model IDs, and every
 * case ID the sweep actually ran. */
export interface VarianceReport {
  readonly ticket: string;
  readonly measuredAt: string;
  readonly mode: "live";
  readonly haikuModel: string;
  readonly sonnetModel: string;
  readonly manifestVersion: string;
  /**
   * SHA-256 of `golden-set/manifest.json`'s raw bytes, once TRO-538 /
   * LH-033's `scripts/eval/manifest-hash.ts` lands on `main`. `null` until
   * then — that module does not exist on this branch yet (LH-038's own
   * brief says so explicitly). TODO(TRO-538 / LH-033): once it lands, wire
   * `hashManifestFile(DEFAULT_MANIFEST_PATH)` into `variance.ts` and drop
   * this comment. An absent hash is never a reason to block or fail this
   * report — it means one less staleness check available on a future
   * baseline-style comparison, not a defect in this run.
   */
  readonly manifestContentHash: string | null;
  /** This worktree's `git rev-parse HEAD` at measurement time — provenance
   * for "what code produced this report." A variance report has no
   * committed baseline to diff against (unlike `EvalReport`), so this is
   * its own record of the code version, not borrowed from one. */
  readonly commitSha: string;
  readonly requestedFull: boolean;
  /** Distinct case IDs the sweep attempted, sorted — N. */
  readonly caseIds: string[];
  /** K, as requested via `--repeats=<k>` (or the default). */
  readonly repeats: number;
  readonly summary: VarianceReportSummary;
  /** Real, summed cost across every repeat of every case that actually
   * ran — Haiku always, Sonnet only for the repeats the router escalated. */
  readonly totalCostUsd: number;
  /** One entry per (case, repeat) that completed — up to
   * `caseIds.length * repeats` entries. */
  readonly runs: readonly VarianceCaseRun[];
  readonly failures: readonly VarianceCaseFailure[];
}

export interface BuildVarianceReportInput {
  readonly ticket: string;
  readonly measuredAt: string;
  readonly haikuModel: string;
  readonly sonnetModel: string;
  readonly manifestVersion: string;
  readonly manifestContentHash: string | null;
  readonly commitSha: string;
  readonly requestedFull: boolean;
  /** Case IDs as requested (any order) — `buildVarianceReport` sorts them. */
  readonly caseIds: readonly string[];
  readonly repeats: number;
  readonly runs: readonly VarianceCaseRun[];
  readonly failures: readonly VarianceCaseFailure[];
}

/**
 * Assembles a full `VarianceReport` from one sweep's collected runs and
 * failures — groups `runs` by case (for `computeCorpusStability`) and by
 * repeat index (for `computeAccuracySpread`), then combines both with the
 * real measured costs. Pure — `variance.ts` is the only caller that
 * performs I/O; this function never does.
 */
export function buildVarianceReport(input: BuildVarianceReportInput): VarianceReport {
  const byCase = new Map<string, RepeatedVerdict[]>();
  const byRepeat = new Map<number, VerdictCaseScore[]>();
  for (const run of input.runs) {
    const caseRepeats = byCase.get(run.caseId) ?? [];
    caseRepeats.push({ repeatIndex: run.repeatIndex, verdict: run.verdict });
    byCase.set(run.caseId, caseRepeats);

    const repeatScores = byRepeat.get(run.repeatIndex) ?? [];
    repeatScores.push(run.verdict);
    byRepeat.set(run.repeatIndex, repeatScores);
  }

  const completeCaseIds = findCompleteCaseIds(byCase, input.repeats);
  const corpusStability = computeCorpusStability(byCase, completeCaseIds);
  const accuracySpread = computeAccuracySpread(byRepeat, completeCaseIds);
  const totalCostUsd = input.runs.reduce((sum, r) => sum + r.haikuCost.usd + (r.resolverCost?.usd ?? 0), 0);

  return {
    ticket: input.ticket,
    measuredAt: input.measuredAt,
    mode: "live",
    haikuModel: input.haikuModel,
    sonnetModel: input.sonnetModel,
    manifestVersion: input.manifestVersion,
    manifestContentHash: input.manifestContentHash,
    commitSha: input.commitSha,
    requestedFull: input.requestedFull,
    caseIds: [...input.caseIds].sort(),
    repeats: input.repeats,
    summary: {
      caseCount: byCase.size,
      nominalRepeats: input.repeats,
      incompleteCaseCount: byCase.size - completeCaseIds.size,
      stableCaseRate: corpusStability.stableCaseRate,
      accuracySpread,
      perCase: corpusStability.perCase,
    },
    totalCostUsd,
    runs: input.runs,
    failures: input.failures,
  };
}
