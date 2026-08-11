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
 * `var/uploads/`, and every application row this script creates is deleted
 * afterward (cascades to its label image, verification, field results, and
 * review-queue row) — the same cleanup `route.test.ts` does, so a
 * measurement run leaves the worktree database exactly as it found it.
 *
 * **What is NOT in this measurement, and why.** The warning subsystem
 * (LH-020) and the Sonnet resolver (LH-014) have not merged as of this
 * ticket — see `route.ts`'s own file comment. This harness exercises
 * exactly what is live on `main` today: Haiku extraction plus the
 * deterministic router, never Sonnet (TH-R19 — the cascade is the
 * architecture; Sonnet only ever runs on an escalation, asynchronously, off
 * the review queue, never inside this request). Every run below is
 * therefore a "fast path" measurement by construction, not a mix of fast
 * path and Sonnet-resolved escalation. Because `route.ts` passes
 * `warningResult: null` (honestly — LH-020 is not built), the government
 * warning field routes to `NEEDS_REVIEW` on every run that has one, which
 * usually rolls the label verdict up to `REVIEW`. This is expected, not a
 * bug: a `REVIEW` verdict here is still a same-request, synchronous answer
 * (PRD §3.8's "verdict or an explicit flag" clock) — it costs no extra
 * wall-clock time, because nothing asynchronous or Sonnet-side runs before
 * this script's timer stops.
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
import { summarizeLatencies, type LatencySummary } from "./percentile";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RESULTS_PATH = path.resolve(REPO_ROOT, "scripts/latency/results/single-label-verify.json");

/** The golden-set case this harness measures by default — the TH-R11
 * reference example (`golden-set/manifest.json`'s own note): a clean
 * spirits label with every field matching, no glare/rotation/degradation.
 * The realistic "fast path" image PRD §3.8 budgets against, not a
 * deliberately hard judgment case. */
const DEFAULT_CASE_ID = "case-01-clean-match-spirits";
const DEFAULT_RUNS = 20;

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

interface CliArgs {
  runs: number;
  caseId: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let runs = DEFAULT_RUNS;
  let caseId = DEFAULT_CASE_ID;
  // `pnpm run latency:check -- --runs=5` forwards the literal `--` token
  // into argv (npm strips it, pnpm does not — the same quirk
  // `scripts/run-tests.cjs` works around for `pnpm test`). Skip it rather
  // than reject it, so both `pnpm latency:check --runs=5` and
  // `pnpm latency:check -- --runs=5` work.
  for (const arg of argv) {
    if (arg === "--") continue;
    const runsMatch = /^--runs=(\d+)$/.exec(arg);
    if (runsMatch) {
      runs = Number(runsMatch[1]);
      continue;
    }
    const caseMatch = /^--case=(.+)$/.exec(arg);
    if (caseMatch) {
      caseId = caseMatch[1];
      continue;
    }
    throw new Error(`measure.ts: unrecognized argument "${arg}" (expected --runs=<n> or --case=<caseId>)`);
  }
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`measure.ts: --runs must be a positive integer, got ${runs}`);
  }
  return { runs, caseId };
}

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
    // Rounded to the nearest millisecond — sub-ms precision is noise at the
    // multi-second, network-bound scale this harness measures, and a
    // committed evidence file reads better without it.
    const durationMs = Math.round(performance.now() - start);
    const body: unknown = await response.json().catch(() => null);
    if (response.status !== 200) {
      const message =
        body && typeof body === "object" && "error" in body
          ? JSON.stringify((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
      return { index, durationMs, ok: false, httpStatus: response.status, error: message };
    }
    const success = body as {
      applicationId: number;
      labelVerdict: string;
      headlineReason: string | null;
    };
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

  const pool = new Pool({ connectionString });
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
          console.warn(`  run ${i}/${runs}: cleanup of application ${result.applicationId} failed:`, cleanupError);
        }
      }
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
    await pool.end();
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
      "-- warningResult is always null) and no Sonnet resolver (LH-014 not merged) -- every " +
      "run below is the fast path only; Sonnet never runs on the happy path (TH-R19).",
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

  if (successful.length === 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
