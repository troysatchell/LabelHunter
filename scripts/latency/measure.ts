/**
 * Latency harness for the single-label verify flow (TRO-471 / LH-031,
 * extended by TRO-539 / LH-034, TH-R2, PRD §3.8, §6).
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
 * for. Uploaded images are saved through this script's own database
 * connection (TRO-518 — `db-image-storage.ts` stores image bytes in
 * Postgres, not on disk). This script deletes every application row it
 * creates as it goes (cascades to that row's label image — and, since
 * TRO-518, that image's `label_image_blobs` row too — verification, field
 * results, and review-queue row) — the same cleanup `route.test.ts` does.
 * A delete failure is recorded, not silently retried or ignored (see
 * `main`'s `cleanupFailures`) — this is best-effort row cleanup, not a
 * guarantee the database ends up byte-for-byte as it started (sequence
 * counters still advance either way).
 *
 * **`--url=<origin>` mode (TRO-539).** Passing `--url` switches this
 * script from the in-process call above to a real multipart `fetch` POST
 * to `${url}/api/verify` — a genuine HTTP round-trip, over a real network
 * path, through whatever server is actually listening at `url`. This is
 * how the deployed-instance, Render `starter`-plan measurement TH-R2 also
 * needs will eventually run (blocked on Troy provisioning that
 * environment — see CHANGES.md's TRO-539 entry); it is also how this
 * ticket's own zero-cost validation runs, pointed at a LOCAL app whose
 * `ANTHROPIC_BASE_URL` targets `scripts/e2e/fake-anthropic-server.ts`
 * instead of the real Anthropic API. `ANTHROPIC_API_KEY` is NOT required
 * in this mode — the TARGET server holds its own key, not this script.
 * `DATABASE_URL` becomes OPTIONAL: when set, this script still connects
 * directly to clean up the rows it created, exactly like the in-process
 * mode; when unset (the honest case for a run against a real deployed
 * instance this machine has no direct database access to), cleanup is
 * skipped and that fact is recorded in `cleanupSkippedReason`, never
 * silently dropped. The percentile math, exit-code logic, and artifact
 * shape below are shared between both modes — only how one "run" is
 * produced differs (`runOnceInProcess` vs `runOnceHttp`). See
 * `target-info.ts` for how the artifact's own `pipelineScope` and `target`
 * fields are derived fresh from which mode actually ran, never hard-coded
 * (TRO-539's "provenance trap" fix).
 *
 * **What is NOT in this measurement, and why.** The Sonnet resolver
 * (LH-014, `src/server/resolver/`) has merged to `main`, but `route.ts`
 * never calls it — confirmed with `git diff`, not assumed: `route.ts` is
 * byte-identical before and after that merge. `handleVerifyRequest` never
 * calls Sonnet inline, on any run, escalated or not (TH-R19 — the cascade
 * is the architecture). Sonnet resolution, when it happens at all, runs
 * asynchronously off the `review_queue` table, on its own schedule,
 * outside this request and outside this script's timer. Every run below
 * is therefore a "fast path" measurement by construction, not a mix of
 * fast path and Sonnet-resolved escalation.
 *
 * **What IS in this measurement, since TRO-514.** The warning subsystem
 * (LH-020) is wired into `route.ts`: `compareGovernmentWarningFromImage`
 * runs region detection, OCR, and the exact statutory comparison on every
 * run whose label has a warning, concurrently with the Haiku call, not
 * after it (CP-2 §4.4). A number this script reports after TRO-514
 * includes that work; a number recorded before TRO-514 landed does not —
 * the two are not directly comparable. Since TRO-519, the OCR channel
 * itself is bounded by a 2000ms deadline (`OCR_TIMEOUT_MS`,
 * `src/server/warning/ocr.ts`) — a hung OCR worker degrades to `null`
 * instead of hanging this request (and this script's timer) forever.
 *
 * **Per-stage breakdown (TRO-539).** Every successful run's response
 * carries a `Server-Timing` header (`src/app/api/verify/server-timing.ts`)
 * with one entry per PRD §3.8 stage. The in-process mode gets this from
 * the same `Response` object `handleVerifyRequest` returns; `--url` mode
 * reads it off the real HTTP response. `--url` mode additionally
 * summarizes those per-stage samples (`stageBreakdownMs`) the same way the
 * overall total is summarized, reusing `summarizeLatencies` — the
 * in-process mode's own report leaves this `null` today (a possible
 * follow-up, not this ticket's scope: nothing stops wiring it up there
 * too, since the underlying header exists either way).
 *
 * **Failure handling.** A run that throws, or that the route answers with a
 * non-200 status, is recorded in the raw log with its own duration and
 * error detail, but excluded from the p50/p95 input — a hard failure is
 * neither a verdict nor a flag, so it is not a latency sample for TH-R2's
 * clock. If every run fails, the script still writes an artifact (honest
 * about zero successful samples) and exits non-zero.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
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
import { parseServerTimingHeader, SERVER_TIMING_STAGES, type ServerTimingStage, type StageTimingsMs } from "../../src/app/api/verify/server-timing";
import { extractLabel, HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor";
import { preprocessImage } from "../../src/server/preprocessing";
import { productionComparators } from "../../src/server/comparators";
import { saveLabelImage } from "../../src/server/storage/db-image-storage";
import { compareGovernmentWarningFromImage } from "../../src/server/warning";
import { parseArgs } from "./args";
import { cleanupScratchDirAndPool } from "./cleanup";
import { computeExitCode } from "./exit-status";
import { summarizeLatencies, type LatencySummary } from "./percentile";
import { parseVerifySuccessBody } from "./response";
import { buildPipelineScope, buildTargetInfo, type MeasurementBoundary, type TargetInfo } from "./target-info";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RESULTS_PATH = path.resolve(REPO_ROOT, "scripts/latency/results/single-label-verify.json");
/** Default output path for `--url` mode when `--out` is not given —
 * deliberately NOT `RESULTS_PATH`. `RESULTS_PATH` is the committed,
 * canonical evidence file for the real in-process billed measurement;
 * `--url` mode (a different measurement boundary, and — for a fake-model
 * or local validation run — not a TH-R2 number at all) must never
 * silently overwrite it just because someone forgot `--out=`. */
const DEFAULT_HTTP_RESULTS_PATH = path.resolve(REPO_ROOT, "scripts/latency/results/single-label-verify-url-mode.json");
const RENDER_YAML_PATH = path.resolve(REPO_ROOT, "render.yaml");

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
 * `route.test.ts`'s `buildFormData` pattern. Shared by both run modes:
 * `buildRequest` (below, in-process) wraps it in a `Request`; `runOnceHttp`
 * passes it straight to `fetch` as the real request body. */
function buildFormData(imageBytes: Buffer, imagePath: string, mediaType: string, caseSpec: GoldenSetCase): FormData {
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
  return fd;
}

function buildRequest(imageBytes: Buffer, imagePath: string, mediaType: string, caseSpec: GoldenSetCase): Request {
  const fd = buildFormData(imageBytes, imagePath, mediaType, caseSpec);
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
  /** Per-stage breakdown parsed off this run's own `Server-Timing`
   * response header (TRO-539). `undefined` when the response carried no
   * such header (any in-process run before this ticket's own change would
   * have had none; a `--url` run against an older deployment might not
   * either) — never fabricated from the total. */
  serverTimingMs?: Partial<StageTimingsMs>;
}

/** One `applications` row this script created but failed to delete
 * afterward. Recorded, never silently swallowed — see `main`'s own
 * `cleanupFailures` handling and this file's module comment. */
interface CleanupFailure {
  applicationId: number;
  error: string;
}

async function runOnceInProcess(
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
    const serverTimingHeader = response.headers.get("server-timing");
    const serverTimingMs = serverTimingHeader ? parseServerTimingHeader(serverTimingHeader) : undefined;
    const body: unknown = await response.json().catch(() => null);
    if (response.status !== 200) {
      const message =
        body && typeof body === "object" && "error" in body
          ? JSON.stringify((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
      return { index, durationMs, ok: false, httpStatus: response.status, error: message, serverTimingMs };
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
        serverTimingMs,
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
      serverTimingMs,
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

/**
 * TRO-539's `--url` mode: a real multipart POST over the network to
 * `verifyUrl`, instead of the in-process `handleVerifyRequest` call above.
 */
async function runOnceHttp(
  index: number,
  imageBytes: Buffer,
  imagePath: string,
  mediaType: string,
  caseSpec: GoldenSetCase,
  verifyUrl: string,
): Promise<RunResult> {
  const formData = buildFormData(imageBytes, imagePath, mediaType, caseSpec);
  const start = performance.now();
  let response: Response;
  try {
    response = await fetch(verifyUrl, { method: "POST", body: formData });
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

  // UNLIKE runOnceInProcess above, the clock here stops AFTER the body is
  // fully received, not before. `fetch`'s own promise resolves as soon as
  // response HEADERS arrive — the body may still be streaming in. A real
  // client waiting on this route has its answer only once the full body
  // has actually arrived over the wire, so `response.json()` below is part
  // of what this mode measures, not this harness's own bookkeeping (this
  // file's module comment explains why the in-process mode draws that line
  // differently: there, the equivalent parse is genuinely already-done
  // local bookkeeping, because `NextResponse.json(...)` serializes eagerly
  // before `handleVerifyRequest` ever returns).
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const durationMs = Math.round(performance.now() - start);
  const serverTimingHeader = response.headers.get("server-timing");
  const serverTimingMs = serverTimingHeader ? parseServerTimingHeader(serverTimingHeader) : undefined;

  if (response.status !== 200) {
    const message =
      body && typeof body === "object" && "error" in body
        ? JSON.stringify((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    return { index, durationMs, ok: false, httpStatus: response.status, error: message, serverTimingMs };
  }
  const success = parseVerifySuccessBody(body);
  if (!success) {
    return {
      index,
      durationMs,
      ok: false,
      httpStatus: response.status,
      error: "measure.ts: 200 response body did not match the expected VerifySuccessBody shape",
      serverTimingMs,
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
    serverTimingMs,
  };
}

interface MachineInfo {
  platform: string;
  arch: string;
  cpuModel: string | null;
  cpuCount: number;
  nodeVersion: string;
}

/** The machine this SCRIPT ran on — always this machine, in both modes.
 * In `--url` mode this is NOT necessarily the machine that did the
 * measured work (that's whatever's listening at the target URL); it still
 * matters, because it is the machine and network path the wall-clock timer
 * itself ran on. `target` (`TargetInfo`, below) records the other half:
 * what was actually being measured. */
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

/** `null` when `render.yaml` could not be read — `target-info.ts`'s
 * `buildTargetInfo` degrades its `renderPlan` field to `null` in that
 * case rather than throwing; a missing or unreadable `render.yaml` should
 * never crash a latency measurement run over one optional artifact
 * field. */
function readRenderYamlTextOrNull(): string | null {
  try {
    return readFileSync(RENDER_YAML_PATH, "utf8");
  } catch {
    return null;
  }
}

interface HarnessReport {
  ticket: string;
  measuredAt: string;
  /** In-process mode: `HAIKU_EXTRACTOR_MODEL` — this script calls
   * `extractLabel` directly, so the model IS a fact this script observed,
   * not an assumption. `--url` mode: this script never sees which model
   * the target actually calls (that is entirely the target server's own
   * choice) — the string below says so explicitly rather than repeating
   * `HAIKU_EXTRACTOR_MODEL` as if this script had confirmed it (TRO-539:
   * the same "claims carry provenance" discipline the `pipelineScope`
   * fix applies elsewhere in this file). */
  model: string;
  /** Non-null only when this run was invoked with `--note=<text>`
   * (TRO-539) — a run whose numbers are not a real TH-R2 measurement (a
   * fake-model or otherwise non-representative run) states that fact
   * here, inside the artifact itself, not only in a filename or a
   * changelog entry. */
  validationNote: string | null;
  goldenSetCase: {
    caseId: string;
    category: string;
    beverageType: string;
    imagePath: string;
  };
  pipelineScope: string;
  /** What this run's own request(s) actually crossed, and where they
   * landed (TRO-539). Derived fresh every run from the real `--url` value
   * (or its absence) and `render.yaml`'s own current text — see
   * `target-info.ts`'s header comment for the provenance-trap this
   * replaces. */
  target: TargetInfo;
  machine: MachineInfo;
  requestedRuns: number;
  successfulRuns: number;
  failedRuns: number;
  verdictCounts: Record<string, number>;
  summaryMs: LatencySummary | null;
  /** Per-PRD-§3.8-stage latency summary, built from every successful run's
   * own `Server-Timing` response header (TRO-539). `null` when no run
   * produced a parseable header at all (every in-process run before this
   * ticket; a `--url` run against a deployment that predates this
   * ticket's Server-Timing header). A stage present in some runs' headers
   * but not others is still summarized from however many samples it has —
   * `summarizeLatencies` requires at least one. */
  stageBreakdownMs: Partial<Record<ServerTimingStage, LatencySummary>> | null;
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
  /** Non-null only when this run had at least one successful
   * `applicationId` to clean up but no `DATABASE_URL` was available to
   * attempt it (TRO-539 — only reachable in `--url` mode; in-process mode
   * requires `DATABASE_URL` up front, so this is always `null` there).
   * Distinct from `cleanupFailures`: a failure means cleanup was
   * attempted and did not work; this means cleanup was never attempted at
   * all — not a failure, but not silently indistinguishable from "fully
   * cleaned up" either. */
  cleanupSkippedReason: string | null;
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
  const { runs, caseId, url, outPath, note } = parseArgs(process.argv.slice(2));
  const boundary: MeasurementBoundary = url !== undefined ? "http" : "in-process";
  // `new URL("/api/verify", url)` — not string concatenation — so a
  // `--url` value with or without a trailing slash both resolve to the
  // same, correct endpoint (args.ts validates `url` parses as an absolute
  // URL, so this constructor call cannot throw on a value that already
  // passed that check).
  const verifyUrl = url !== undefined ? new URL("/api/verify", url).toString() : null;

  if (boundary === "in-process" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "measure.ts: ANTHROPIC_API_KEY is not set. source .factory-env in a factory worktree, " +
        "or set it in .env.local before running pnpm latency:check. (Not required for --url " +
        "mode — the target server holds its own key, not this script.)",
    );
  }
  const connectionString = process.env.DATABASE_URL;
  if (boundary === "in-process" && !connectionString) {
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
  if (boundary === "in-process") {
    console.log(`measure.ts: boundary=in-process, model ${HAIKU_EXTRACTOR_MODEL} — each run is one real, live API call.`);
  } else {
    console.log(
      `measure.ts: boundary=http, target=${verifyUrl} — whether this costs real money depends ` +
        `entirely on what is actually listening there (a real deployment vs. a fake-model ` +
        `validation server).`,
    );
  }

  // Connects a database pool whenever a connection string is available —
  // required up front for in-process mode (already thrown above if
  // missing), optional and best-effort for --url mode (used only for
  // cleanup there; see the module comment).
  let pool: Pool | null = null;
  let db: VerifyRouteDeps["db"] | null = null;
  if (connectionString) {
    pool = new Pool({
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
    db = drizzle(pool, { schema });
  }

  // One request-runner closure per mode, built once, called once per loop
  // iteration below — keeps the run loop, cleanup, and report-building
  // code identical for both modes (ticket TRO-539: "preserving the
  // existing percentile math, exit-status logic, cleanup, and artifact
  // shape"). Explicit thrown invariants below, not a `!` assertion —
  // standing rule 13 — even though both are unreachable in practice: the
  // guard clauses above already require DATABASE_URL before in-process
  // mode reaches here, and `verifyUrl` is only ever null when `url` is
  // undefined, which is exactly when `boundary` is "in-process".
  let requestRunner: (index: number) => Promise<RunResult>;
  if (boundary === "in-process") {
    if (!db) {
      throw new Error("measure.ts: internal invariant violated — in-process mode reached with no database connection");
    }
    const inProcessDb = db;
    const inProcessDeps: VerifyRouteDeps = {
      db: inProcessDb,
      preprocessImage,
      extractLabel,
      compareGovernmentWarning: compareGovernmentWarningFromImage,
      // TRO-518: writes through the SAME `db` connection this script already
      // opened for its own queries, not a scratch directory.
      saveLabelImage: (bytes, originalFilename) => saveLabelImage(bytes, originalFilename, { db: inProcessDb }),
      comparators: productionComparators,
    };
    requestRunner = (i) => runOnceInProcess(i, imageBytes, imagePath, mediaType, caseSpec, inProcessDeps);
  } else {
    if (verifyUrl === null) {
      throw new Error("measure.ts: internal invariant violated — http mode reached with no target URL");
    }
    const target = verifyUrl;
    requestRunner = (i) => runOnceHttp(i, imageBytes, imagePath, mediaType, caseSpec, target);
  }

  const runResults: RunResult[] = [];
  const cleanupFailures: CleanupFailure[] = [];
  const cleanupSkippedApplicationIds: number[] = [];
  const stageSamplesMs: Partial<Record<ServerTimingStage, number[]>> = {};
  let scratchDirCleanupError: string | null = null;
  let closePoolError: string | null = null;
  try {
    for (let i = 1; i <= runs; i++) {
      const result = await requestRunner(i);
      runResults.push(result);
      if (result.ok) {
        console.log(`  run ${i}/${runs}: ${result.durationMs.toFixed(0)}ms — verdict ${result.labelVerdict}${result.headlineReason ? ` (${result.headlineReason})` : ""}`);
      } else {
        console.log(`  run ${i}/${runs}: ${result.durationMs.toFixed(0)}ms — FAILED: ${result.error}`);
      }
      if (result.serverTimingMs) {
        for (const stage of SERVER_TIMING_STAGES) {
          const value = result.serverTimingMs[stage];
          if (value !== undefined) {
            (stageSamplesMs[stage] ??= []).push(value);
          }
        }
      }
      if (result.applicationId !== undefined) {
        if (db) {
          try {
            await db.delete(schema.applications).where(eq(schema.applications.id, result.applicationId));
          } catch (cleanupError) {
            const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            console.warn(`  run ${i}/${runs}: cleanup of application ${result.applicationId} failed: ${message}`);
            cleanupFailures.push({ applicationId: result.applicationId, error: message });
          }
        } else {
          cleanupSkippedApplicationIds.push(result.applicationId);
        }
      }
    }
  } finally {
    // `cleanupScratchDirAndPool` never throws (see cleanup.ts), so this
    // `finally` block always completes normally and `main` always reaches
    // the report-writing code below. An earlier version let a cleanup
    // error propagate past this whole function, silently discarding every
    // already-completed, already-paid-for run's results (a real PR review
    // finding, not a hypothetical).
    //
    // TRO-518: `saveLabelImage` now writes through `db`, not a scratch
    // directory, so the first step is a no-op — kept, rather than dropped,
    // so `scratchDirCleanupError` below still matches `HarnessReport`'s and
    // `computeExitCode`'s existing shape (`exit-status.ts`). It can no
    // longer be non-null; left in place rather than removed from either
    // interface, which is a bigger change than this ticket's storage-
    // adapter scope.
    //
    // TRO-539: `pool` is `null` when no `DATABASE_URL` was available at
    // all (only reachable in `--url` mode) — nothing to close in that
    // case.
    const closePool = pool ? () => pool.end() : async () => {};
    ({ scratchDirCleanupError, closePoolError } = await cleanupScratchDirAndPool(async () => {}, closePool));
    if (scratchDirCleanupError) {
      console.warn(`measure.ts: unexpected error during cleanup: ${scratchDirCleanupError}`);
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

  const stageBreakdownMs: Partial<Record<ServerTimingStage, LatencySummary>> | null =
    Object.keys(stageSamplesMs).length > 0
      ? SERVER_TIMING_STAGES.reduce<Partial<Record<ServerTimingStage, LatencySummary>>>((acc, stage) => {
          const samples = stageSamplesMs[stage];
          if (samples && samples.length > 0) acc[stage] = summarizeLatencies(samples);
          return acc;
        }, {})
      : null;

  const cleanupSkippedReason: string | null =
    cleanupSkippedApplicationIds.length > 0
      ? `DATABASE_URL not set — ${cleanupSkippedApplicationIds.length} application row(s) left ` +
        `uncleaned on the target's own database: ${cleanupSkippedApplicationIds.join(", ")}.`
      : null;

  const target = buildTargetInfo(url ?? null, readRenderYamlTextOrNull());

  const report: HarnessReport = {
    ticket: "TRO-471 / LH-031 (extended by TRO-539 / LH-034: --url mode, Server-Timing breakdown, target provenance)",
    measuredAt: new Date().toISOString(),
    model:
      boundary === "in-process"
        ? HAIKU_EXTRACTOR_MODEL
        : `not observed by this script -- the target server (${target.host ?? "unknown host"}) makes its ` +
          `own model choice; this repo's own code names ${HAIKU_EXTRACTOR_MODEL}, but --url mode never ` +
          `confirms the target is actually running it`,
    validationNote: note ?? null,
    goldenSetCase: {
      caseId: caseSpec.caseId,
      category: caseSpec.category,
      beverageType: caseSpec.beverageType,
      imagePath: caseSpec.imagePath,
    },
    pipelineScope: buildPipelineScope(target.boundary),
    target,
    machine: readMachineInfo(),
    requestedRuns: runs,
    successfulRuns: successful.length,
    failedRuns: failed.length,
    verdictCounts,
    summaryMs,
    stageBreakdownMs,
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
    cleanupSkippedReason,
    scratchDirCleanupError,
    closePoolError,
    runs: runResults,
  };

  const resultsPath = outPath !== undefined ? path.resolve(REPO_ROOT, outPath) : boundary === "http" ? DEFAULT_HTTP_RESULTS_PATH : RESULTS_PATH;
  mkdirSync(path.dirname(resultsPath), { recursive: true });
  writeFileSync(resultsPath, JSON.stringify(report, null, 2) + "\n");

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
  console.log(
    `measure.ts: target — boundary=${target.boundary} host=${target.host ?? "n/a"} ` +
      `renderPlan=${target.renderPlan ?? "n/a"}`,
  );
  if (stageBreakdownMs) {
    for (const stage of SERVER_TIMING_STAGES) {
      const s = stageBreakdownMs[stage];
      if (s) console.log(`measure.ts: stage ${stage}: p50=${s.p50.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms (n=${s.count})`);
    }
  }
  console.log(`measure.ts: wrote ${resultsPath}`);
  if (cleanupFailures.length > 0) {
    console.warn(
      `measure.ts: ${cleanupFailures.length} application row(s) could not be cleaned up — ` +
        `left behind in the worktree database: ${cleanupFailures.map((f) => f.applicationId).join(", ")}. ` +
        `The latency numbers above are still valid; this is a housekeeping failure, not a measurement one.`,
    );
  }
  if (cleanupSkippedReason) {
    console.warn(`measure.ts: ${cleanupSkippedReason} The latency numbers above are still valid.`);
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
