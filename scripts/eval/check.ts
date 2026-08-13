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
 * `pnpm eval:check -- --live` runs the real cascade — real Haiku
 * extraction plus, only for cases the router actually escalates, one real
 * Sonnet resolver call (never forced onto a case the cascade would not
 * route to it) — over a case sample, scores it, writes a fresh
 * `eval-report.json`, and THEN runs the same baseline comparison against
 * the fresh numbers. This is the expensive, deliberate, human-or-agent-
 * invoked mode — never automatic, matching `scripts/latency/measure.ts`'s
 * own real-money discipline. `--full` runs the whole 31-case golden set
 * instead of the default 8-case sample (`args.ts`); `--update-baseline`
 * promotes a clean `--live` run's numbers into the committed baseline (see
 * `args.ts` for why this is always a separate, explicit flag, never a
 * `--live` side effect); `--case=<id>` runs one named case for debugging
 * and never touches the committed report or baseline.
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
import { compareToBaseline } from "./baseline-compare";
import { REPO_ROOT, runOneCase, type CaseRunOutcome } from "./cascade-runner";
import { hashManifestFile } from "./manifest-hash";
import { validateEvalBaseline, validateEvalReport } from "./report-validation";
import { buildEvalReportSummary } from "./summary";
import type { CascadeCaseResult, EvalBaseline, EvalCaseFailure, EvalReport } from "./types";

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

function printRegressionResult(result: { regressed: boolean; reasons: string[] }): void {
  if (!result.regressed) {
    console.log("check.ts: PASS — accuracy at or above the committed baseline.");
    return;
  }
  console.error(`check.ts: FAIL — ${result.reasons.length} problem(s) vs the committed baseline:`);
  for (const reason of result.reasons) {
    console.error(`  - ${reason}`);
  }
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
    `check.ts: router-verdict accuracy ${(summary.routerVerdictAccuracy.rate * 100).toFixed(1)}% (${summary.routerVerdictAccuracy.correct}/${summary.routerVerdictAccuracy.total}) — scored BEFORE any resolver call`,
  );
  console.log(
    `check.ts: cascade-verdict accuracy ${(summary.cascadeVerdictAccuracy.rate * 100).toFixed(1)}% (${summary.cascadeVerdictAccuracy.correct}/${summary.cascadeVerdictAccuracy.total}) — the cascade's END STATE, resolver merge included`,
  );
  console.log(
    `check.ts: review-reason accuracy ${(summary.reviewReasonAccuracy.rate * 100).toFixed(1)}% (${summary.reviewReasonAccuracy.correct}/${summary.reviewReasonAccuracy.total})`,
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

  if (args.updateBaseline) {
    const baseline: EvalBaseline = {
      ticket: report.ticket,
      establishedAt: report.measuredAt,
      manifestVersion: report.manifestVersion,
      manifestContentHash: report.manifestContentHash,
      caseIds: report.caseIds,
      summary: report.summary,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`check.ts: wrote ${BASELINE_PATH} (baseline updated from this run — no regression check against the old baseline).`);
    process.exitCode = 0;
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`check.ts: no committed baseline at ${BASELINE_PATH}. Run --live --update-baseline first to establish one.`);
    process.exitCode = 1;
    return;
  }
  const baseline = validateEvalBaseline(JSON.parse(readFileSync(BASELINE_PATH, "utf8")), BASELINE_PATH);
  const regressionResult = compareToBaseline(report, baseline);
  printRegressionResult(regressionResult);
  process.exitCode = regressionResult.regressed ? 1 : 0;
}

function runCheap(): void {
  if (!existsSync(REPORT_PATH)) {
    console.error(
      `check.ts: no committed eval report at ${REPORT_PATH}. This is expected before the first --live run. ` +
        "Run: pnpm eval:check -- --live --update-baseline",
    );
    process.exitCode = 1;
    return;
  }
  if (!existsSync(BASELINE_PATH)) {
    console.error(`check.ts: no committed baseline at ${BASELINE_PATH}. Run: pnpm eval:check -- --live --update-baseline`);
    process.exitCode = 1;
    return;
  }
  const report = validateEvalReport(JSON.parse(readFileSync(REPORT_PATH, "utf8")), REPORT_PATH);
  const baseline = validateEvalBaseline(JSON.parse(readFileSync(BASELINE_PATH, "utf8")), BASELINE_PATH);
  console.log(
    `check.ts: cheap mode — comparing the committed report (measured ${report.measuredAt}) against the committed baseline (established ${baseline.establishedAt}). No live call made.`,
  );
  if (report.failures.length > 0) {
    console.error(`check.ts: FAIL — the committed report itself recorded ${report.failures.length} case failure(s); it does not represent a clean run.`);
    process.exitCode = 1;
    return;
  }
  const regressionResult = compareToBaseline(report, baseline);
  printRegressionResult(regressionResult);
  process.exitCode = regressionResult.regressed ? 1 : 0;
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
