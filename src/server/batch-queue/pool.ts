/**
 * The worker pool loop (LH-041 / TRO-474, CP-3 §4, §5.3). Drives
 * `claimNextBatchQueueItem` in a real concurrent loop — never
 * `for (const item of items) { await process(item) }` — and coordinates a
 * whole-pool cooldown on top of each item's own backoff (§5.3).
 *
 * This module is deliberately thin: `claim.ts`/`complete.ts` already prove
 * the concurrency-correctness guarantees against a real database, and
 * `extract-worker.ts`/`resolve-worker.ts` already prove the per-item
 * processing logic. `pool.ts` only wires "claim, process, idle-sleep,
 * cooldown-check" into a loop that runs until `stop()`.
 *
 * **Single-process assumption (CP-3 §5.3).** The cooldown state below is
 * an in-memory object shared by every loop THIS pool starts — it
 * coordinates async tasks inside one Node process, nothing across two
 * separate deployed worker processes. PRD §3.6 names one background
 * worker process, singular, which is the deployment this fits. A future
 * multi-process deployment would need the cooldown signal moved
 * somewhere every process can see (CP-3 §5.3 names the fork explicitly).
 */
import { db as defaultDb } from "../../lib/db";
import type { BatchQueueItemKind } from "../../lib/db/enums";
import { claimNextBatchQueueItem, type ClaimedBatchQueueItem } from "./claim";
import { DEFAULT_POOL_COOLDOWN_MS, noteRateLimited, waitMsForCooldown, type PoolCooldownState } from "./backoff";

/** The minimal shape `pool.ts` needs from a claim-processing outcome —
 * both `ExtractClaimOutcome` and `ResolveClaimOutcome` satisfy this
 * structurally, without either module importing from `pool.ts`. */
export interface MinimalClaimOutcome {
  kind: string;
  /** Present (and meaningful) only when `kind === "retry"`. */
  isRateLimit?: boolean;
  /** Present (and meaningful) only when `kind === "retry"` (TRO-566). A
   * daily-budget refusal is a POOL-WIDE condition — every worker in this
   * pool reads the SAME ledger — so it engages the SAME whole-pool
   * cooldown a rate limit does, via this distinct flag. Never conflated
   * with `isRateLimit`, which stays specifically "a real 429 happened"
   * (`../budget/daily-budget.ts`'s `BudgetExhaustedError`,
   * `backoff.ts`'s `classifyModelCallError`). */
  isBudgetExhausted?: boolean;
  delayMs?: number;
}

export interface WorkerPoolConfig {
  db: typeof defaultDb;
  kind: BatchQueueItemKind;
  /** Number of concurrent claim+process loops (CP-3 §4.4/§4.5 — proposed
   * defaults 5 for EXTRACT, 2 for RESOLVE, both environment-variable
   * driven at the entry-point layer, not hard-coded here). */
  concurrency: number;
  leaseSeconds: number;
  /** Prefix for each loop's own `claimed_by` id — combined with `kind` and
   * a loop index for uniqueness across pools in the same process. */
  workerIdPrefix: string;
  /** How long an idle loop (no item available, or waiting out a cooldown)
   * sleeps before polling again. */
  pollIntervalMs: number;
  processClaim: (item: ClaimedBatchQueueItem) => Promise<MinimalClaimOutcome>;
  /** Test-only — see `claim.ts`'s own `ClaimNextBatchQueueItemOptions` doc
   * comment. Never set by the real entry point. */
  scopeToBatchJobId?: number;
  /** Test-only override for this loop's own error backoff
   * (`computeLoopErrorBackoffMs`) — lets a test prove escalation across
   * several consecutive failures without waiting out the real
   * `LOOP_ERROR_BASE_BACKOFF_MS`/`LOOP_ERROR_MAX_BACKOFF_MS` values for
   * real. Never set by the real entry point. */
  loopErrorBackoff?: LoopErrorBackoffConfig;
  /** Called with a loop's own uncaught error (e.g. a lost database
   * connection) — the loop itself never dies from one; it logs (via this
   * hook, defaulting to `console.error`) and keeps going after a short
   * backoff. `consecutiveErrors` is this loop's own running count AFTER
   * this error (the value `computeLoopErrorBackoffMs` is about to use) —
   * exposed mainly so a test can observe the escalation sequence directly
   * instead of measuring real elapsed time between sleeps. */
  onLoopError?: (error: unknown, workerId: string, consecutiveErrors: number) => void;
}

export interface WorkerPoolHandle {
  /** Signals every loop to stop after its CURRENT iteration — never
   * interrupts an in-flight claim+process cycle. Idempotent. */
  stop: () => void;
  /** Resolves once every loop has actually exited after `stop()`. */
  done: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Proposed, not measured — this loop's OWN error backoff, distinct from
 * both the per-item backoff (`backoff.ts`'s `computeBackoffDelayMs`, owned
 * by the extract/resolve workers) and the rate-limit cooldown
 * (`noteRateLimited`). A `claimNextBatchQueueItem` call or an uncaught
 * throw from `processClaim` is a loop-level problem (a DB connectivity
 * blip, a bug) that this loop does not otherwise account for. Escalating
 * with consecutive failures — a one-off blip stays cheap (1s), a sustained
 * outage backs off further (up to 30s) instead of hammering an already-
 * failing dependency every `pollIntervalMs` — and resetting the moment a
 * claim attempt succeeds again keeps a transient blip from leaving a loop
 * needlessly slow afterward.
 */
export const LOOP_ERROR_BASE_BACKOFF_MS = 1000;
export const LOOP_ERROR_MAX_BACKOFF_MS = 30_000;

export interface LoopErrorBackoffConfig {
  baseMs: number;
  maxMs: number;
}

const DEFAULT_LOOP_ERROR_BACKOFF: LoopErrorBackoffConfig = { baseMs: LOOP_ERROR_BASE_BACKOFF_MS, maxMs: LOOP_ERROR_MAX_BACKOFF_MS };

export function computeLoopErrorBackoffMs(consecutiveErrors: number, config: LoopErrorBackoffConfig = DEFAULT_LOOP_ERROR_BACKOFF): number {
  return Math.min(config.baseMs * 2 ** (consecutiveErrors - 1), config.maxMs);
}

/** Starts `config.concurrency` concurrent claim+process loops for one
 * queue `kind`, sharing one pool-wide cooldown coordinator (CP-3 §5.3). */
export function startWorkerPool(config: WorkerPoolConfig): WorkerPoolHandle {
  // Standing rule 13: validate at the boundary, before any loop starts —
  // a bad value here is a caller bug (a misconfigured env var at the
  // entry-point layer, CP-3 §4.4/§4.5), not something that should surface
  // later as an inscrutable claim/sleep failure deep inside a loop.
  if (!Number.isInteger(config.concurrency) || config.concurrency <= 0) {
    throw new RangeError(`startWorkerPool: concurrency must be a positive integer, got ${config.concurrency}`);
  }
  if (!Number.isFinite(config.leaseSeconds) || config.leaseSeconds <= 0) {
    throw new RangeError(`startWorkerPool: leaseSeconds must be a finite number > 0, got ${config.leaseSeconds}`);
  }
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
    throw new RangeError(`startWorkerPool: pollIntervalMs must be a finite number > 0, got ${config.pollIntervalMs}`);
  }

  const cooldown: PoolCooldownState = { cooldownUntilMs: 0 };
  let stopped = false;
  const onLoopError = config.onLoopError ?? ((error, workerId) => console.error(`[batch-queue] worker ${workerId} loop error:`, error));

  async function runLoop(index: number): Promise<void> {
    const workerId = `${config.workerIdPrefix}-${config.kind}-${index}`;
    let consecutiveErrors = 0;
    while (!stopped) {
      try {
        const cooldownWaitMs = waitMsForCooldown(cooldown, Date.now());
        if (cooldownWaitMs > 0) {
          await sleep(Math.min(cooldownWaitMs, config.pollIntervalMs));
          continue;
        }

        const item = await claimNextBatchQueueItem(config.db, config.kind, workerId, config.leaseSeconds, {
          scopeToBatchJobId: config.scopeToBatchJobId,
        });
        if (!item) {
          consecutiveErrors = 0; // the claim path itself is healthy again
          await sleep(config.pollIntervalMs);
          continue;
        }

        // The worker never sleeps holding the claim (CP-3 §5.2) — process,
        // then immediately loop to claim the next item. A retryable
        // failure already released the item back to PENDING with its own
        // delay (extract-worker.ts/resolve-worker.ts); this loop does not
        // wait on that delay itself, it just moves on.
        const outcome = await config.processClaim(item);
        // Reset only once a FULL claim+process cycle finished without
        // throwing — not right after the claim itself. Resetting earlier
        // (the original bug) meant a `processClaim` that throws on every
        // single attempt never actually escalated: the reset ran before
        // `processClaim` had a chance to fail, so the catch block below
        // always incremented from 0, landing on 1 forever instead of
        // climbing 1, 2, 3, ... A "retry"/"failed" outcome is a NORMAL
        // per-item result, not a loop-level error — it still resets this.
        consecutiveErrors = 0;
        // TRO-566: a budget-exhausted refusal pauses the whole pool the
        // same way a rate limit does — see MinimalClaimOutcome's own
        // comment on isBudgetExhausted for why the two flags stay distinct
        // rather than one covering both.
        if (outcome.kind === "retry" && (outcome.isRateLimit || outcome.isBudgetExhausted)) {
          noteRateLimited(cooldown, outcome.delayMs ?? DEFAULT_POOL_COOLDOWN_MS, Date.now());
        }
      } catch (error) {
        consecutiveErrors += 1;
        onLoopError(error, workerId, consecutiveErrors);
        // A DB blip or an unexpected throw from processClaim must not
        // spin this loop hot forever — an escalating pause, distinct from
        // the item-level backoff this loop does not own.
        await sleep(computeLoopErrorBackoffMs(consecutiveErrors, config.loopErrorBackoff));
      }
    }
  }

  const loops = Array.from({ length: config.concurrency }, (_, i) => runLoop(i));

  return {
    stop: () => {
      stopped = true;
    },
    done: Promise.all(loops).then(() => undefined),
  };
}
