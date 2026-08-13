/**
 * Measures REAL batch throughput against a live local LabelHunter
 * instance (TRO-544 / LH-039, PRD §3.8, TH-R4).
 *
 * Run these commands in three separate terminals. Source `.factory-env`
 * first, or keep `.env.local` present for a plain checkout.
 *
 *   1. pnpm batch:fixture     # builds var/batch-fixture/{manifest.csv,images.zip}
 *   2. pnpm dev               # terminal A — the web app
 *      pnpm worker            # terminal B — the batch worker pool
 *   3. pnpm batch:throughput  # terminal C — this script
 *
 * **This costs real money.** A processed item normally makes one real,
 * live Haiku call. The real count varies: an attempt can fail before its
 * request, and a retry adds a call. An escalated item adds one real
 * Sonnet call, and a resolver retry adds more. These are the same calls
 * a real batch upload would make.
 *
 * **This measures the real HTTP path.** The script submits through the
 * same two routes `BatchUploadForm.tsx` calls: `POST /api/batch/preview`,
 * then `POST /api/batch/start`, with the same multipart field names
 * (`manifest`, `imagesZip`). Every request crosses a real HTTP boundary
 * to the real dev server and the real worker process. Compare
 * `scripts/latency/measure.ts`, which deliberately calls
 * `handleVerifyRequest` in-process. Seeing the HTTP + worker-process
 * split is this ticket's whole point.
 *
 * **What this measures.** Wall-clock batch throughput: `totalCount /
 * (completedAt - startedAt)`, and its reciprocal. The script reads both
 * back from this run's own `GET /api/batch/:id` response. The same
 * `computeBatchThroughput` the batch-results screen uses computes them
 * (`../../src/lib/utils/batch-throughput.ts`). Each run is therefore
 * also a live exercise of that new code path.
 *
 * **What this does NOT measure.** A deployed Render instance. The
 * committed artifact records a local run made before TRO-518 landed. At
 * that time, `local-file-storage.ts` wrote each image to the saving
 * process's own disk, so a deployed batch run would have failed on every
 * image. TRO-518 has since moved that storage to Postgres. To get a
 * deployed number, point `--base-url` at a deployed URL and re-run this
 * same script. Do not hand-edit the committed output.
 *
 * **Cost is DERIVED, not measured.** The batch worker
 * (`src/server/batch-queue/`) records no per-call token usage. That seam
 * (`createUsageCapturingClient`) exists only in the eval harness
 * (`scripts/eval/usage.ts`). This script multiplies this run's call
 * counts by the eval harness's measured MEAN per-call cost. It re-reads
 * `scripts/eval/results/eval-report.json` on every run, so the number
 * always reflects what that file currently says. The Haiku call count is
 * an UPPER BOUND, not a certainty. It sums claim `attempts` over this
 * batch's EXTRACT queue items. A retry adds one attempt. An attempt that
 * fails before its request also adds one, with zero real calls made. The
 * Sonnet call count is real: `batch_jobs.sonnet_call_count`, read from
 * the database after the batch completes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { BatchProgressResponse } from "../../src/app/api/batch/[batchJobId]/types";
import type { BatchPreviewSuccessResponse } from "../../src/app/api/batch/preview/types";
import type { BatchStartSuccessResponse } from "../../src/app/api/batch/start/types";
import { HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor/request";
import { computeSonnetCallCapThreshold } from "../../src/server/batch-queue/escalation-cap";
import { BATCH_JOB_STATUSES } from "../../src/lib/db/enums";
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

/** Strict harness-side twin of `scripts/batch-worker/run.ts`'s
 * `envPositiveInt`. The worker warns and falls back on a bad value; this
 * script THROWS instead. A silent fallback here would record a
 * concurrency the operator did not ask for, and the artifact's
 * provenance would be wrong. (run.ts itself is not importable here — the
 * module starts the worker pool at import time.) */
function envConcurrencyOverride(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name}=${JSON.stringify(raw)} is not a positive integer.`);
  }
  return parsed;
}

function readWorkerConcurrency(): BatchThroughputWorkerConcurrency {
  // Defaults mirror scripts/batch-worker/run.ts's own envPositiveInt
  // fallbacks (5, 2, 1). This script cannot see the WORKER process's own
  // concurrency directly, only its own environment. `source` labels each
  // value's real origin so the artifact never calls a fallback "observed."
  const extract = envConcurrencyOverride("BATCH_WORKER_CONCURRENCY");
  const resolveOverride = envConcurrencyOverride("BATCH_RESOLVE_WORKER_CONCURRENCY");
  const singleLabel = envConcurrencyOverride("SINGLE_LABEL_RESOLVE_WORKER_CONCURRENCY");
  const overridden = [
    extract !== null ? "extract" : null,
    resolveOverride !== null ? "resolve" : null,
    singleLabel !== null ? "singleLabelResolve" : null,
  ].filter((name): name is string => name !== null);
  const source =
    overridden.length === 0
      ? ("scripts/batch-worker/run.ts defaults" as const)
      : overridden.length === 3
        ? ("environment override" as const)
        : (`environment override for ${overridden.join(", ")}; scripts/batch-worker/run.ts defaults for the rest` as const);
  return {
    extract: extract ?? 5,
    resolve: resolveOverride ?? 2,
    singleLabelResolve: singleLabel ?? 1,
    source,
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

async function postForm<T>(url: string, formData: FormData, label: string, validate: (payload: unknown) => T): Promise<T> {
  const response = await fetch(url, { method: "POST", body: formData, signal: AbortSignal.timeout(300_000) });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = (payload as ErrorResponseBody)?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`measure.ts: ${label} failed — ${message}`);
  }
  // A 200 body's shape is only assumed until checked (standing rule 13).
  // An unchecked cast would let a malformed response drive the rest of
  // the run (review finding, local review round 10).
  return validate(payload);
}

function isNonNegativeSafeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Named invariant (standing rule 13): both counts are non-negative safe
 * integers. A malformed preview body fails here, not downstream. */
function validatePreviewResponse(payload: unknown): BatchPreviewSuccessResponse {
  const p = payload as Partial<BatchPreviewSuccessResponse>;
  if (!isNonNegativeSafeInteger(p.readyCount) || !isNonNegativeSafeInteger(p.totalRows)) {
    throw new Error(`measure.ts: preview response is malformed — readyCount=${String(p.readyCount)}, totalRows=${String(p.totalRows)}`);
  }
  return payload as BatchPreviewSuccessResponse;
}

/** Named invariants (standing rule 13) for every poll-body field this
 * script uses or persists into the artifact. The poll loop runs this on
 * every response — a malformed 200 body fails the run loudly instead of
 * writing invalid values into the committed artifact (review finding,
 * local review round 11). */
function validateProgressResponse(payload: unknown): BatchProgressResponse {
  const p = payload as Partial<BatchProgressResponse>;
  const isoOrNull = (v: unknown): boolean => v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));
  const counts = [p.totalCount, p.processedCount, p.autoVerifiedCount, p.passCount, p.failCount, p.resolvedBySonnetCount, p.needsHumanCount, p.failedCount];
  // Cross-field coherence, not just per-field shape (review finding,
  // local review round 12): auto-verified items are processed items, and
  // processed items are batch items.
  const countOrderOk =
    counts.every(isNonNegativeSafeInteger) &&
    (p.autoVerifiedCount as number) <= (p.processedCount as number) &&
    (p.processedCount as number) <= (p.totalCount as number);
  const throughputOk =
    p.throughput === null ||
    (typeof p.throughput === "object" &&
      p.throughput !== undefined &&
      Number.isFinite(p.throughput.itemsPerMinute) &&
      p.throughput.itemsPerMinute >= 0 &&
      Number.isFinite(p.throughput.avgMsPerItem) &&
      p.throughput.avgMsPerItem >= 0);
  const shareOk = p.autoVerifiedShare === null || (typeof p.autoVerifiedShare === "number" && p.autoVerifiedShare >= 0 && p.autoVerifiedShare <= 1);
  const ok =
    (BATCH_JOB_STATUSES as readonly string[]).includes(p.status as string) &&
    countOrderOk &&
    isoOrNull(p.startedAt) &&
    isoOrNull(p.completedAt) &&
    throughputOk &&
    shareOk;
  if (!ok) {
    throw new Error(
      `measure.ts: GET /api/batch/:id response is malformed — status=${String(p.status)}, ` +
        `counts=${JSON.stringify(counts)}, startedAt=${String(p.startedAt)}, completedAt=${String(p.completedAt)}, ` +
        `throughput=${JSON.stringify(p.throughput)}, autoVerifiedShare=${String(p.autoVerifiedShare)}`,
    );
  }
  return payload as BatchProgressResponse;
}

/** Named invariant (standing rule 13): `batchJobId` is a POSITIVE safe
 * integer — it drives the poll URL and every SQL read for the rest of
 * the run. `queuedCount` is a non-negative safe integer. */
function validateStartResponse(payload: unknown): BatchStartSuccessResponse {
  const p = payload as Partial<BatchStartSuccessResponse>;
  if (!isNonNegativeSafeInteger(p.batchJobId) || p.batchJobId < 1 || !isNonNegativeSafeInteger(p.queuedCount)) {
    throw new Error(`measure.ts: start response is malformed — batchJobId=${String(p.batchJobId)}, queuedCount=${String(p.queuedCount)}`);
  }
  return payload as BatchStartSuccessResponse;
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
    const progress = validateProgressResponse(await response.json());
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
    // Bound the sleep itself by whatever budget is left too (review
    // finding, local review round 2) — without this, a poll tick could
    // sleep past `deadline` before the next iteration's own check ever
    // runs, on top of the per-request fetch timeout already bounded above.
    const sleepMs = Math.min(pollIntervalMs, deadline - Date.now());
    await new Promise((res) => setTimeout(res, sleepMs));
  }
}

/** Strips credentials and query parameters from a URL before it reaches
 * a log line or the committed artifact. URI userinfo (`user:pass@`) and
 * the query string are the two places a credential can ride inside a URL
 * (review finding, local review round 8). Returns origin + path only.
 * Requests still use the raw URL; only records are sanitized. */
function sanitizeUrlForRecord(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "unparseable-url-redacted";
  }
}

/** Same goal as `sanitizeUrlForRecord`, for the DATABASE_URL log line.
 * Parses with `new URL` and clears username, password, search, and hash
 * instead of pattern-matching (review finding, local review round 9) —
 * a regex misses credential shapes it never anticipated. Keeps the
 * `***@` marker so a masked log line still shows credentials existed. */
function sanitizeDatabaseUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    const hadCredentials = u.username !== "" || u.password !== "";
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace("://", hadCredentials ? "://***@" : "://");
  } catch {
    return "unparseable-database-url-redacted";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`measure.ts: base URL ${sanitizeUrlForRecord(args.baseUrl)}`);
  const dbUrlRaw = process.env.DATABASE_URL;
  console.log(`measure.ts: DATABASE_URL host/db = ${dbUrlRaw === undefined ? "unset" : sanitizeDatabaseUrlForLog(dbUrlRaw)}`);

  // Everything below this point is validated BEFORE the first real,
  // spend-inducing request (review finding, local review round 3) — a
  // missing DATABASE_URL or eval-report.json used to surface only after a
  // real batch had already run and spent real API money, at the very end
  // of this function. Both now fail fast, before checkHealth even runs.

  // Same validate-and-throw shape scripts/eval/check.ts's own runLive and
  // scripts/latency/measure.ts's own main already use — a clear,
  // actionable error instead of pg's own confusing failure when
  // DATABASE_URL is unset (it does not throw immediately; it tries to
  // connect with default, almost certainly wrong, connection parameters).
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("measure.ts: DATABASE_URL is not set. source .factory-env in a factory worktree, or set it in .env.local before running pnpm batch:throughput.");
  }
  // readCostMeans() itself throws a clear error for a missing or malformed
  // eval-report.json, or one with no resolver calls to average — running
  // it now, not after the batch completes, is the whole point of this
  // move.
  const costMeans = readCostMeans();
  // Same fail-fast reasoning: readWorkerConcurrency() throws on an invalid
  // override. Run it before any request, so a bad value cannot abort the
  // script AFTER a real batch has already spent real money.
  const workerConcurrency = readWorkerConcurrency();

  // Same fail-fast reasoning again: prove the database is REACHABLE, not
  // just configured, before any spend-inducing request (review finding,
  // local review round 8). A short-lived probe pool, closed immediately —
  // the pool for the post-run reads opens later, so nothing idles through
  // a potentially 30-minute batch. All hardened settings are copied from
  // the post-run pool (standing rule 22): connectionTimeoutMillis bounds
  // connection ESTABLISHMENT only, so query_timeout bounds the
  // established query too (post-merge review finding).
  {
    const probePool = new Pool({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
    probePool.on("error", (err) => console.error("measure.ts: unexpected error on idle Postgres client", err));
    try {
      await probePool.query("SELECT 1");
    } catch (cause) {
      throw new Error(
        "measure.ts: DATABASE_URL is set but the database did not answer SELECT 1 — fix the connection before spending money on a batch.",
        { cause },
      );
    } finally {
      await probePool.end();
    }
  }

  await checkHealth(args.baseUrl);

  const { manifestBytes, zipBytes, manifestPath, zipPath } = readFixture(args.fixtureDir);
  console.log(`measure.ts: fixture ${manifestPath} (${manifestBytes.length} bytes), ${zipPath} (${zipBytes.length} bytes)`);

  console.log("measure.ts: POST /api/batch/preview ...");
  const preview = await postForm(`${args.baseUrl}/api/batch/preview`, buildFormData(manifestBytes, zipBytes), "preview", validatePreviewResponse);
  console.log(`measure.ts: preview — ${preview.readyCount} of ${preview.totalRows} row(s) ready.`);
  if (preview.readyCount === 0) {
    throw new Error("measure.ts: nothing is ready to start (readyCount = 0) — check the fixture and preview output above.");
  }

  console.log("measure.ts: POST /api/batch/start ...");
  const started = await postForm(`${args.baseUrl}/api/batch/start`, buildFormData(manifestBytes, zipBytes), "start", validateStartResponse);
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

  // One direct database read for the figures the progress API does not
  // expose (sonnetCallCount is an internal safety counter, not a
  // user-facing stat — see get-batch-progress.ts's own scope). A one-shot
  // script opens and closes its own pool rather than reusing
  // src/lib/db's singleton, which is built for a long-running process
  // (scripts/eval/check.ts's own runLive does the same, for the same
  // reason; see that file and scripts/batch-worker/run.ts's own comment on
  // the distinction).
  // query_timeout bounds the established queries; connectionTimeoutMillis
  // alone bounds only connection establishment (post-merge review finding).
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
  pool.on("error", (err) => console.error("measure.ts: unexpected error on idle Postgres client", err));
  const db = drizzle(pool, { schema });
  let sonnetCallCount: number;
  let haikuCallCount: number;
  try {
    const [row] = await db.select().from(schema.batchJobs).where(eq(schema.batchJobs.id, started.batchJobId));
    if (!row) {
      throw new Error(`measure.ts: batch_jobs row ${started.batchJobId} vanished between the HTTP poll and this database read.`);
    }
    sonnetCallCount = row.sonnetCallCount;
    // Cross-check: the HTTP-observed state and the direct database read
    // must agree — both read the exact same row, moments apart, on an
    // already-COMPLETED (so no longer being written to) batch. Counts
    // alone are not enough: a same-ID row in a DIFFERENT database (a
    // mispointed DATABASE_URL) could match them by coincidence. Status
    // and both timestamps must match too (review finding, local review
    // round 8). The API serializes these Dates via JSON.stringify, which
    // calls toISOString — the same conversion applied to the row here.
    if (
      row.status !== "COMPLETED" ||
      row.totalCount !== finalProgress.totalCount ||
      row.processedCount !== finalProgress.processedCount ||
      row.startedAt?.toISOString() !== finalProgress.startedAt ||
      row.completedAt?.toISOString() !== finalProgress.completedAt
    ) {
      throw new Error(
        `measure.ts: batch_jobs row disagrees with the polled API response ` +
          `(db status=${row.status}/totalCount=${row.totalCount}/processedCount=${row.processedCount}/` +
          `startedAt=${row.startedAt?.toISOString()}/completedAt=${row.completedAt?.toISOString()} vs ` +
          `api status=${finalProgress.status}/totalCount=${finalProgress.totalCount}/processedCount=${finalProgress.processedCount}/` +
          `startedAt=${finalProgress.startedAt}/completedAt=${finalProgress.completedAt}) — ` +
          `the DATABASE_URL this script sees may not be the database the server writes to. Investigate before trusting this run.`,
      );
    }

    // `totalCount` is the label count, not the real Haiku call count — a
    // label whose first EXTRACT attempt fails retryably gets a SECOND real
    // Haiku call before it succeeds or is permanently marked FAILED
    // (`extract-worker.ts`'s own `releaseForRetry` path; `claim.ts`
    // increments `attempts` on every claim, retries included). Summing
    // `attempts` over this batch's own EXTRACT queue items is a closer
    // estimate than `totalCount` (review finding, local review rounds 2
    // and 3) — NOT a guaranteed-exact count, still: `attempts` increments
    // the moment an item is CLAIMED, before `processExtractClaim`
    // (`extract-worker.ts`) does any work, so a claim that fails reading
    // or resizing the stored image — before ever reaching the real Haiku
    // call — still counts as one "attempt" with zero real API calls made.
    // This is the same one-sided bias `sonnetCallCount` avoids on the
    // resolver side by reserving BEFORE the call, not counting attempts
    // after the fact (`escalation-cap.ts`'s own `reserveSonnetCall`) — no
    // equivalent reservation exists on the extractor side today. Treat
    // this figure as an upper bound on real Haiku calls, not a certainty;
    // `cost.derivedTotalUsd` inherits that same uncertainty.
    const [{ totalExtractAttempts }] = await db
      .select({ totalExtractAttempts: sql<string>`COALESCE(SUM(${schema.batchQueueItems.attempts}), 0)` })
      .from(schema.batchQueueItems)
      .where(and(eq(schema.batchQueueItems.batchJobId, started.batchJobId), eq(schema.batchQueueItems.kind, "EXTRACT")));
    haikuCallCount = Number(totalExtractAttempts);
    if (!Number.isFinite(haikuCallCount) || haikuCallCount < finalProgress.totalCount) {
      // Every EXTRACT item is claimed (attempts >= 1) at least once by the
      // time the batch is COMPLETED, so the sum can never be smaller than
      // the label count — a smaller sum means the query or the batch's own
      // state is not what this script assumes.
      throw new Error(`measure.ts: EXTRACT attempts sum (${totalExtractAttempts}) is less than totalCount (${finalProgress.totalCount}) — investigate before trusting this run.`);
    }
  } finally {
    await pool.end();
  }

  // costMeans was already read and validated at the top of main(), before
  // the batch ever ran.
  const capThreshold = computeSonnetCallCapThreshold(finalProgress.totalCount);
  const derivedTotalUsd = deriveBatchCostUsd({
    haikuCallCount,
    haikuMeanCostUsd: costMeans.haikuMeanCostUsd,
    sonnetCallCount,
    sonnetMeanCostUsd: costMeans.sonnetMeanCostUsd,
  });

  const report: BatchThroughputRunReport = {
    ticket: "TRO-544 / LH-039",
    measuredAt: runStartedAt,
    // Derived from the real target, never hard-coded — a --base-url run
    // against a deployed instance must not record a false "local"
    // provenance (review finding, local review round 12).
    deployment: ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(args.baseUrl).hostname)
      ? "local dev workstation, not deployed"
      : `remote target ${sanitizeUrlForRecord(args.baseUrl)} — deployment character not verified by this script`,
    baseUrl: sanitizeUrlForRecord(args.baseUrl),
    haikuModel: HAIKU_EXTRACTOR_MODEL,
    sonnetModel: SONNET_RESOLVER_MODEL,
    machine: readMachineInfo(),
    workerConcurrency,
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
      haikuCallCount,
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
      "cost.haikuCallCount sums batch_queue_items.attempts over this batch's own EXTRACT items. The attempts sum is the " +
        "OBSERVED quantity; the real Haiku call count is not observed anywhere. Treat cost.haikuCallCount as an UPPER BOUND " +
        "on real Haiku calls: attempts increments at claim time, before the real API call happens, so a claim that fails " +
        "reading or resizing the image before ever reaching Haiku still counts as one attempt. A retried extraction also " +
        "adds one attempt per retry.",
      "cost.derivedTotalUsd is DERIVED: cost.sonnetCallCount is OBSERVED and cost.haikuCallCount is an UPPER BOUND (see the " +
        "note above), each multiplied by the eval harness's measured MEAN per-call cost from scripts/eval/results/eval-report.json " +
        "(see cost.meanCostSource for that file's own measuredAt). " +
        "This run's own per-call token usage was not captured — the batch worker has no usage-capturing seam today.",
      "workerConcurrency provenance is recorded in workerConcurrency.source: an explicitly set environment variable is an " +
        "observation of this script's own environment; a scripts/batch-worker/run.ts default is a configured assumption, not an " +
        "observation. Either way, the separate worker process is assumed to match only because both terminals sourced the " +
        "same environment configuration (.factory-env, or .env.local for a plain checkout).",
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
