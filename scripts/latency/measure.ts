/**
 * Latency harness for the single-label verify flow (TRO-471 / LH-031,
 * TH-R2, PRD §3.8, §6).
 *
 * Run: `pnpm latency:check` (optionally `-- --runs=20 --case=<caseId>`).
 * **This costs real money.** Each run is one real, live `claude-haiku-4-5`
 * extraction call against the Anthropic API — never mocked. TH-R2 exists to
 * produce an honest measured number (CLAUDE.md: "never fabricate a
 * number"); a mocked client would answer a different, useless question.
 * `ANTHROPIC_API_KEY` and `DATABASE_URL` must be set — `source .factory-env`
 * in a factory worktree.
 *
 * **What this measures.** `handleVerifyRequest` — the exact function
 * `src/app/api/verify/route.ts`'s `POST` calls — from a fully-formed
 * `Request` to a rendered response body: multipart parsing, preprocessing
 * (sharp), the real Haiku call, the deterministic Validation Router, and
 * the database writes PRD §3.6 names. This is an in-process call, the same
 * pattern `route.test.ts` uses, not a real HTTP round-trip — it excludes a
 * real browser's upload time and the Next.js HTTP framing layer, neither of
 * which PRD §3.8's stage table (preprocess / OCR / Haiku / router) budgets
 * for. Uploaded images are saved to a scratch directory, not the real
 * `var/uploads/`. This script deletes every application row it creates as
 * it goes (cascades to that row's label image, verification, field
 * results, and review-queue row) — the same cleanup `route.test.ts` does.
 * A delete failure is recorded, not silently retried or ignored (see
 * `main`'s `cleanupFailures`) — this is best-effort row cleanup, not a
 * guarantee the database ends up byte-for-byte as it started (sequence
 * counters still advance either way).
 *
 * **What is NOT in this measurement, and why.** The warning subsystem
 * (LH-020) has not merged. The Sonnet resolver (LH-014, `src/server/
 * resolver/`) has merged to `main`, but `route.ts` never calls it —
 * confirmed with `git diff`, not assumed: `route.ts` is byte-identical
 * before and after that merge. `handleVerifyRequest` never calls Sonnet
 * inline, on any run, escalated or not (TH-R19 — the cascade is the
 * architecture). Sonnet resolution, when it happens at all, runs
 * asynchronously off the `review_queue` table, on its own schedule,
 * outside this request and outside this script's timer. Every run below
 * is therefore a "fast path" measurement by construction, not a mix of
 * fast path and Sonnet-resolved escalation. Because `route.ts` passes
 * `warningResult: null` (honestly — LH-020 is not built), the government
 * warning field routes to `NEEDS_REVIEW` on every run that has one, which
 * usually rolls the label verdict up to `REVIEW`. This is expected, not a
 * bug: a `REVIEW` verdict here is still a same-request, synchronous answer
 * (PRD §3.8's "verdict or an explicit flag" clock). It costs no extra
 * wall-clock time — nothing asynchronous, and nothing Sonnet-side, runs
 * before this script's timer stops.
 *
 * **Failure handling.** A run that throws, or that the route answers with a
 * non-200 status, is recorded in the raw log with its own duration and
 * error detail, but excluded from the p50/p95 input — a hard failure is
 * neither a verdict nor a flag, so it is not a latency sample for TH-R2's
 * clock. If every run fails, the script still writes an artifact (honest
 * about zero successful samples) and exits non-zero.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/lib/db/schema";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import { handleVerifyRequest, type VerifyRouteDeps } from "../../src/app/api/verify/route";
import { extractLabel, HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor";
import { preprocessImage } from "../../src/server/preprocessing";
import { productionComparators } from "../../src/server/comparators";
import { saveLabelImage } from "../../src/server/storage/local-file-storage";
import { parseArgs } from "./args";
import { cleanupScratchDirAndPool } from "./cleanup";
import { computeExitCode } from "./exit-status";
import { summarizeLatencies, type LatencySummary } from "./percentile";
import { parseVerifySuccessBody } from "./response";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RESULTS_PATH = path.resolve(REPO_ROOT, "scripts/latency/results/single-label-verify.json");

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

function findCase(caseId: string): GoldenSetCase {
  const manifest = loadGoldenSetManifest();
  const found = manifest.cases.find((c) => c.caseId === caseId);
  if (!found) {
    const available = manifest.cases.map((c) => c.caseId).join(", ");
    throw new Error(`measure.ts: no golden-set case "${caseId}" — available: ${available}`);
  }
  return found;
}

function mediaTypeForImagePath(imagePath: string): string {
  const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
  const mediaType = EXTENSION_TO_MEDIA_TYPE[ext];
  if (!mediaType) {
    throw new Error(`measure.ts: no known media type for image extension ".${ext}" (${imagePath})`);
  }
  return mediaType;
}

/** Builds the same `FormData` shape `VerifyForm` (the real UI) sends,
 * using the golden-set case's own application-side fields — matching
 * `route.test.ts`'s `buildFormData` pattern. */
function buildRequest(imageBytes: Buffer, imagePath: string, mediaType: string, caseSpec: GoldenSetCase): Request {
  const fd = new FormData();
  const file = new File([imageBytes as unknown as BlobPart], path.basename(imagePath), { type: mediaType });
  fd.set("image", file);
  fd.set("beverageType", caseSpec.beverageType);
  fd.set("brandName", caseSpec.application.brandName);
  fd.set("classType", caseSpec.application.classType);
  if (caseSpec.application.abvPercent !== undefined) {
    fd.set("alcoholContentPercent", String(caseSpec.application.abvPercent));
  }
  fd.set("netContentsValue", String(caseSpec.application.netContentsValue));
  fd.set("netContentsUnit", caseSpec.application.netContentsUnit);
  return new Request("http://localhost/api/verify", { method: "POST", body: fd });
}

interface RunResult {
  index: number;
  durationMs: number;
  ok: boolean;
  httpStatus: number;
  labelVerdict?: string;
  headlineReason?: string | null;
  applicationId?: number;
  error?: string;
}

/** One `applications` row this script created but failed to delete
 * afterward. Recorded, never silently swallowed — see `main`'s own
 * `cleanupFailures` handling and this file's module comment. */
interface CleanupFailure {
  applicationId: number;
  error: string;
}

async function runOnce(
  index: number,
  imageBytes: Buffer,
  imagePath: string,
  mediaType: string,
  caseSpec: GoldenSetCase,
  deps: VerifyRouteDeps,
): Promise<RunResult> {
  const request = buildRequest(imageBytes, imagePath, mediaType, caseSpec);
  const start = performance.now();
  try {
    const response = await handleVerifyRequest(request, deps);
    // Stop the clock HERE, before response.json() — on purpose, not an
    // oversight. `route.ts` builds the response with `NextResponse.json(...)`,
    // which serializes the body eagerly at construction time, so the actual
    // work is already done once `handleVerifyRequest` resolves. Parsing that
    // already-serialized body below is this harness's OWN bookkeeping (it
    // wants labelVerdict/headlineReason/applicationId for the log and the
    // cleanup step) — a real client would do the equivalent parse on its own
    // side, after the server's own clock has already stopped. Counting it
    // here would inflate the number with a cost the server itself never
    // pays. Also rounded to the nearest millisecond — sub-ms precision is
    // noise at the multi-second, network-bound scale this harness measures.
    const durationMs = Math.round(performance.now() - start);
    const body: unknown = await response.json().catch(() => null);
    if (response.status !== 200) {
      const message =
        body && typeof body === "object" && "error" in body
          ? JSON.stringify((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
      return { index, durationMs, ok: false, httpStatus: response.status, error: message };
    }
    // `route.ts`'s own type system guarantees this shape on every real 200
    // response today, but a bare cast would still trust an untyped runtime
    // value without checking it — the exact anti-pattern this repo's other
    // boundaries (parseVerifyFormData, parseExtractionResponse) avoid.
    // Validate rather than assume (standing rule 13).
    const success = parseVerifySuccessBody(body);
    if (!success) {
      // A malformed 200 body means this run's applicationId is unrecoverable
      // here — there is no channel to it other than the body that just
      // failed to parse, so `cleanup()` cannot delete this run's row.
      // Reviewed and left as-is (2026-08-11): unreachable today per the
      // comment above, and closing it for real would need a second,
      // redundant identity channel (a response header, or a DB lookup by a
      // marker planted in the request) — real design work disproportionate
      // to a measurement harness, not a quick validation add. The failure
      // is loud (non-zero exit, the message below), not silent, so an
      // operator would see and fix an orphaned row by hand rather than the
      // harness losing evidence quietly.
      return {
        index,
        durationMs,
        ok: false,
        httpStatus: response.status,
        error: "measure.ts: 200 response body did not match the expected VerifySuccessBody shape",
      };
    }
    return {
      index,
      durationMs,
      ok: true,
      httpStatus: 200,
      labelVerdict: success.labelVerdict,
      headlineReason: success.headlineReason,
      applicationId: success.applicationId,
    };
  } catch (cause) {
    const durationMs = Math.round(performance.now() - start);
    return {
      index,
      durationMs,
      ok: false,
      httpStatus: 0,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

interface MachineInfo {
  platform: string;
  arch: string;
  cpuModel: string | null;
  cpuCount: number;
  nodeVersion: string;
}

function readMachineInfo(): MachineInfo {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    nodeVersion: process.version,
  };
}

interface HarnessReport {
  ticket: string;
  measuredAt: string;
  model: string;
  goldenSetCase: {
    caseId: string;
    category: string;
    beverageType: string;
    imagePath: string;
  };
  pipelineScope: string;
  machine: MachineInfo;
  requestedRuns: number;
  successfulRuns: number;
  failedRuns: number;
  verdictCounts: Record<string, number>;
  summaryMs: LatencySummary | null;
  budget: {
    p50TargetMs: number;
    source: string;
    /** PRD §3.8's own internal stage-budget sub-target for the fast path
     * (preprocess + Haiku + router). Distinct from `p50TargetMs`, TH-R2's
     * headline acceptance figure — this one is more optimistic and is a
     * target for the individual stage budgets, not the acceptance bar. */
    internalFastPathP50TargetMs: number;
    internalFastPathSource: string;
  };
  /** `applications` rows this script created but could not delete
   * afterward. Empty on a clean run. A non-empty list does not mean the
   * latency numbers above are wrong — it means housekeeping left rows
   * behind in the worktree's own disposable database. */
  cleanupFailures: CleanupFailure[];
  /** `null` on a clean removal of the scratch image directory. The error
   * message on a failure — same "housekeeping, not a measurement problem"
   * meaning as `cleanupFailures`. */
  scratchDirCleanupError: string | null;
  /** `null` on a clean database-pool close. The error message on a
   * failure — same meaning as `scratchDirCleanupError`. */
  closePoolError: string | null;
  runs: RunResult[];
}

async function main(): Promise<void> {
  const { runs, caseId } = parseArgs(process.argv.slice(2));

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "measure.ts: ANTHROPIC_API_KEY is not set. source .factory-env in a factory worktree, " +
        "or set it in .env.local before running pnpm latency:check.",
    );
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "measure.ts: DATABASE_URL is not set. source .factory-env in a factory worktree, " +
        "or set it in .env.local before running pnpm latency:check.",
    );
  }

  const caseSpec = findCase(caseId);
  const imagePath = caseSpec.imagePath;
  const mediaType = mediaTypeForImagePath(imagePath);
  const imageBytes = readFileSync(path.resolve(REPO_ROOT, imagePath));

  console.log(`measure.ts: ${runs} run(s) against case "${caseId}" (${caseSpec.category}, ${caseSpec.beverageType})`);
  console.log(`measure.ts: model ${HAIKU_EXTRACTOR_MODEL} — each run is one real, live API call.`);

  const pool = new Pool({
    connectionString,
    // Same two safeguards as src/lib/db/index.ts's shared pool, and for the
    // same reason: pg's own default `connectionTimeoutMillis` is 0 (no
    // timeout), so an unreachable database would hang this script forever
    // instead of failing fast, and an idle client that loses its connection
    // emits an unhandled "error" event with no listener registered — Node
    // treats that as fatal and crashes the process outright, which would be
    // a real risk over a 20-plus-run session that runs for a minute or more.
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => {
    console.error("measure.ts: unexpected error on idle Postgres client", err);
  });
  const db = drizzle(pool, { schema });
  const scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro471-latency-"));

  const deps: VerifyRouteDeps = {
    db,
    preprocessImage,
    extractLabel,
    saveLabelImage: (bytes, originalFilename) => saveLabelImage(bytes, originalFilename, { baseDir: scratchDir }),
    comparators: productionComparators,
  };

  const runResults: RunResult[] = [];
  const cleanupFailures: CleanupFailure[] = [];
  let scratchDirCleanupError: string | null = null;
  let closePoolError: string | null = null;
  try {
    for (let i = 1; i <= runs; i++) {
      const result = await runOnce(i, imageBytes, imagePath, mediaType, caseSpec, deps);
      runResults.push(result);
      if (result.ok) {
        console.log(`  run ${i}/${runs}: ${result.durationMs.toFixed(0)}ms — verdict ${result.labelVerdict}${result.headlineReason ? ` (${result.headlineReason})` : ""}`);
      } else {
        console.log(`  run ${i}/${runs}: ${result.durationMs.toFixed(0)}ms — FAILED: ${result.error}`);
      }
      if (result.applicationId !== undefined) {
        try {
          await db.delete(schema.applications).where(eq(schema.applications.id, result.applicationId));
        } catch (cleanupError) {
          const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          console.warn(`  run ${i}/${runs}: cleanup of application ${result.applicationId} failed: ${message}`);
          cleanupFailures.push({ applicationId: result.applicationId, error: message });
        }
      }
    }
  } finally {
    // `cleanupScratchDirAndPool` never throws (see cleanup.ts) — a failed
    // `rm` is captured into `scratchDirCleanupError`, not re-thrown, so this
    // `finally` block always completes normally and `main` always reaches
    // the report-writing code below. An earlier version let `rm`'s error
    // propagate past this whole function, silently discarding every
    // already-completed, already-paid-for run's results (a real PR review
    // finding, not a hypothetical).
    ({ scratchDirCleanupError, closePoolError } = await cleanupScratchDirAndPool(
      () => rm(scratchDir, { recursive: true, force: true }),
      () => pool.end(),
    ));
    if (scratchDirCleanupError) {
      console.warn(`measure.ts: failed to remove scratch directory ${scratchDir}: ${scratchDirCleanupError}`);
    }
    if (closePoolError) {
      console.warn(`measure.ts: failed to close the database pool: ${closePoolError}`);
    }
  }

  const successful = runResults.filter((r) => r.ok);
  const failed = runResults.filter((r) => !r.ok);
  const verdictCounts: Record<string, number> = {};
  for (const r of successful) {
    if (r.labelVerdict) verdictCounts[r.labelVerdict] = (verdictCounts[r.labelVerdict] ?? 0) + 1;
  }

  const summaryMs = successful.length > 0 ? summarizeLatencies(successful.map((r) => r.durationMs)) : null;

  const report: HarnessReport = {
    ticket: "TRO-471 / LH-031",
    measuredAt: new Date().toISOString(),
    model: HAIKU_EXTRACTOR_MODEL,
    goldenSetCase: {
      caseId: caseSpec.caseId,
      category: caseSpec.category,
      beverageType: caseSpec.beverageType,
      imagePath: caseSpec.imagePath,
    },
    pipelineScope:
      "Preprocess (sharp) -> Haiku extraction (claude-haiku-4-5, real API call) -> " +
      "deterministic Validation Router -> DB writes, via handleVerifyRequest in-process " +
      "(not a real HTTP round-trip). No OCR/warning-subsystem comparator (LH-020 not merged " +
      "-- warningResult is always null). LH-014's Sonnet resolver has merged to main, but " +
      "route.ts never calls it inline -- every run below is the fast path only; Sonnet " +
      "resolution, when it happens, runs asynchronously off the review queue, never inside " +
      "this request (TH-R19).",
    machine: readMachineInfo(),
    requestedRuns: runs,
    successfulRuns: successful.length,
    failedRuns: failed.length,
    verdictCounts,
    summaryMs,
    budget: {
      p50TargetMs: 5000,
      source: "TH-R2 / PRD §3.8: ~5s p50 wall-clock, single-label verify, realistic image.",
      internalFastPathP50TargetMs: 3000,
      internalFastPathSource:
        "PRD §3.8 stage table: 'Fast path total (~85-90% of labels): ~3s p50, <=5s p95' -- " +
        "the internal engineering sub-target the 5s acceptance bar leaves headroom against, " +
        "not the TH-R2 acceptance figure itself.",
    },
    cleanupFailures,
    scratchDirCleanupError,
    closePoolError,
    runs: runResults,
  };

  mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2) + "\n");

  console.log("");
  console.log(`measure.ts: ${successful.length}/${runs} run(s) succeeded, ${failed.length} failed.`);
  if (summaryMs) {
    console.log(
      `measure.ts: p50=${summaryMs.p50.toFixed(0)}ms  p95=${summaryMs.p95.toFixed(0)}ms  ` +
        `mean=${summaryMs.mean}ms  min=${summaryMs.min.toFixed(0)}ms  max=${summaryMs.max.toFixed(0)}ms`,
    );
  } else {
    console.log("measure.ts: no successful runs -- cannot compute p50/p95.");
  }
  console.log(`measure.ts: verdict counts: ${JSON.stringify(verdictCounts)}`);
  console.log(`measure.ts: wrote ${RESULTS_PATH}`);
  if (cleanupFailures.length > 0) {
    console.warn(
      `measure.ts: ${cleanupFailures.length} application row(s) could not be cleaned up — ` +
        `left behind in the worktree database: ${cleanupFailures.map((f) => f.applicationId).join(", ")}. ` +
        `The latency numbers above are still valid; this is a housekeeping failure, not a measurement one.`,
    );
  }
  if (scratchDirCleanupError) {
    console.warn(
      `measure.ts: the scratch image directory could not be removed (${scratchDirCleanupError}). ` +
        `The latency numbers above are still valid; this is a housekeeping failure, not a measurement one.`,
    );
  }
  if (closePoolError) {
    console.warn(
      `measure.ts: the database pool did not close cleanly (${closePoolError}). ` +
        `The latency numbers above are still valid; this is a housekeeping failure, not a measurement one.`,
    );
  }

  process.exitCode = computeExitCode({
    successfulCount: successful.length,
    failedCount: failed.length,
    cleanupFailureCount: cleanupFailures.length,
    scratchDirCleanupError,
    closePoolError,
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
