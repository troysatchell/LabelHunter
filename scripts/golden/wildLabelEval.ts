/**
 * Real, live scoring for the wild-label candidates (LH-027 / TRO-530).
 *
 * The 5 candidate cases in `golden-set/wild-labels/candidates.json` are
 * NOT in `golden-set/manifest.json` yet -- see this directory's `README.md`
 * for why (the loader's own tested rule: an `ai-generated` case must be
 * `verified: true` to load at all, and only Troy sets that flag). That
 * means `pnpm eval:check -- --case=<id>` cannot reach them (`resolveCaseIds`
 * only recognizes manifest case IDs).
 *
 * This script runs each candidate through the exact same real cascade
 * `scripts/eval/check.ts` uses -- `runOneCase` from `cascade-runner.ts`,
 * unmodified -- so the acceptance evidence ("the eval harness scores every
 * case and the extraction accuracy is reported per case") is real, not
 * simulated. It never writes to `scripts/eval/results/eval-report.json` or
 * `scripts/eval/baseline.json`: this is a standalone, informational run
 * over cases the committed baseline does not (yet) include, exactly the
 * same posture `check.ts`'s own `--case=<id>` mode already documents for a
 * single debug case.
 *
 * Network, costs real money (real Haiku extraction, and a real Sonnet
 * resolver call for any case that escalates to REVIEW) -- run manually:
 * `pnpm golden:wild-eval`. Never wired into CI or gate.sh.
 */
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/lib/db/schema";
import { GoldenSetValidationError, validateManifest } from "../../src/lib/golden-set/loader";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import { cleanupScratchDirAndPool } from "../latency/cleanup";
import { REPO_ROOT, runOneCase, type CaseRunOutcome } from "../eval/cascade-runner";

const CANDIDATES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../golden-set/wild-labels/candidates.json",
);
const RESULTS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../golden-set/wild-labels/results/wild-eval-report.json",
);
/** Every candidate's `imagePath` must resolve inside this directory — the
 * same containment discipline `scripts/golden/imagen.ts`'s `resolveWithinDir`
 * and `scripts/golden/build.ts`'s `resolveImagePath` already apply to every
 * other golden-set image path, even though `candidates.json` is a
 * committed, reviewed file, not runtime input (CodeRabbit finding, round
 * 1 — "cheap enough to add anyway" is `build.ts`'s own reasoning for the
 * identical check). Resolved through `realpathSync` — not just
 * `path.resolve` — so both sides of the `path.relative` comparison below
 * share the same physical-path basis as `resolvedImagePath` (also
 * `realpathSync`-resolved). Comparing a symlink-resolved candidate path
 * against an un-resolved boundary would be comparing two different
 * coordinate systems: if any component of this repo's checkout path is
 * itself a symlink, the two could disagree about what "inside" means
 * (CodeRabbit finding, round 4). The directory is committed and always
 * exists, so resolving it eagerly at module load is safe. */
const WILD_LABELS_DIRECTORY = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../golden-set/wild-labels"),
);

interface CandidatesFile {
  readonly note: string;
  readonly cases: readonly GoldenSetCase[];
}

/**
 * Reads and lightly validates `candidates.json` -- lightly, because full
 * schema validation (`src/lib/golden-set/loader.ts`'s `validateManifest`)
 * cannot run on an unverified `ai-generated` case by design (the same rule
 * this whole file's module comment explains). This checks the handful of
 * invariants THIS script actually depends on: `cases` is a non-empty
 * array, every case is `provenance: "ai-generated"` and `verified: false`
 * (so a future accidental `verified: true` entry here — which would mean
 * it belongs in the real manifest, not this staging file — is caught
 * loudly), and every case's `imagePath` resolves (after symlinks, via
 * `realpathSync`) to a real, non-empty, regular file INSIDE
 * `golden-set/wild-labels/` — never an absolute path, a `../` escape, or a
 * symlink pointing outside it. It then runs the FULL case set through the
 * real, shared `validateManifest` (`src/lib/golden-set/loader.ts`) — the
 * same schema every manifest case is held to — with `verified` and
 * `imagePath` patched to their post-fold-in values for that one check
 * only (never written back to `cases`); see this repo's own
 * `wildLabelCandidates.test.ts` for the identical technique. Without this,
 * a candidate missing `application`/`label`/`expected` (or any other
 * required field) would silently reach `runOneCase` and waste a real, paid
 * API call on a malformed case instead of failing before any money is
 * spent (CodeRabbit finding, round 2). Pure and synchronous: no network,
 * so it's unit-testable directly.
 */
export function loadWildLabelCandidates(candidatesPath: string = CANDIDATES_PATH): GoldenSetCase[] {
  const raw: unknown = JSON.parse(readFileSync(candidatesPath, "utf8"));
  if (typeof raw !== "object" || raw === null || !("cases" in raw) || !Array.isArray((raw as CandidatesFile).cases)) {
    throw new Error(`wildLabelEval: ${candidatesPath} does not have a "cases" array`);
  }
  const cases = (raw as CandidatesFile).cases;
  if (cases.length === 0) {
    throw new Error(`wildLabelEval: ${candidatesPath} has zero cases`);
  }
  const seenIds = new Set<string>();
  for (const rawCase of cases) {
    // A cases[] entry's shape is only ASSUMED (the `GoldenSetCase[]` cast
    // above), never guaranteed -- candidates.json is a committed, reviewed
    // file, but not a runtime-validated one at the point this loop reads
    // it. Check the two fields this loop's own error messages read
    // (`caseId`, `imagePath`) before reading either, so a malformed entry
    // produces this file's own clear, wildLabelEval-prefixed error instead
    // of a raw TypeError or a confusing "provenance undefined" message
    // (CodeRabbit finding, round 3; lessons.md rule 13).
    if (typeof rawCase !== "object" || rawCase === null) {
      throw new Error(`wildLabelEval: a cases[] entry in ${candidatesPath} must be an object, got ${JSON.stringify(rawCase)}`);
    }
    const c = rawCase as GoldenSetCase;
    if (typeof c.caseId !== "string" || c.caseId.length === 0) {
      throw new Error(`wildLabelEval: a cases[] entry in ${candidatesPath} must have a string caseId`);
    }
    if (typeof c.imagePath !== "string" || c.imagePath.length === 0) {
      throw new Error(`wildLabelEval: ${c.caseId}: must have a string imagePath`);
    }
    if (seenIds.has(c.caseId)) {
      throw new Error(`wildLabelEval: duplicate caseId "${c.caseId}" in ${candidatesPath}`);
    }
    seenIds.add(c.caseId);
    if (c.provenance !== "ai-generated") {
      throw new Error(`wildLabelEval: ${c.caseId} has provenance "${c.provenance}", expected "ai-generated"`);
    }
    if (c.verified !== false) {
      throw new Error(
        `wildLabelEval: ${c.caseId} has verified: ${JSON.stringify(c.verified)} -- a verified candidate belongs ` +
          "in golden-set/manifest.json, not this staging file (see README.md's fold-in steps).",
      );
    }
    if (path.isAbsolute(c.imagePath)) {
      throw new Error(`wildLabelEval: ${c.caseId}: imagePath must be a relative path, got "${c.imagePath}"`);
    }
    let resolvedImagePath: string;
    let imageStat: ReturnType<typeof statSync>;
    try {
      // realpathSync resolves symlinks to their real target before the
      // containment check below runs — a symlink staged inside
      // golden-set/wild-labels/ that points outside it must not pass this
      // check just because the symlink's own (unresolved) path looks fine.
      resolvedImagePath = realpathSync(path.resolve(REPO_ROOT, c.imagePath));
      imageStat = statSync(resolvedImagePath);
    } catch {
      throw new Error(`wildLabelEval: ${c.caseId}: no file at ${c.imagePath}`);
    }
    const relativeToStaging = path.relative(WILD_LABELS_DIRECTORY, resolvedImagePath);
    if (relativeToStaging === "" || relativeToStaging.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToStaging)) {
      throw new Error(
        `wildLabelEval: ${c.caseId}: imagePath "${c.imagePath}" resolves outside golden-set/wild-labels/ -- refusing to read`,
      );
    }
    if (!imageStat.isFile() || imageStat.size === 0) {
      throw new Error(`wildLabelEval: ${c.caseId}: imagePath "${c.imagePath}" must name a non-empty regular file`);
    }
  }

  // Full schema validation, patched only for the two fields this staging
  // file is deliberately allowed to differ on (see this function's own
  // doc comment). Every other field — application, label, expected,
  // category, vectors, and so on — must be genuinely well-formed before
  // this script hands a case to a real, paid runOneCase call.
  const patchedForValidation = cases.map((c) => ({
    ...c,
    verified: true,
    imagePath: c.imagePath.replace("golden-set/wild-labels/", "golden-set/images/"),
  }));
  try {
    validateManifest({ version: "1.0.0", cases: patchedForValidation });
  } catch (err) {
    if (err instanceof GoldenSetValidationError) {
      throw new Error(
        `wildLabelEval: ${candidatesPath} failed schema validation (${err.problems.length} problem(s), verified/imagePath ` +
          `patched to their post-fold-in values for this check):\n` +
          err.problems.map((p) => `  - ${p}`).join("\n"),
      );
    }
    throw err;
  }

  return [...cases];
}

function printCaseLine(outcome: CaseRunOutcome, index: number, total: number): void {
  if (outcome.failure) {
    console.log(`  [${index}/${total}] ${outcome.failure.caseId}: FAILED — ${outcome.failure.error}`);
    return;
  }
  const r = outcome.result!;
  const extractionCorrect = r.extraction.fields.filter((f) => f.correct).length;
  const routerNote = r.routerVerdict.labelVerdictCorrect
    ? "router matches expected"
    : `router differs from expected (expected ${r.routerVerdict.expectedLabelVerdict}, got ${r.routerVerdict.actualLabelVerdict})`;
  const resolverNote = r.resolverOutcome
    ? `, resolver: ${r.resolverOutcome} ($${r.resolverCost!.usd.toFixed(4)})`
    : r.resolverError
      ? `, resolver: FAILED (${r.resolverError})`
      : "";
  console.log(
    `  [${index}/${total}] ${r.caseId}: extraction ${extractionCorrect}/${r.extraction.fields.length} fields correct, ${routerNote}, haiku $${r.haikuCost.usd.toFixed(4)}${resolverNote}`,
  );
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("wildLabelEval: ANTHROPIC_API_KEY is not set. source .factory-env in a factory worktree, or set it in .env.local.");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("wildLabelEval: DATABASE_URL is not set. source .factory-env in a factory worktree, or set it in .env.local.");
  }

  const candidates = loadWildLabelCandidates();
  console.log(`wildLabelEval: scoring ${candidates.length} wild-label candidate(s) against the real cascade.\n`);

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  pool.on("error", (err) => {
    console.error("wildLabelEval: unexpected error on idle Postgres client", err);
  });
  const db = drizzle(pool, { schema });

  const outcomes: CaseRunOutcome[] = [];
  try {
    for (let i = 0; i < candidates.length; i++) {
      // runOneCase normally reports a real API/HTTP failure as
      // outcome.failure, never a throw (cascade-runner.ts's own design) --
      // but it DOES throw for what its own comments call "a harness bug,
      // not a case result" (e.g. a captured-state invariant violated).
      // Catching that here, instead of letting it propagate past this
      // whole loop, means an unexpected failure on case 3 of 5 does not
      // discard the already-collected, already-paid-for outcomes for
      // cases 1-2, and the report below still gets written with whatever
      // real evidence this run actually produced (CodeRabbit finding,
      // round 4 -- CLAUDE.md "never fabricate a number" cuts both ways: an
      // unreported real cost is exactly as dishonest as a fabricated one).
      try {
        const outcome = await runOneCase(candidates[i], db);
        outcomes.push(outcome);
        printCaseLine(outcome, i + 1, candidates.length);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        outcomes.push({ result: null, failure: { caseId: candidates[i].caseId, error: message }, rawExtraction: null, rawPreprocessed: null });
        console.log(`  [${i + 1}/${candidates.length}] ${candidates[i].caseId}: FAILED (harness error) — ${message}`);
      }
    }
  } finally {
    const { scratchDirCleanupError, closePoolError } = await cleanupScratchDirAndPool(
      async () => {},
      () => pool.end(),
    );
    if (scratchDirCleanupError) console.warn(`wildLabelEval: unexpected error during cleanup: ${scratchDirCleanupError}`);
    if (closePoolError) console.warn(`wildLabelEval: failed to close the database pool: ${closePoolError}`);
  }

  const failures = outcomes.filter((o) => o.failure !== null).map((o) => o.failure!);
  const results = outcomes.filter((o) => o.result !== null).map((o) => o.result!);
  const totalCostUsd = results.reduce((sum, r) => sum + r.haikuCost.usd + (r.resolverCost?.usd ?? 0), 0);

  mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(
    RESULTS_PATH,
    JSON.stringify(
      {
        ticket: "TRO-530 / LH-027",
        measuredAt: new Date().toISOString(),
        note:
          "Standalone real scoring of the wild-label candidates in candidates.json -- these cases are NOT part of " +
          "the committed eval baseline (scripts/eval/baseline.json) and this report never feeds it.",
        cases: results,
        failures,
        totalCostUsd,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`\nwildLabelEval: ${results.length}/${candidates.length} case(s) scored, ${failures.length} failed.`);
  console.log(`wildLabelEval: real spend this run: $${totalCostUsd.toFixed(4)} (Haiku extraction + any Sonnet resolver calls).`);
  console.log(`wildLabelEval: full report written to ${RESULTS_PATH}`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
