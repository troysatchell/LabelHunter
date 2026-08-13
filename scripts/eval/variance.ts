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
import { DEFAULT_MANIFEST_PATH, loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import { hashManifestFile } from "./manifest-hash";
import { HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor";
import { SONNET_RESOLVER_MODEL } from "../../src/server/resolver";
import { cleanupScratchDirAndPool } from "../latency/cleanup";
import { parseVarianceArgs, resolveCaseIds, validateVarianceArgs, type VarianceCliArgs } from "./args";
import { REPO_ROOT, runOneCase, type CaseRunOutcome } from "./cascade-runner";
import { validateVarianceReport } from "./report-validation";
import {
  buildVarianceReport,
  findMissingCaseIds,
  isNarrowerReport,
  type VarianceCaseFailure,
  type VarianceCaseRun,
  type VarianceReport,
} from "./variance-analysis";

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
  // cascadeVerdict, not routerVerdict (TRO-538 / LH-033's pre-resolution
  // interim stage) -- the real end state a user sees, which is what a
  // verdict-STABILITY question is actually about. Merge-integration
  // decision, TRO-543 predates the routerVerdict/cascadeVerdict split.
  const verdictNote = r.cascadeVerdict.labelVerdictCorrect
    ? "verdict OK"
    : `verdict WRONG (expected ${r.cascadeVerdict.expectedLabelVerdict}, got ${r.cascadeVerdict.actualLabelVerdict})`;
  console.log(
    `  ${caseId} [${repeatIndex}/${repeats}]: ${r.cascadeVerdict.actualLabelVerdict}/${r.cascadeVerdict.actualReviewReason ?? "null"}, ${verdictNote}, ` +
      `haiku $${r.haikuCost.usd.toFixed(4)}`,
  );
}

/**
 * Warns, loudly, before a real `--live` run's report would silently
 * replace a wider committed report with a narrower one (a PR review
 * finding, TRO-543) — e.g. a one-case, one-repeat mechanical-proof
 * invocation run again, by hand, after a real N x K sweep's own valuable
 * report is already committed. `writeFileSync` still runs unconditionally
 * either way (this is a warning, not a refusal — a deliberate, narrower
 * `--case=<id>` debug run is a legitimate thing to want); the warning
 * exists so that choice is never made by accident. Never throws: a
 * missing or malformed previous report is not a reason to lose the
 * current, valid, already-computed one — it just means there is nothing
 * to compare against.
 */
function warnIfNarrowingCommittedReport(report: VarianceReport): void {
  if (!existsSync(REPORT_PATH)) return;
  let previous: VarianceReport;
  try {
    previous = validateVarianceReport(JSON.parse(readFileSync(REPORT_PATH, "utf8")), REPORT_PATH);
  } catch (cause) {
    console.warn(
      `variance.ts: could not read the previously committed report to compare scope — proceeding: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return;
  }
  if (isNarrowerReport(report, previous)) {
    console.warn(
      `variance.ts: WARNING — this run (${report.caseIds.length} case(s) x ${report.repeats} repeat(s)) is NARROWER than the ` +
        `already-committed report (${previous.caseIds.length} case(s) x ${previous.repeats} repeat(s), measured ${previous.measuredAt}). ` +
        `Writing this report will replace the wider one. Run "git restore ${path.relative(REPO_ROOT, REPORT_PATH)}" to keep the wider one instead.`,
    );
  }
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

  // resolveCaseIds validates --case=<id> against the manifest, and --full
  // reads case IDs straight from it — both paths are already safe.
  // DEFAULT_SAMPLE_CASE_IDS (args.ts) is a hard-coded list `resolveCaseIds`
  // does NOT filter against the manifest (that function's own doc comment
  // says so) — if the manifest ever drops a case that list still names,
  // `casesById.get(...)` below would return `undefined`, and the loop's
  // own `!` assertion would turn that into a confusing crash deep inside
  // `runOneCase`, possibly after real API money for earlier cases in the
  // same sweep is already spent (a PR review finding, TRO-543). Fail
  // loudly here instead, before the DB pool or scratch dir even exist.
  const missingFromManifest = findMissingCaseIds(caseIds, new Set(allCaseIds));
  if (missingFromManifest.length > 0) {
    throw new Error(
      `variance.ts: case ID(s) not found in the loaded golden-set manifest: ${missingFromManifest.join(", ")}. ` +
        "DEFAULT_SAMPLE_CASE_IDS (args.ts) is not filtered against the manifest — update one of the two.",
    );
  }

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
          // TRO-518: `runOneCase` writes label images through `db` now —
          // the scratch-directory parameter is gone. The directory itself
          // stays, matching check.ts's kept-as-no-op cleanup shape.
          outcome = await runOneCase(caseSpec, db);
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
    // manifest-hash.ts landed on main (TRO-538/535 wave) and arrived here
    // with the origin/main merge — the TODO that stood here is resolved.
    // Same call shape as check.ts's own report assembly.
    manifestContentHash: hashManifestFile(DEFAULT_MANIFEST_PATH),
    commitSha: currentCommitSha(),
    requestedFull: args.full,
    caseIds,
    repeats: args.repeats,
    runs,
    failures,
  });

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  warnIfNarrowingCommittedReport(report);
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
