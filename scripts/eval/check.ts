/**
 * The eval harness's regression gate (LH-030 / TRO-470, TH-R17, TH-R19,
 * PRD §6). `pnpm eval:check` — gate G8 in `scripts/factory/gate.sh`.
 *
 * TWO MODES, and why the bare command is cheap by default.
 *
 * `pnpm eval:check` (no flags) never makes a live API call. It reads the
 * committed evidence — `scripts/eval/results/eval-report.json` (the last
 * real `--live` run) and `scripts/eval/baseline.json` (the committed
 * floor) — and checks whether the report still covers the baseline's
 * cases and still meets its accuracy. This is the mode `gate.sh` and CI
 * both call, unconditionally, on every run. A real, per-case pipeline
 * sweep costs real, per-request API money (CLAUDE.md: this ticket "costs
 * real money"); a gate that fires on every push or every ticket's gate run
 * cannot also be the thing that pays for a live sweep, or the per-commit
 * cost is unbounded. `scripts/golden/verify.ts` and
 * `scripts/golden/renderSmoke.ts` (TRO-499) already established the
 * convention this design follows: CI-safe checks make no live/network
 * call. See `CHANGES.md`'s TRO-470 entry for the full CI-wiring reasoning,
 * including the alternative this design rejected.
 *
 * CHEAP MODE ALSO CHECKS FOR MANIFEST DRIFT AGAINST THE LIVE FILE (TRO-556).
 * `compareToBaseline`'s `"stale-baseline"` class compares the committed
 * report's `manifestContentHash` against the committed baseline's — two
 * frozen files checked against each other. That misses the case where a
 * corpus rebuild edited `golden-set/manifest.json` and both frozen files
 * went stale TOGETHER, still agreeing with each other while describing
 * images that no longer exist. `runCheap` hashes the live manifest file
 * (a local file read, not a live API call, so this stays cheap) and warns,
 * loudly and by name, on a mismatch — see `manifest-drift.ts`'s own module
 * comment for why this is a warning, never a gate failure.
 *
 * `pnpm eval:check -- --live` runs the real cascade — real Haiku
 * extraction plus, only for cases the router actually escalates, one real
 * Sonnet resolver call (never forced onto a case the cascade would not
 * route to it) — over a case sample, scores it, writes a fresh
 * `eval-report.json`, and THEN runs the same baseline comparison against
 * the fresh numbers. This is the expensive, deliberate, human-or-agent-
 * invoked mode — never automatic, matching `scripts/latency/measure.ts`'s
 * own real-money discipline. `--full` runs the whole golden set instead of
 * the default 8-case sample (`args.ts`); `--case=<id>` runs one named case
 * for debugging and never touches the committed report or baseline.
 * `--update-baseline` no longer writes `baseline.json` here (TRO-561) —
 * see "THE BASELINE IS A BAND, NOT A POINT" below for where that moved.
 *
 * SCOPE: verdict accuracy is scored at the ROUTER level — does
 * `routeLabel`'s real output (via `handleVerifyRequest`, the same
 * in-process pattern `measure.ts` uses, not a real HTTP round-trip) match
 * the golden set's `expected` block? This matches both production
 * (`route.ts` never calls Sonnet inline, TH-R19) and the manifest's own
 * ground truth (`expected.labelVerdict: "REVIEW"` is a correct terminal
 * answer for a case a human still needs to look at, not something this
 * scorer expects the resolver to resolve further — see
 * `verdict-scoring.ts`'s module comment). The resolver still runs for real
 * on every escalated case (`cascade-runner.ts`), because this ticket's
 * brief asks for that and because it is the only way to get real Sonnet
 * cost/latency evidence and to exercise `resolveEscalatedLabel` against
 * real golden-set images end-to-end (as of this ticket, no production code
 * path calls it yet) — but its output is reported, never scored against a
 * fabricated ground truth the manifest does not have.
 *
 * THE BASELINE IS A BAND, NOT A POINT (TRO-561). `scripts/eval/baseline.json`
 * used to pin the floor to one historical run's exact number — TRO-543 / LH-038
 * measured a real 3.2-point call-to-call spread on unchanged code against
 * unchanged images, so a floor pinned to the TOP of that spread failed two
 * of three honest re-runs. The baseline is now a K-repeat band
 * (`EvalBaseline`, `types.ts`) established by the re-baseline protocol —
 * `scripts/eval/variance.ts`'s `--establish-baseline`, which extends the
 * existing `eval:variance` sweep rather than adding a second cascade path.
 * `compareToBaseline` (`baseline-compare.ts`) reports THREE DISTINCT
 * problem classes, never conflated into one undifferentiated list:
 * `"accuracy-below-band"` (a real regression — a headline rate fell below
 * its own measured floor), `"stale-baseline"` (the corpus moved since the
 * band was measured — a staleness question, fixed by re-running the
 * protocol, not by finding a code regression that is not there), and
 * `"coverage-mismatch"` (the current run's case set does not cover the
 * band's own cases — run `--live --full`).
 *
 * CHEAP-MODE STALE-BASELINE IS A LOUD WARNING, NOT A BLOCK. Cheap mode runs
 * on EVERY push, on every ticket's gate, regardless of whether that ticket
 * touched `golden-set/`. If a `"stale-baseline"` problem alone (no
 * accuracy-below-band, no coverage-mismatch) blocked cheap mode, then any
 * PR merging after a corpus edit would fail CI for a reason it did not
 * cause, until someone spent real API money re-baselining — the exact
 * "gate cries wolf, gets routed around" failure this whole ticket exists to
 * fix, just relocated onto a new axis. So: a `"stale-baseline"`-only result
 * prints loudly (never silently) and STILL PASSES (exit 0) in cheap mode;
 * `"accuracy-below-band"` or `"coverage-mismatch"`, in either mode, still
 * fails. Live mode fails on `"stale-baseline"` too — an operator who just
 * spent real money on a `--live` sweep should be stopped and pointed at the
 * re-baseline protocol before trusting a comparison against a corpus that
 * has already moved on.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/lib/db/schema";
import { DEFAULT_MANIFEST_PATH, loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import { HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor";
import { SONNET_RESOLVER_MODEL } from "../../src/server/resolver";
import { cleanupScratchDirAndPool } from "../latency/cleanup";
import { parseEvalArgs, resolveCaseIds, validateCheckArgs } from "./args";
import { compareToBaseline, formatBandLine, hasProblemClass, type RegressionCheckResult } from "./baseline-compare";
import { REPO_ROOT, runOneCase, type CaseRunOutcome } from "./cascade-runner";
import { checkManifestDrift } from "./manifest-drift";
import { hashManifestFile } from "./manifest-hash";
import { validateEvalBaseline, validateEvalReport } from "./report-validation";
import { buildEvalReportSummary } from "./summary";
import type { CascadeCaseResult, EvalBaseline, EvalCaseFailure, EvalReport, EvalReportSummary } from "./types";

const REPORT_PATH = path.resolve(REPO_ROOT, "scripts/eval/results/eval-report.json");
const BASELINE_PATH = path.resolve(REPO_ROOT, "scripts/eval/baseline.json");

function printCaseLine(outcome: CaseRunOutcome, index: number, total: number): void {
  if (outcome.failure) {
    console.log(`  [${index}/${total}] ${outcome.failure.caseId}: FAILED — ${outcome.failure.error}`);
    return;
  }
  const r = outcome.result!;
  const extractionCorrect = r.extraction.fields.filter((f) => f.correct).length;
  const routerNote = r.routerVerdict.labelVerdictCorrect
    ? "router OK"
    : `router WRONG (expected ${r.routerVerdict.expectedLabelVerdict}, got ${r.routerVerdict.actualLabelVerdict})`;
  // Printed only when the cascade end state actually differs from the
  // router's own interim verdict (TRO-538 / LH-033) — the common case is
  // "nothing escalated, so they are identical," and repeating that on every
  // line would bury the cases where the merge actually did something.
  const cascadeDiverges = r.cascadeVerdict.actualLabelVerdict !== r.routerVerdict.actualLabelVerdict;
  const cascadeNote = cascadeDiverges
    ? `, cascade end state: ${r.cascadeVerdict.actualLabelVerdict} (${r.cascadeVerdict.labelVerdictCorrect ? "correct" : "WRONG"})`
    : "";
  const resolverNote = r.resolverOutcome
    ? `, resolver: ${r.resolverOutcome} ($${r.resolverCost!.usd.toFixed(4)})`
    : r.resolverError
      ? `, resolver: FAILED (${r.resolverError})`
      : "";
  console.log(
    `  [${index}/${total}] ${r.caseId}: extraction ${extractionCorrect}/5, ${routerNote}${cascadeNote}, haiku $${r.haikuCost.usd.toFixed(4)}${resolverNote}`,
  );
}

/** Prints the two banded metrics' own pass/fail line in TRO-561's
 * variance-aware language ("78.1% is within the measured 78.1-81.3% band")
 * on EVERY run, pass or fail — a silent pass would leave a reader unable to
 * tell "within band" from "not checked at all". */
function printBandLines(summary: EvalReportSummary, baseline: EvalBaseline): void {
  console.log(`check.ts: ${formatBandLine("extraction accuracy", summary.extractionAccuracy.rate, baseline.extractionAccuracyBand, baseline.k)}`);
  console.log(
    `check.ts: ${formatBandLine("cascade-verdict accuracy", summary.cascadeVerdictAccuracy.rate, baseline.cascadeVerdictAccuracyBand, baseline.k)}`,
  );
}

/**
 * Prints `result`'s problems grouped by class and decides PASS/WARN/FAIL —
 * see this file's own module comment for the cheap-vs-live mode split.
 * Cheap mode downgrades a `"stale-baseline"`-ONLY result to a loud,
 * non-blocking warning; every other case (any `"accuracy-below-band"` or
 * `"coverage-mismatch"` problem, in either mode; ANY problem at all in live
 * mode) fails. Returns the decision so callers set `process.exitCode`
 * themselves rather than this function reaching into global state.
 */
function printComparisonResult(mode: "live" | "cheap", result: RegressionCheckResult): "pass" | "warn" | "fail" {
  if (result.problems.length === 0) {
    console.log("check.ts: PASS — both banded rates are at or above the committed baseline band's floor, manifest and coverage match.");
    return "pass";
  }

  const anyBlocking = hasProblemClass(result, "accuracy-below-band") || hasProblemClass(result, "coverage-mismatch");
  const staleOnly = mode === "cheap" && !anyBlocking;

  if (staleOnly) {
    console.warn(`check.ts: WARNING — ${result.problems.length} stale-baseline problem(s), NOT blocking cheap mode (see this file's module comment):`);
    for (const p of result.problems) console.warn(`  - [${p.problemClass}] ${p.message}`);
    return "warn";
  }

  console.error(`check.ts: FAIL — ${result.problems.length} problem(s) vs the committed baseline band:`);
  for (const p of result.problems) console.error(`  - [${p.problemClass}] ${p.message}`);
  return "fail";
}

async function runLive(args: ReturnType<typeof parseEvalArgs>): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("check.ts: ANTHROPIC_API_KEY is not set. source .factory-env in a factory worktree, or set it in .env.local.");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("check.ts: DATABASE_URL is not set. source .factory-env in a factory worktree, or set it in .env.local.");
  }

  const manifest = loadGoldenSetManifest();
  const allCaseIds = manifest.cases.map((c) => c.caseId);
  const caseIds = resolveCaseIds(args, allCaseIds);
  const casesById = new Map(manifest.cases.map((c) => [c.caseId, c]));

  console.log(`check.ts: running ${caseIds.length} case(s) live against the real API${args.full ? " (--full)" : ""}.`);

  const pool = new Pool({
    connectionString,
    // Same two safeguards as src/lib/db/index.ts's shared pool and
    // scripts/latency/measure.ts's own dedicated pool — see either file's
    // comment for why (standing rule 22: copy both settings when a script
    // needs its own short-lived pool, not just the constructor call).
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => {
    console.error("check.ts: unexpected error on idle Postgres client", err);
  });
  const db = drizzle(pool, { schema });

  const outcomes: CaseRunOutcome[] = [];
  try {
    for (let i = 0; i < caseIds.length; i++) {
      const caseSpec = casesById.get(caseIds[i])!;
      const outcome = await runOneCase(caseSpec, db);
      outcomes.push(outcome);
      printCaseLine(outcome, i + 1, caseIds.length);
    }
  } finally {
    // TRO-518: `runOneCase` writes label images through `db`, not a scratch
    // directory, so there is nothing left for the first cleanup step to
    // remove — kept as a no-op rather than dropping `cleanupScratchDirAndPool`
    // so this still matches every other caller's two-step shape
    // (`scripts/latency/cleanup.ts`).
    const { scratchDirCleanupError, closePoolError } = await cleanupScratchDirAndPool(
      async () => {},
      () => pool.end(),
    );
    if (scratchDirCleanupError) console.warn(`check.ts: unexpected error during cleanup: ${scratchDirCleanupError}`);
    if (closePoolError) console.warn(`check.ts: failed to close the database pool: ${closePoolError}`);
  }

  const failures = outcomes.filter((o): o is CaseRunOutcome & { failure: EvalCaseFailure } => o.failure !== null).map((o) => o.failure);
  const results = outcomes.filter((o): o is CaseRunOutcome & { result: CascadeCaseResult } => o.result !== null).map((o) => o.result);

  if (args.caseId !== null) {
    // Single-case debug run: print and exit, never touch the committed
    // report or baseline (args.ts's own contract for --case).
    console.log(JSON.stringify(results[0] ?? failures[0], null, 2));
    process.exitCode = failures.length > 0 ? 1 : 0;
    return;
  }

  const summary = buildEvalReportSummary(
    results.map((r) => r.extraction),
    results.map((r) => r.routerVerdict),
    results.map((r) => r.cascadeVerdict),
  );
  const totalCostUsd = results.reduce((sum, r) => sum + r.haikuCost.usd + (r.resolverCost?.usd ?? 0), 0);

  const report: EvalReport = {
    ticket: "TRO-470 / LH-030",
    measuredAt: new Date().toISOString(),
    mode: "live",
    haikuModel: HAIKU_EXTRACTOR_MODEL,
    sonnetModel: SONNET_RESOLVER_MODEL,
    manifestVersion: manifest.version,
    manifestContentHash: hashManifestFile(DEFAULT_MANIFEST_PATH),
    caseIds: [...caseIds].sort(),
    requestedFull: args.full,
    summary,
    cases: results,
    totalCostUsd,
    failures,
  };

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  console.log("");
  console.log(`check.ts: ${results.length}/${caseIds.length} case(s) scored, ${failures.length} failed.`);
  console.log(
    `check.ts: extraction accuracy ${(summary.extractionAccuracy.rate * 100).toFixed(1)}% (${summary.extractionAccuracy.correct}/${summary.extractionAccuracy.total})`,
  );
  console.log(
    `check.ts: router-verdict accuracy ${(summary.routerVerdictAccuracy.rate * 100).toFixed(1)}% (${summary.routerVerdictAccuracy.correct}/${summary.routerVerdictAccuracy.total}) — scored BEFORE any resolver call; reported only, not banded (see EvalBaseline's own doc comment, types.ts)`,
  );
  console.log(
    `check.ts: cascade-verdict accuracy ${(summary.cascadeVerdictAccuracy.rate * 100).toFixed(1)}% (${summary.cascadeVerdictAccuracy.correct}/${summary.cascadeVerdictAccuracy.total}) — the cascade's END STATE, resolver merge included`,
  );
  console.log(
    `check.ts: review-reason accuracy ${(summary.reviewReasonAccuracy.rate * 100).toFixed(1)}% (${summary.reviewReasonAccuracy.correct}/${summary.reviewReasonAccuracy.total}) — reported only, not banded (small REVIEW-only sample)`,
  );
  // PRD §3.7 / CP-2 §8.4's warning upgrade-ladder segmentation (TRO-469 /
  // LH-021) — reported, not gated (baseline-compare.ts's own module
  // comment says why). "a number in CI output, not a judgment call
  // mid-week": this line IS that number.
  const seg = summary.warningSegmentation;
  console.log(
    `check.ts: warning-check segmentation (of ${seg.total}) — clean ${(seg.clean.rate * 100).toFixed(1)}% (${seg.clean.count}), ` +
      `true-mismatch ${(seg.trueMismatch.rate * 100).toFixed(1)}% (${seg.trueMismatch.count}), ` +
      `resolution-suspect ${(seg.resolutionSuspect.rate * 100).toFixed(1)}% (${seg.resolutionSuspect.count}) <- drives the ladder, ` +
      `not-found ${(seg.notFound.rate * 100).toFixed(1)}% (${seg.notFound.count})`,
  );
  // CP-1 §4.5 step 2's reliability diagram (TRO-538 / LH-033) — thin
  // deciles are real, not hidden: empty ones are skipped here (the
  // committed JSON keeps all 10), and every printed rate carries its own n.
  console.log("check.ts: extraction reliability by confidence decile (CP-1 §4.5 step 2; some deciles are thin):");
  for (const bucket of summary.extractionReliabilityDiagram) {
    if (bucket.n === 0) continue;
    console.log(`    [${(bucket.decile / 10).toFixed(1)}-${((bucket.decile + 1) / 10).toFixed(1)}) n=${bucket.n} correct=${bucket.correct} rate=${(bucket.rate * 100).toFixed(1)}%`);
  }
  console.log(`check.ts: total measured cost $${totalCostUsd.toFixed(4)}`);
  console.log(`check.ts: wrote ${REPORT_PATH}`);

  if (failures.length > 0) {
    console.error(`check.ts: ${failures.length} case(s) failed to run — see the "failures" array in the report. Refusing to treat this as a clean run.`);
    process.exitCode = 1;
    return;
  }

  // TRO-561: check.ts no longer writes scripts/eval/baseline.json. The
  // baseline is a K-repeat band now (EvalBaseline, types.ts), and a single
  // --live run has no K and no spread to band from — writing one here would
  // reopen exactly the "floor pinned to one draw" defect this ticket fixes,
  // via a second, inconsistent write path (this file's own module comment:
  // "do NOT build a second cascade path"). The re-baseline protocol
  // (variance.ts's --establish-baseline) is the only path that writes
  // baseline.json now.
  if (args.updateBaseline) {
    console.error(
      "check.ts: --update-baseline no longer writes scripts/eval/baseline.json (TRO-561: the baseline is a K-repeat band, not one " +
        "run's point). Use the re-baseline protocol instead: pnpm eval:variance -- --live --full --repeats=3 --establish-baseline.",
    );
    process.exitCode = 1;
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(
      `check.ts: no committed baseline at ${BASELINE_PATH}. Run the re-baseline protocol first: ` +
        "pnpm eval:variance -- --live --full --repeats=3 --establish-baseline.",
    );
    process.exitCode = 1;
    return;
  }
  const baseline = validateEvalBaseline(JSON.parse(readFileSync(BASELINE_PATH, "utf8")), BASELINE_PATH);
  printBandLines(report.summary, baseline);
  const comparison = compareToBaseline(report, baseline);
  const decision = printComparisonResult("live", comparison);
  process.exitCode = decision === "fail" ? 1 : 0;
}

function runCheap(): void {
  const REBASELINE_HINT = "pnpm eval:variance -- --live --full --repeats=3 --establish-baseline";
  if (!existsSync(REPORT_PATH)) {
    console.error(
      `check.ts: no committed eval report at ${REPORT_PATH}. This is expected before the first --live run. Run: ${REBASELINE_HINT}`,
    );
    process.exitCode = 1;
    return;
  }
  if (!existsSync(BASELINE_PATH)) {
    console.error(`check.ts: no committed baseline at ${BASELINE_PATH}. Run: ${REBASELINE_HINT}`);
    process.exitCode = 1;
    return;
  }
  const report = validateEvalReport(JSON.parse(readFileSync(REPORT_PATH, "utf8")), REPORT_PATH);
  const baseline = validateEvalBaseline(JSON.parse(readFileSync(BASELINE_PATH, "utf8")), BASELINE_PATH);
  console.log(
    `check.ts: cheap mode — comparing the committed report (measured ${report.measuredAt}) against the committed baseline band ` +
      `(K=${baseline.k}, established ${baseline.establishedAt}). No live call made.`,
  );

  // TRO-556: the two comparisons above check the committed report against
  // the committed baseline — two frozen files against each other. Neither
  // touches the LIVE golden-set/manifest.json on disk right now, so a
  // corpus rebuild that leaves both frozen files stale together is
  // invisible to them. This one extra read closes that gap: a fast local
  // file hash, not a live API call, so it stays in cheap mode. Warns, never
  // fails (manifest-drift.ts's own module comment says why).
  const liveManifestHash = hashManifestFile(DEFAULT_MANIFEST_PATH);
  const drift = checkManifestDrift(report.manifestContentHash, liveManifestHash);
  if (drift.drifted) {
    console.warn(`check.ts: WARNING — ${drift.message}`);
  } else {
    console.log(`check.ts: ${drift.message}`);
  }

  if (report.failures.length > 0) {
    console.error(`check.ts: FAIL — the committed report itself recorded ${report.failures.length} case failure(s); it does not represent a clean run.`);
    process.exitCode = 1;
    return;
  }
  printBandLines(report.summary, baseline);
  const comparison = compareToBaseline(report, baseline);
  const decision = printComparisonResult("cheap", comparison);
  process.exitCode = decision === "fail" ? 1 : 0;
}

async function main(): Promise<void> {
  const args = parseEvalArgs(process.argv.slice(2));
  validateCheckArgs(args);
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
