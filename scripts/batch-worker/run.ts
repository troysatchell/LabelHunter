/**
 * The batch worker process entry point (LH-041 / TRO-474, PRD §3.6's
 * "background worker" process; CP-3 §4.5's two-separate-pools design).
 *
 * Run with `pnpm worker`. Starts two independent worker pools — 5
 * extract-workers, 2 resolve-workers, both proposed defaults (CP-3 §4.4,
 * §12 open question 1) — and keeps running until `SIGINT`/`SIGTERM`.
 *
 * `BATCH_WORKER_CONCURRENCY` (extract pool size, default 5) and
 * `BATCH_RESOLVE_WORKER_CONCURRENCY` (resolve pool size, default 2) are
 * environment variables, not hard-coded constants — CP-3 §4.4's own
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
 * only ever claims from batches already `RUNNING`.
 */
import { db } from "../../src/lib/db";
import { DEFAULT_BACKOFF_CONFIG } from "../../src/server/batch-queue/backoff";
import { processExtractClaim } from "../../src/server/batch-queue/extract-worker";
import { startWorkerPool, type WorkerPoolHandle } from "../../src/server/batch-queue/pool";
import { processResolveClaim } from "../../src/server/batch-queue/resolve-worker";
import { productionComparators } from "../../src/server/comparators";
import { readLabelImage } from "../../src/server/storage/local-file-storage";

/** Proposed, not measured (CP-3 §3.2) — generous multiples of the
 * extractor's/resolver's own target call durations (PRD §3.8). */
const EXTRACT_LEASE_SECONDS = 60;
const RESOLVE_LEASE_SECONDS = 120;

/** How long an idle loop waits before polling again. Not a CP-3-named
 * value — short enough that a newly-available item is picked up quickly,
 * long enough that an empty queue does not spin the database with
 * constant claim attempts. */
const POLL_INTERVAL_MS = 2000;

function envConcurrency(name: string, fallback: number): number {
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
  const extractConcurrency = envConcurrency("BATCH_WORKER_CONCURRENCY", 5);
  const resolveConcurrency = envConcurrency("BATCH_RESOLVE_WORKER_CONCURRENCY", 2);
  const workerIdPrefix = `${process.pid}`;

  console.log(
    `[batch-worker] starting — ${extractConcurrency} extract worker(s), ${resolveConcurrency} resolve worker(s) (pid ${process.pid})`,
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

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[batch-worker] received ${signal} — stopping both pools...`);
    extractPool.stop();
    resolvePool.stop();
    Promise.all([extractPool.done, resolvePool.done])
      .then(() => {
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
