/**
 * The verdict-variance runner (LH-038 / TRO-543, TH-R10 stretch, TH-R17,
 * TH-R19). `pnpm eval:variance`.
 *
 * WHY THIS SCRIPT EXISTS. This ticket's own `CHANGES.md` entry has the full
 * finding: case-17 (glare-front-label) returned three REVIEW and two PASS
 * verdicts across five committed runs of unchanged code against an
 * unchanged image. `temperature: 0` (`src/server/extractor/request.ts:51`)
 * has never guaranteed identical output (CP-1's own words, `cp1:302`) —
 * this is real call-to-call model variance, not a harness bug. This script
 * measures HOW MUCH variance, mechanically and repeatably, instead of
 * relying on hand archaeology through committed report history every time
 * the question comes up.
 *
 * DOES NOT FIX ANYTHING. No retry, no lower temperature, no
 * self-consistency vote — LH-038's brief is explicit that the deliverable
 * is a measured number and a written statement, never a mitigation.
 *
 * REUSES THE REAL CASCADE, NOT A SECOND PATH. Every (case, repeat) pair
 * runs through `runOneCase` (`cascade-runner.ts`) — the SAME function
 * `check.ts` and `benchmark.ts` already trust (TH-R19: the cascade is the
 * architecture; a harness that measured a different path would not be
 * measuring the thing this ticket's finding is about).
 *
 * TWO MODES, the same shape as `check.ts`:
 *
 *   - `pnpm eval:variance` (no flags): cheap mode. Reads back the last
 *     committed `scripts/eval/results/variance-report.json`, if one exists,
 *     and prints its headline numbers. No live call, ever. Prints a clear
 *     message and exits 0 if no report has been committed yet — expected
 *     before the first real sweep (TRO-543 Part 2, gated on Troy's
 *     go-ahead: see this ticket's `CHANGES.md` entry for the cost
 *     estimate).
 *   - `pnpm eval:variance -- --live [--full | --case=<id>] [--repeats=<k>]`:
 *     runs `--repeats`'s K real cascade repeats (default `DEFAULT_REPEATS`,
 *     capped at `MAX_REPEATS` — both `args.ts`) over `resolveCaseIds`'s N
 *     cases (default `DEFAULT_SAMPLE_CASE_IDS`, 8 cases; `--full` runs the
 *     whole manifest; `--case=<id>` runs exactly one) — N x K real, paid
 *     cascade runs. Unlike `check.ts`'s own `--case=<id>` (a debug mode
 *     that never touches the committed report), THIS script's
 *     `--case=<id>` still writes `variance-report.json`: the smallest real
 *     invocation (`--case=<id> --repeats=1`) is this script's own proof
 *     that the artifact writer works, and skipping the write would skip
 *     the one thing that invocation exists to prove.
 *
 * COST DISCIPLINE. N x K real calls, at real per-call Haiku/resolver cost
 * (`usage.ts`). `args.ts`'s `MAX_CASES` and `MAX_REPEATS` cap the two axes
 * SEPARATELY, on purpose (LH-038's brief: cases and repeats are different
 * axes; never raise `MAX_CASES` to fit more repeats).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/lib/db/schema";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import { HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor";
import { SONNET_RESOLVER_MODEL } from "../../src/server/resolver";
import { cleanupScratchDirAndPool } from "../latency/cleanup";
import { parseVarianceArgs, resolveCaseIds, validateVarianceArgs, type VarianceCliArgs } from "./args";
import { REPO_ROOT, runOneCase, type CaseRunOutcome } from "./cascade-runner";
import { validateVarianceReport } from "./report-validation";
import { buildVarianceReport, type VarianceCaseFailure, type VarianceCaseRun, type VarianceReport } from "./variance-analysis";

const REPORT_PATH = path.resolve(REPO_ROOT, "scripts/eval/results/variance-report.json");

/** Best-effort provenance, never a reason to abandon an already-paid-for
 * sweep's results — the same "never lose real evidence over a
 * housekeeping failure" discipline as `cascade-runner.ts`'s own
 * `cleanupApplicationRow`. */
function currentCommitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch (cause) {
    console.warn(`variance.ts: could not read the current commit SHA: ${cause instanceof Error ? cause.message : String(cause)}`);
    return "unknown";
  }
}

function printRunLine(caseId: string, repeatIndex: number, repeats: number, outcome: CaseRunOutcome): void {
  if (outcome.failure) {
    console.log(`  ${caseId} [${repeatIndex}/${repeats}]: FAILED — ${outcome.failure.error}`);
    return;
  }
  const r = outcome.result!;
  const verdictNote = r.verdict.labelVerdictCorrect
    ? "verdict OK"
    : `verdict WRONG (expected ${r.verdict.expectedLabelVerdict}, got ${r.verdict.actualLabelVerdict})`;
  console.log(
    `  ${caseId} [${repeatIndex}/${repeats}]: ${r.verdict.actualLabelVerdict}/${r.verdict.actualReviewReason ?? "null"}, ${verdictNote}, ` +
      `haiku $${r.haikuCost.usd.toFixed(4)}`,
  );
}

function printReportSummary(report: VarianceReport): void {
  console.log("");
  console.log(
    `variance.ts: ${report.summary.caseCount} case(s) x ${report.repeats} repeat(s) nominal, ${report.failures.length} failure(s).`,
  );
  if (report.summary.incompleteCaseCount > 0) {
    console.log(
      `variance.ts: ${report.summary.incompleteCaseCount} case(s) did not complete all ${report.summary.nominalRepeats} repeat(s) — ` +
        "excluded from corpus stability and accuracy spread below (still recorded in full under \"perCase\").",
    );
  }
  console.log(
    `variance.ts: corpus stability ${(report.summary.stableCaseRate.rate * 100).toFixed(1)}% ` +
      `(${report.summary.stableCaseRate.correct}/${report.summary.stableCaseRate.total} cases returned the same verdict every repeat)`,
  );
  if (report.summary.accuracySpread.available) {
    console.log(
      `variance.ts: label-verdict accuracy spread ${(report.summary.accuracySpread.lowestRate! * 100).toFixed(1)}% - ` +
        `${(report.summary.accuracySpread.highestRate! * 100).toFixed(1)}% across ${report.summary.accuracySpread.perRun.length} repeat(s)`,
    );
  } else {
    console.log("variance.ts: label-verdict accuracy spread unavailable — no case completed every requested repeat.");
  }
  console.log(`variance.ts: total measured cost $${report.totalCostUsd.toFixed(4)}`);
}

async function runLive(args: VarianceCliArgs): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("variance.ts: ANTHROPIC_API_KEY is not set. source .factory-env in a factory worktree, or set it in .env.local.");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("variance.ts: DATABASE_URL is not set. source .factory-env in a factory worktree, or set it in .env.local.");
  }

  const manifest = loadGoldenSetManifest();
  const allCaseIds = manifest.cases.map((c) => c.caseId);
  const caseIds = resolveCaseIds(args, allCaseIds);
  const casesById = new Map(manifest.cases.map((c) => [c.caseId, c]));

  console.log(
    `variance.ts: running ${caseIds.length} case(s) x ${args.repeats} repeat(s) = ${caseIds.length * args.repeats} real cascade run(s) against the real API.`,
  );

  const pool = new Pool({
    connectionString,
    // Same two safeguards as src/lib/db/index.ts's shared pool and every
    // other eval/latency script's own dedicated pool.
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => {
    console.error("variance.ts: unexpected error on idle Postgres client", err);
  });
  const db = drizzle(pool, { schema });
  const scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro543-variance-"));

  const runs: VarianceCaseRun[] = [];
  const failures: VarianceCaseFailure[] = [];
  try {
    for (let ci = 0; ci < caseIds.length; ci++) {
      const caseSpec = casesById.get(caseIds[ci])!;
      for (let repeatIndex = 1; repeatIndex <= args.repeats; repeatIndex++) {
        // runOneCase catches most real-world failures into
        // CaseRunOutcome.failure (cascade-runner.ts) but is NOT guaranteed
        // never to throw — its own doc comments name deliberate
        // "harness bug, not a case result" throws (e.g. a router-verdict
        // consistency check) that propagate past it. check.ts/benchmark.ts
        // each run N such calls; this script runs N x K, so ONE throw
        // partway through a real sweep risks losing every already-paid-for
        // repeat before it (a PR review finding, TRO-543) — the same
        // "must not take down the whole sweep" concern cascade-runner.ts's
        // own resolver-call try/catch already documents, applied one level
        // up. The error's own message (self-labeling — cascade-runner.ts's
        // harness-bug throws say so in the text) still reaches the report
        // either way, so a real harness bug stays visible in `failures`,
        // just without aborting every repeat still to come.
        let outcome: CaseRunOutcome;
        try {
          outcome = await runOneCase(caseSpec, db, scratchDir);
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause);
          console.warn(`  ${caseSpec.caseId} [${repeatIndex}/${args.repeats}]: FAILED — runOneCase threw: ${error}`);
          failures.push({ caseId: caseSpec.caseId, repeatIndex, error });
          continue;
        }
        printRunLine(caseSpec.caseId, repeatIndex, args.repeats, outcome);
        if (outcome.failure) {
          failures.push({ ...outcome.failure, repeatIndex });
        } else {
          runs.push({ ...outcome.result!, repeatIndex });
        }
      }
    }
  } finally {
    const { scratchDirCleanupError, closePoolError } = await cleanupScratchDirAndPool(
      () => rm(scratchDir, { recursive: true, force: true }),
      () => pool.end(),
    );
    if (scratchDirCleanupError) console.warn(`variance.ts: failed to remove scratch directory ${scratchDir}: ${scratchDirCleanupError}`);
    if (closePoolError) console.warn(`variance.ts: failed to close the database pool: ${closePoolError}`);
  }

  const report = buildVarianceReport({
    ticket: "TRO-543 / LH-038",
    measuredAt: new Date().toISOString(),
    haikuModel: HAIKU_EXTRACTOR_MODEL,
    sonnetModel: SONNET_RESOLVER_MODEL,
    manifestVersion: manifest.version,
    // TODO(TRO-538 / LH-033): scripts/eval/manifest-hash.ts does not exist
    // on this branch yet — see this field's own doc comment in
    // variance-analysis.ts. Wire hashManifestFile(DEFAULT_MANIFEST_PATH) in
    // here once it lands on main.
    manifestContentHash: null,
    commitSha: currentCommitSha(),
    requestedFull: args.full,
    caseIds,
    repeats: args.repeats,
    runs,
    failures,
  });

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  printReportSummary(report);
  console.log(`variance.ts: wrote ${REPORT_PATH}`);

  if (failures.length > 0) {
    console.error(`variance.ts: ${failures.length} repeat(s) failed to run — see the "failures" array in the report.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

function runCheap(): void {
  if (!existsSync(REPORT_PATH)) {
    console.log(
      `variance.ts: no committed variance report at ${REPORT_PATH} yet. This is expected before the first ` +
        "--live sweep (TRO-543 Part 2, gated on Troy's go-ahead — see CHANGES.md). Run: " +
        "pnpm eval:variance -- --live --repeats=<k> to produce one.",
    );
    process.exitCode = 0;
    return;
  }
  const report = validateVarianceReport(JSON.parse(readFileSync(REPORT_PATH, "utf8")), REPORT_PATH);
  console.log(`variance.ts: cheap mode — reading the committed report (measured ${report.measuredAt}). No live call made.`);
  printReportSummary(report);
  process.exitCode = 0;
}

async function main(): Promise<void> {
  const args = parseVarianceArgs(process.argv.slice(2));
  validateVarianceArgs(args);
  if (args.live) {
    await runLive(args);
  } else {
    runCheap();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
