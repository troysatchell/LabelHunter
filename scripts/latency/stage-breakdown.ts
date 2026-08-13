/**
 * Rolls per-run `Server-Timing` samples into a per-stage latency summary
 * (TRO-539). Split out from `measure.ts` for the same reason `args.ts`,
 * `cleanup.ts`, `exit-status.ts`, and `response.ts` are: `measure.ts`
 * calls `main()` unconditionally at module scope (a real, live, paid API
 * call per run), so a test importing it would spend real money just to
 * load the module. Pure — no I/O, no clock — cheap to unit test directly.
 *
 * Only a SUCCESSFUL run's own timing samples ever contribute. A failed or
 * malformed-body run's own duration is not a real "this stage took N ms"
 * sample no matter what a response header on it might say — today's
 * `route.ts` never attaches `Server-Timing` to a non-200 response, so this
 * is unreachable against this repo's own route, but `--url` mode can point
 * at ANY server: a different deployed version, a proxy that adds its own
 * timing headers to every response including error ones, or a future
 * `route.ts` bug. This function makes "successful runs only" structural,
 * not just true by the current route's own behavior (CodeRabbit local
 * review round 1, major) — the same discipline `main`'s own `summaryMs`
 * already applies by filtering to `runResults.filter((r) => r.ok)` before
 * computing the overall p50/p95.
 */
import { SERVER_TIMING_STAGES, type ServerTimingStage, type StageTimingsMs } from "../../src/app/api/verify/server-timing";
import { summarizeLatencies, type LatencySummary } from "./percentile";

/** The minimal shape this function needs from a harness run result —
 * deliberately narrower than `measure.ts`'s own `RunResult` so this
 * module does not need to import (or duplicate) that interface. */
export interface StageBreakdownInput {
  ok: boolean;
  serverTimingMs?: Partial<StageTimingsMs>;
}

/**
 * Returns a per-stage `LatencySummary` for every stage with at least one
 * sample from a successful run, or `null` if no successful run carried
 * any `serverTimingMs` at all (every in-process run before this ticket;
 * a `--url` run against a target that never sent the header).
 */
export function buildStageBreakdown(
  runs: readonly StageBreakdownInput[],
): Partial<Record<ServerTimingStage, LatencySummary>> | null {
  const samplesMs: Partial<Record<ServerTimingStage, number[]>> = {};
  for (const run of runs) {
    if (!run.ok || !run.serverTimingMs) continue;
    for (const stage of SERVER_TIMING_STAGES) {
      const value = run.serverTimingMs[stage];
      if (value !== undefined) {
        (samplesMs[stage] ??= []).push(value);
      }
    }
  }
  if (Object.keys(samplesMs).length === 0) return null;
  return SERVER_TIMING_STAGES.reduce<Partial<Record<ServerTimingStage, LatencySummary>>>((acc, stage) => {
    const samples = samplesMs[stage];
    if (samples && samples.length > 0) acc[stage] = summarizeLatencies(samples);
    return acc;
  }, {});
}
