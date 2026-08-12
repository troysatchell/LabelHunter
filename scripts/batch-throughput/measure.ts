/**
 * Measures REAL batch throughput against a live local LabelHunter instance
 * (TRO-544 / LH-039, PRD §3.8, TH-R4).
 *
 * Run, in three separate terminals (all with `.factory-env` sourced, or
 * `.env.local` present for a plain checkout):
 *
 *   1. pnpm batch:fixture     # builds var/batch-fixture/{manifest.csv,images.zip}
 *   2. pnpm dev                       # terminal A — the web app
 *      pnpm worker                    # terminal B — the batch worker pool
 *   3. pnpm batch:throughput          # terminal C — this script
 *
 * **This costs real money.** Every item is one real, live Haiku call; an
 * escalated item adds one real Sonnet call — exactly the calls a real
 * batch upload would make. This script submits through the SAME two HTTP
 * routes `BatchUploadForm.tsx` calls (`POST /api/batch/preview`, then
 * `POST /api/batch/start`), with the same multipart field names
 * (`manifest`, `imagesZip`) — a real HTTP round trip against the real dev
 * server and the real worker process, not an in-process call (unlike
 * `scripts/latency/measure.ts`, which deliberately calls
 * `handleVerifyRequest` directly — seeing the real HTTP + worker-process
 * split is this ticket's whole point, and it is also what
 * `--base-url=<deployed URL>` will need once TRO-518 lands).
 *
 * **What this measures.** Wall-clock batch throughput: `totalCount /
 * (completedAt - startedAt)`, and its reciprocal — read back from this
 * run's own `GET /api/batch/:id` response, computed by the exact same
 * `computeBatchThroughput` the product's batch-results screen uses
 * (`../../src/lib/utils/batch-throughput.ts`). This script is therefore
 * also a live, real exercise of that new code path, not only a
 * data-collection exercise.
 *
 * **What this does NOT measure.** A deployed Render instance.
 * `render.yaml` runs the web and worker as separate services with
 * separate disks, and `local-file-storage.ts` writes to whichever
 * process saved the image — a batch run there fails on every image until
 * TRO-518 lands. Point `--base-url` at a deployed URL only after that
 * ticket is done, and re-run this same script; do not hand-edit its
 * output.
 *
 * **Cost is DERIVED, not measured.** The batch worker
 * (`src/server/batch-queue/`) records no per-call token usage — that seam
 * (`createUsageCapturingClient`) exists only in the eval harness
 * (`scripts/eval/usage.ts`). This script multiplies this run's REAL call
 * counts (`totalCount` Haiku calls, `sonnetCallCount` Sonnet call
 * attempts — both read from the real `batch_jobs` row after the batch
 * completes) by the eval harness's own measured MEAN per-call cost,
 * re-read from `scripts/eval/results/eval-report.json` on every run so
 * this number always reflects whatever that file currently says, never a
 * value copied in by hand and left to go stale.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { BatchProgressResponse } from "../../src/app/api/batch/[batchJobId]/types";
import type { BatchPreviewSuccessResponse } from "../../src/app/api/batch/preview/types";
import type { BatchStartSuccessResponse } from "../../src/app/api/batch/start/types";
import { HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor/request";
import { computeSonnetCallCapThreshold } from "../../src/server/batch-queue/escalation-cap";
import * as schema from "../../src/lib/db/schema";
import { SONNET_RESOLVER_MODEL } from "../../src/server/resolver/request";
import { parseArgs } from "./args";
import { deriveBatchCostUsd, meanCost } from "./cost";
import type { BatchThroughputRunReport, BatchThroughputWorkerConcurrency } from "./types";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUTPUT_PATH = resolve(REPO_ROOT, "scripts/batch-throughput/results/local-batch-run.json");
const EVAL_REPORT_PATH = resolve(REPO_ROOT, "scripts/eval/results/eval-report.json");

function readMachineInfo() {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    nodeVersion: process.version,
  };
}

function readWorkerConcurrency(): BatchThroughputWorkerConcurrency {
  const extractRaw = process.env.BATCH_WORKER_CONCURRENCY;
  const resolveRaw = process.env.BATCH_RESOLVE_WORKER_CONCURRENCY;
  const singleLabelRaw = process.env.SINGLE_LABEL_RESOLVE_WORKER_CONCURRENCY;
  return {
    // Defaults mirror scripts/batch-worker/run.ts's own envPositiveInt
    // fallbacks (5, 2, 1) — this script cannot see the WORKER process's
    // own concurrency directly, only its own environment.
    extract: extractRaw ? Number(extractRaw) : 5,
    resolve: resolveRaw ? Number(resolveRaw) : 2,
    singleLabelResolve: singleLabelRaw ? Number(singleLabelRaw) : 1,
    source: extractRaw || resolveRaw || singleLabelRaw ? "environment override" : "scripts/batch-worker/run.ts defaults",
  };
}

interface EvalReportCostShape {
  measuredAt: string;
  cases: ReadonlyArray<{
    haikuCost: { usd: number };
    resolverCost: { usd: number } | null;
  }>;
}

function readCostMeans(): { haikuMeanCostUsd: number; sonnetMeanCostUsd: number; sourceFile: string; sourceMeasuredAt: string } {
  const raw = JSON.parse(readFileSync(EVAL_REPORT_PATH, "utf8")) as EvalReportCostShape;
  const haikuCosts = raw.cases.map((c) => c.haikuCost.usd);
  const sonnetCosts = raw.cases.map((c) => c.resolverCost?.usd).filter((v): v is number => typeof v === "number");
  if (sonnetCosts.length === 0) {
    throw new Error(
      `measure.ts: ${EVAL_REPORT_PATH} recorded no resolver calls to average — cannot derive a Sonnet mean cost. ` +
        "Re-run 'pnpm eval:check -- --live --full' first.",
    );
  }
  return {
    haikuMeanCostUsd: meanCost(haikuCosts),
    sonnetMeanCostUsd: meanCost(sonnetCosts),
    sourceFile: "scripts/eval/results/eval-report.json",
    sourceMeasuredAt: raw.measuredAt,
  };
}

async function checkHealth(baseUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
  } catch (cause) {
    throw new Error(
      `measure.ts: could not reach ${baseUrl}/api/health (${(cause as Error).message}). ` + "Start the app first: pnpm dev",
    );
  }
  if (!response.ok) {
    throw new Error(`measure.ts: ${baseUrl}/api/health returned ${response.status} — is 'pnpm dev' actually running?`);
  }
}

function readFixture(fixtureDir: string): { manifestBytes: Buffer; zipBytes: Buffer; manifestPath: string; zipPath: string } {
  const manifestPath = resolve(REPO_ROOT, fixtureDir, "manifest.csv");
  const zipPath = resolve(REPO_ROOT, fixtureDir, "images.zip");
  let manifestBytes: Buffer;
  let zipBytes: Buffer;
  try {
    manifestBytes = readFileSync(manifestPath);
    zipBytes = readFileSync(zipPath);
  } catch (cause) {
    throw new Error(
      `measure.ts: could not read the fixture at ${fixtureDir} (${(cause as Error).message}). ` + "Build it first: pnpm batch:fixture",
    );
  }
  return { manifestBytes, zipBytes, manifestPath, zipPath };
}

function buildFormData(manifestBytes: Buffer, zipBytes: Buffer): FormData {
  const formData = new FormData();
  formData.set("manifest", new File([new Uint8Array(manifestBytes)], "manifest.csv", { type: "text/csv" }));
  formData.set("imagesZip", new File([new Uint8Array(zipBytes)], "images.zip", { type: "application/zip" }));
  return formData;
}

interface ErrorResponseBody {
  error?: { kind?: string; message?: string };
}

async function postForm<T>(url: string, formData: FormData, label: string): Promise<T> {
  const response = await fetch(url, { method: "POST", body: formData, signal: AbortSignal.timeout(300_000) });
  const payload = (await response.json()) as T | ErrorResponseBody;
  if (!response.ok) {
    const message = (payload as ErrorResponseBody)?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`measure.ts: ${label} failed — ${message}`);
  }
  return payload as T;
}

/** Polls `GET /api/batch/:id` for a REAL status change — never a fixed
 * sleep-and-hope (standing rule 8). Checks the real, live status on every
 * iteration; only waits `pollIntervalMs` BETWEEN checks. */
async function pollUntilTerminal(
  baseUrl: string,
  batchJobId: number,
  pollIntervalMs: number,
  maxWaitMs: number,
): Promise<BatchProgressResponse> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`measure.ts: batch ${batchJobId} did not reach a terminal state within ${maxWaitMs}ms`);
    }
    // Bound THIS request's own timeout by whatever budget is left, never a
    // flat 30s (review finding, local review round 1) — a flat timeout
    // could itself exceed a small --max-wait-ms, letting one slow request
    // overshoot the documented budget by up to 30s before the deadline
    // check below ever runs.
    const response = await fetch(`${baseUrl}/api/batch/${batchJobId}`, { signal: AbortSignal.timeout(Math.min(30_000, remainingMs)) });
    if (!response.ok) {
      throw new Error(`measure.ts: GET /api/batch/${batchJobId} returned ${response.status}`);
    }
    const progress = (await response.json()) as BatchProgressResponse;
    console.log(
      `  ${progress.status}: ${progress.processedCount}/${progress.totalCount} processed` +
        ` (auto-verified ${progress.autoVerifiedCount}, resolved-by-Sonnet ${progress.resolvedBySonnetCount},` +
        ` needs-human ${progress.needsHumanCount}, failed ${progress.failedCount})`,
    );
    if (progress.status === "COMPLETED" || progress.status === "FAILED") {
      return progress;
    }
    if (Date.now() > deadline) {
      throw new Error(`measure.ts: batch ${batchJobId} did not reach a terminal state within ${maxWaitMs}ms (last status: ${progress.status})`);
    }
    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`measure.ts: base URL ${args.baseUrl}`);
  console.log(`measure.ts: DATABASE_URL host/db = ${(process.env.DATABASE_URL ?? "unset").replace(/:\/\/[^@]*@/, "://***@")}`);

  await checkHealth(args.baseUrl);

  const { manifestBytes, zipBytes, manifestPath, zipPath } = readFixture(args.fixtureDir);
  console.log(`measure.ts: fixture ${manifestPath} (${manifestBytes.length} bytes), ${zipPath} (${zipBytes.length} bytes)`);

  console.log("measure.ts: POST /api/batch/preview ...");
  const preview = await postForm<BatchPreviewSuccessResponse>(`${args.baseUrl}/api/batch/preview`, buildFormData(manifestBytes, zipBytes), "preview");
  console.log(`measure.ts: preview — ${preview.readyCount} of ${preview.totalRows} row(s) ready.`);
  if (preview.readyCount === 0) {
    throw new Error("measure.ts: nothing is ready to start (readyCount = 0) — check the fixture and preview output above.");
  }

  console.log("measure.ts: POST /api/batch/start ...");
  const started = await postForm<BatchStartSuccessResponse>(`${args.baseUrl}/api/batch/start`, buildFormData(manifestBytes, zipBytes), "start");
  console.log(`measure.ts: started batch ${started.batchJobId} — ${started.queuedCount} label(s) queued.`);

  const runStartedAt = new Date().toISOString();
  const finalProgress = await pollUntilTerminal(args.baseUrl, started.batchJobId, args.pollIntervalMs, args.maxWaitMs);

  if (finalProgress.status === "FAILED") {
    throw new Error(`measure.ts: batch ${started.batchJobId} reached status FAILED, not COMPLETED — nothing to measure.`);
  }
  if (finalProgress.throughput === null || finalProgress.startedAt === null || finalProgress.completedAt === null) {
    throw new Error(
      `measure.ts: batch ${started.batchJobId} reached COMPLETED but the progress endpoint reported throughput: null — this is a bug, not a real result.`,
    );
  }
  if (finalProgress.autoVerifiedShare === null) {
    throw new Error(`measure.ts: batch ${started.batchJobId} reached COMPLETED but autoVerifiedShare was null — this is a bug, not a real result.`);
  }

  // One direct database read for the one figure the progress API does not
  // expose (sonnetCallCount is an internal safety counter, not a
  // user-facing stat — see get-batch-progress.ts's own scope). A one-shot
  // script opens and closes its own pool rather than reusing
  // src/lib/db's singleton, which is built for a long-running process
  // (scripts/eval/check.ts's own runLive does the same, for the same
  // reason; see that file and scripts/batch-worker/run.ts's own comment on
  // the distinction).
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
  pool.on("error", (err) => console.error("measure.ts: unexpected error on idle Postgres client", err));
  const db = drizzle(pool, { schema });
  let sonnetCallCount: number;
  try {
    const [row] = await db.select().from(schema.batchJobs).where(eq(schema.batchJobs.id, started.batchJobId));
    if (!row) {
      throw new Error(`measure.ts: batch_jobs row ${started.batchJobId} vanished between the HTTP poll and this database read.`);
    }
    sonnetCallCount = row.sonnetCallCount;
    // Cross-check: the HTTP-observed counts and the direct database read
    // must agree — both read the exact same row, moments apart, on an
    // already-COMPLETED (so no longer being written to) batch.
    if (row.totalCount !== finalProgress.totalCount || row.processedCount !== finalProgress.processedCount) {
      throw new Error(
        `measure.ts: batch_jobs row disagrees with the polled API response ` +
          `(db totalCount=${row.totalCount}/processedCount=${row.processedCount} vs ` +
          `api totalCount=${finalProgress.totalCount}/processedCount=${finalProgress.processedCount}) — investigate before trusting this run.`,
      );
    }
  } finally {
    await pool.end();
  }

  const costMeans = readCostMeans();
  const capThreshold = computeSonnetCallCapThreshold(finalProgress.totalCount);
  const derivedTotalUsd = deriveBatchCostUsd({
    haikuCallCount: finalProgress.totalCount,
    haikuMeanCostUsd: costMeans.haikuMeanCostUsd,
    sonnetCallCount,
    sonnetMeanCostUsd: costMeans.sonnetMeanCostUsd,
  });

  const report: BatchThroughputRunReport = {
    ticket: "TRO-544 / LH-039",
    measuredAt: runStartedAt,
    deployment: "local dev workstation, not deployed",
    baseUrl: args.baseUrl,
    haikuModel: HAIKU_EXTRACTOR_MODEL,
    sonnetModel: SONNET_RESOLVER_MODEL,
    machine: readMachineInfo(),
    workerConcurrency: readWorkerConcurrency(),
    fixture: { source: args.fixtureDir, itemCount: finalProgress.totalCount },
    batchJobId: started.batchJobId,
    totalCount: finalProgress.totalCount,
    processedCount: finalProgress.processedCount,
    startedAt: finalProgress.startedAt,
    completedAt: finalProgress.completedAt,
    throughput: finalProgress.throughput,
    dispositionMix: {
      autoVerifiedCount: finalProgress.autoVerifiedCount,
      passCount: finalProgress.passCount,
      failCount: finalProgress.failCount,
      resolvedBySonnetCount: finalProgress.resolvedBySonnetCount,
      needsHumanCount: finalProgress.needsHumanCount,
      failedCount: finalProgress.failedCount,
    },
    autoVerifiedShare: finalProgress.autoVerifiedShare,
    escalationCap: {
      capThreshold,
      sonnetCallCount,
      capHit: sonnetCallCount >= capThreshold,
    },
    cost: {
      haikuCallCount: finalProgress.totalCount,
      haikuMeanCostUsd: costMeans.haikuMeanCostUsd,
      sonnetCallCount,
      sonnetMeanCostUsd: costMeans.sonnetMeanCostUsd,
      derivedTotalUsd,
      meanCostSource: { file: costMeans.sourceFile, measuredAt: costMeans.sourceMeasuredAt },
    },
    notes: [
      "throughput and autoVerifiedShare are OBSERVED: read verbatim from this run's own GET /api/batch/:id response, " +
        "computed by the same computeBatchThroughput/computeAutoVerifiedShare the product's batch-results screen uses.",
      "sonnetCallCount is OBSERVED: read directly from the batch_jobs row after the batch reached COMPLETED, and cross-checked " +
        "against the polled API response's totalCount/processedCount.",
      "cost.derivedTotalUsd is DERIVED: real call counts from this run, multiplied by the eval harness's measured MEAN " +
        "per-call cost from scripts/eval/results/eval-report.json (see cost.meanCostSource for that file's own measuredAt). " +
        "This run's own per-call token usage was not captured — the batch worker has no usage-capturing seam today.",
      "workerConcurrency is OBSERVED from this script's own environment variables, assumed identical to the separate worker " +
        "process's environment because both were started from the same sourced shell for this run.",
      "This ran on a local dev workstation, not a deployed Render instance. Do not quote these figures as deployed throughput.",
    ],
  };

  mkdirSync(resolve(REPO_ROOT, "scripts/batch-throughput/results"), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n");

  console.log("");
  console.log(`measure.ts: wrote ${OUTPUT_PATH}`);
  console.log(
    `measure.ts: ${report.totalCount} items in ${report.throughput.avgMsPerItem}ms/item avg -> ` +
      `${report.throughput.itemsPerMinute} items/minute`,
  );
  console.log(
    `measure.ts: disposition — auto-verified ${report.dispositionMix.autoVerifiedCount} ` +
      `(${report.dispositionMix.passCount} pass, ${report.dispositionMix.failCount} fail), ` +
      `resolved-by-Sonnet ${report.dispositionMix.resolvedBySonnetCount}, needs-human ${report.dispositionMix.needsHumanCount}, ` +
      `failed ${report.dispositionMix.failedCount}`,
  );
  console.log(`measure.ts: auto-verified share ${(report.autoVerifiedShare * 100).toFixed(1)}%`);
  console.log(
    `measure.ts: escalation cap ${report.escalationCap.sonnetCallCount}/${report.escalationCap.capThreshold} ` +
      `(hit: ${report.escalationCap.capHit})`,
  );
  console.log(`measure.ts: derived cost $${report.cost.derivedTotalUsd.toFixed(4)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
