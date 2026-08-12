/**
 * The batch worker process entry point (LH-041 / TRO-474, PRD §3.6's
 * "background worker" process; CP-3 §4.5's two-separate-pools design).
 *
 * Run with `pnpm worker`. Starts THREE independent claim+process loops —
 * 5 extract-workers, 2 resolve-workers (both proposed defaults, CP-3 §4.4,
 * §12 open question 1), and 1 single-label resolve-worker (TRO-511, CP-3
 * §9/§12 open question 5) — all in this SAME process, matching PRD §3.6's
 * "background worker" naming: singular. Keeps running until
 * `SIGINT`/`SIGTERM`.
 *
 * `BATCH_WORKER_CONCURRENCY` (extract pool size, default 5),
 * `BATCH_RESOLVE_WORKER_CONCURRENCY` (resolve pool size, default 2), and
 * `SINGLE_LABEL_RESOLVE_WORKER_CONCURRENCY` (default 1 — single-label
 * REVIEW volume is interactive-triggered, not batch-scale; see
 * `src/server/single-label-resolve/worker.ts`'s own doc comment on why a
 * pool-wide rate-limit cooldown is deliberately not built for this one)
 * are environment variables, not hard-coded constants — CP-3 §4.4's own
 * finding: this project's real deployed Anthropic key may sit in an
 * unquantified, below-Start-tier "Evaluation" bracket, so the one lever
 * available to correct a wrong default is a config change, not a
 * redeploy (CP-3 §12 open question 4's own recommendation, adopted here).
 *
 * Reuses `../../src/lib/db`'s own hardened, singleton `pg.Pool` (the error
 * listener that stops a dropped idle connection from crashing the process)
 * rather than opening a second one — this is a long-running process, the
 * shape that pool was built for, unlike a one-shot script that opens and
 * closes its own (lessons.md #22).
 *
 * What this does NOT do: wire a Render `render.yaml` worker service to
 * this command — that is LH-060's job (`factory/config.yaml`:
 * "deploy: render via render.yaml — PLANNED, lands with LH-060"), not
 * this ticket's. It also does not run CP-1 §7.3's warm-up request or flip
 * a batch to `RUNNING` — `lifecycle.ts`'s `startBatchJob` is the hook a
 * future batch-creation caller (LH-040/LH-042) uses for that; this process
 * only ever claims from batches already `RUNNING` (for the two batch
 * pools) or from single-label-originated `review_queue` rows (for the
 * third).
 */
import { db } from "../../src/lib/db";
import { DEFAULT_BACKOFF_CONFIG } from "../../src/server/batch-queue/backoff";
import { processExtractClaim } from "../../src/server/batch-queue/extract-worker";
import { startWorkerPool, type WorkerPoolHandle } from "../../src/server/batch-queue/pool";
import { processResolveClaim } from "../../src/server/batch-queue/resolve-worker";
import { productionComparators } from "../../src/server/comparators";
import { readLabelImage } from "../../src/server/storage/local-file-storage";
import { startSingleLabelResolveWorker, type SingleLabelResolveWorkerHandle } from "../../src/server/single-label-resolve";

/** Proposed, not measured (CP-3 §3.2) — generous multiples of the
 * extractor's/resolver's own target call durations (PRD §3.8). The
 * single-label resolve worker reuses the SAME lease as the batch RESOLVE
 * pool — it runs the identical kind of call (one Sonnet resolution). */
const EXTRACT_LEASE_SECONDS = 60;
const RESOLVE_LEASE_SECONDS = 120;

/** How long an idle loop waits before polling again. Not a CP-3-named
 * value — short enough that a newly-available item is picked up quickly,
 * long enough that an empty queue does not spin the database with
 * constant claim attempts. */
const POLL_INTERVAL_MS = 2000;

/** How long shutdown waits for both pools to drain their CURRENT
 * claim+process cycle before giving up and forcing exit (proposed, not
 * measured). CP-3 §5.2: a worker never sleeps holding a claim, but ONE
 * in-flight model call can still take a while — generous enough to let a
 * normal call finish, short enough that a genuinely stuck loop does not
 * hang a deploy's shutdown forever. Environment-variable driven for the
 * same reason BATCH_WORKER_CONCURRENCY is (CP-3 §4.4): the right number
 * depends on real deployed latency this ticket has not measured yet. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    console.warn(`[batch-worker] ${name}=${JSON.stringify(raw)} is not a positive integer — using the default (${fallback}).`);
    return fallback;
  }
  return parsed;
}

function main(): void {
  const extractConcurrency = envPositiveInt("BATCH_WORKER_CONCURRENCY", 5);
  const resolveConcurrency = envPositiveInt("BATCH_RESOLVE_WORKER_CONCURRENCY", 2);
  const singleLabelResolveConcurrency = envPositiveInt("SINGLE_LABEL_RESOLVE_WORKER_CONCURRENCY", 1);
  const shutdownTimeoutMs = envPositiveInt("BATCH_WORKER_SHUTDOWN_TIMEOUT_MS", DEFAULT_SHUTDOWN_TIMEOUT_MS);
  const workerIdPrefix = `${process.pid}`;

  console.log(
    `[batch-worker] starting — ${extractConcurrency} extract worker(s), ${resolveConcurrency} resolve worker(s), ` +
      `${singleLabelResolveConcurrency} single-label resolve worker(s) (pid ${process.pid})`,
  );

  const extractPool: WorkerPoolHandle = startWorkerPool({
    db,
    kind: "EXTRACT",
    concurrency: extractConcurrency,
    leaseSeconds: EXTRACT_LEASE_SECONDS,
    workerIdPrefix,
    pollIntervalMs: POLL_INTERVAL_MS,
    processClaim: (item) =>
      processExtractClaim(item, {
        db,
        comparators: productionComparators,
        readLabelImage,
        backoffConfig: DEFAULT_BACKOFF_CONFIG,
      }),
    onLoopError: (error, workerId) => console.error(`[batch-worker] ${workerId} error:`, error),
  });

  const resolvePool: WorkerPoolHandle = startWorkerPool({
    db,
    kind: "RESOLVE",
    concurrency: resolveConcurrency,
    leaseSeconds: RESOLVE_LEASE_SECONDS,
    workerIdPrefix,
    pollIntervalMs: POLL_INTERVAL_MS,
    processClaim: (item) =>
      processResolveClaim(item, {
        db,
        readLabelImage,
        backoffConfig: DEFAULT_BACKOFF_CONFIG,
      }),
    onLoopError: (error, workerId) => console.error(`[batch-worker] ${workerId} error:`, error),
  });

  // TRO-511 — the trigger CP-3 §9/§12 open question 5 named: a
  // single-label REVIEW verdict's review_queue row otherwise never gets a
  // resolver suggestion. Same process, same DEFAULT_BACKOFF_CONFIG, no
  // batch counters or escalation cap (neither applies — see
  // src/server/single-label-resolve/worker.ts's own doc comment).
  const singleLabelResolveWorker: SingleLabelResolveWorkerHandle = startSingleLabelResolveWorker({
    db,
    workerIdPrefix,
    concurrency: singleLabelResolveConcurrency,
    leaseSeconds: RESOLVE_LEASE_SECONDS,
    pollIntervalMs: POLL_INTERVAL_MS,
    readLabelImage,
    backoffConfig: DEFAULT_BACKOFF_CONFIG,
    onLoopError: (error, workerId) => console.error(`[batch-worker] ${workerId} error:`, error),
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[batch-worker] received ${signal} — stopping all worker loops (up to ${shutdownTimeoutMs}ms)...`);
    extractPool.stop();
    resolvePool.stop();
    singleLabelResolveWorker.stop();

    // Bounded, not open-ended: `stop()` only signals every loop to exit
    // after its CURRENT iteration — it cannot itself detect a loop that
    // never finishes one (a hung network call with no timeout of its own,
    // a bug). Without a race against a timeout here, that hangs the whole
    // shutdown, and whatever deploy tooling sent SIGTERM, forever.
    const timedOut = Symbol("shutdown-timeout");
    const timeout = new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), shutdownTimeoutMs));
    Promise.race([Promise.all([extractPool.done, resolvePool.done, singleLabelResolveWorker.done]), timeout])
      .then((result) => {
        if (result === timedOut) {
          console.error(`[batch-worker] did not stop within ${shutdownTimeoutMs}ms — forcing exit. A loop may be stuck mid-claim.`);
          process.exit(1);
          return;
        }
        console.log("[batch-worker] stopped cleanly.");
        process.exit(0);
      })
      .catch((error) => {
        console.error("[batch-worker] error while stopping:", error);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
