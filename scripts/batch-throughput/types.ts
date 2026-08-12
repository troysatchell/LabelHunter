/**
 * The committed evidence artifact `pnpm batch:throughput` writes
 * (`scripts/batch-throughput/results/local-batch-run.json`) — this
 * ticket's (TRO-544 / LH-039) equivalent of `scripts/eval/types.ts`'s
 * `EvalReport` and `scripts/latency/measure.ts`'s own `HarnessReport`.
 * Same discipline as both: every figure below is either directly OBSERVED
 * from a real run (a call succeeded, a database row said X) or explicitly
 * DERIVED (and from what) — never a flat guess (CLAUDE.md: "never
 * fabricate a number").
 */

export interface BatchThroughputMachineInfo {
  readonly platform: string;
  readonly arch: string;
  readonly cpuModel: string | null;
  readonly cpuCount: number;
  readonly nodeVersion: string;
}

export interface BatchThroughputWorkerConcurrency {
  readonly extract: number;
  readonly resolve: number;
  readonly singleLabelResolve: number;
  /** Whether these numbers came from this script's own environment
   * variables (an override was set) or are the documented defaults in
   * `scripts/batch-worker/run.ts` — this script cannot directly observe
   * the WORKER process's own concurrency; it reports what its own
   * environment says, which is only as trustworthy as "both processes
   * were started from the same sourced shell." Recorded plainly so a
   * reader can judge that for themselves. */
  readonly source: "environment override" | "scripts/batch-worker/run.ts defaults";
}

/** Every input to the derived cost total, so a reader can recompute it by
 * hand from the numbers alone, without re-running anything. */
export interface BatchThroughputCost {
  readonly haikuCallCount: number;
  readonly haikuMeanCostUsd: number;
  readonly sonnetCallCount: number;
  readonly sonnetMeanCostUsd: number;
  /** `(haikuCallCount * haikuMeanCostUsd) + (sonnetCallCount * sonnetMeanCostUsd)`
   * — DERIVED, not measured. See `cost.ts`'s own header comment for why no
   * per-call figure exists for a real batch run today. */
  readonly derivedTotalUsd: number;
  /** Where `haikuMeanCostUsd`/`sonnetMeanCostUsd` came from, and that
   * file's own `measuredAt` — so a reader can tell whether a newer eval
   * run has since moved these means. */
  readonly meanCostSource: { readonly file: string; readonly measuredAt: string };
}

export interface BatchThroughputEscalationCap {
  /** `ceil(0.25 * totalCount)` — `computeSonnetCallCapThreshold`,
   * `src/server/batch-queue/escalation-cap.ts` (CP-3 §6.1). */
  readonly capThreshold: number;
  readonly sonnetCallCount: number;
  /** `sonnetCallCount >= capThreshold` — whether THIS run actually hit the
   * cap. A batch that hits the cap has a different throughput profile
   * (some labels route straight to `needsHumanCount` with no Sonnet call
   * at all) from one that never approaches it. */
  readonly capHit: boolean;
}

export interface BatchThroughputDispositionMix {
  readonly autoVerifiedCount: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly resolvedBySonnetCount: number;
  readonly needsHumanCount: number;
  readonly failedCount: number;
}

export interface BatchThroughputFigures {
  readonly itemsPerMinute: number;
  readonly avgMsPerItem: number;
}

export interface BatchThroughputRunReport {
  readonly ticket: string;
  readonly measuredAt: string;
  /** Stated plainly, everywhere this artifact's numbers get quoted
   * (CLAUDE.md non-negotiable: never quote a local-workstation rate as a
   * deployed one). Literal string, not a free-text field, so a reader
   * cannot mistake this for a value that varies run to run. */
  readonly deployment: "local dev workstation, not deployed";
  readonly baseUrl: string;
  readonly haikuModel: string;
  readonly sonnetModel: string;
  readonly machine: BatchThroughputMachineInfo;
  readonly workerConcurrency: BatchThroughputWorkerConcurrency;
  readonly fixture: { readonly source: string; readonly itemCount: number };
  readonly batchJobId: number;
  readonly totalCount: number;
  readonly processedCount: number;
  readonly startedAt: string;
  readonly completedAt: string;
  /** Read straight off this run's own `GET /api/batch/:id` response —
   * the SAME `computeBatchThroughput` output the product's batch-results
   * screen shows, not a value this script recomputed independently
   * (`get-batch-progress.ts`, `../../src/lib/utils/batch-throughput.ts`). */
  readonly throughput: BatchThroughputFigures;
  readonly dispositionMix: BatchThroughputDispositionMix;
  /** `0..1` fraction, also read straight off the API response. */
  readonly autoVerifiedShare: number;
  readonly escalationCap: BatchThroughputEscalationCap;
  readonly cost: BatchThroughputCost;
  /** Free-text provenance notes — what was observed vs. derived, and
   * anything a reader should know before quoting a number from this file
   * (CLAUDE.md: "claims carry provenance"). */
  readonly notes: readonly string[];
}
