/**
 * CLI argument parsing for the latency harness (TRO-471 / LH-031).
 *
 * Split out from `measure.ts` so it has no side effects at import time.
 * `measure.ts` calls `main()` unconditionally at module scope (it is a
 * script, not a library), which makes one real, live, paid API call per
 * run — importing it from a test file would spend real money just to load
 * the module. This file imports nothing from `measure.ts` and calls
 * nothing on its own, so `args.test.ts` can test `parseArgs` for free.
 */

/** The golden-set case this harness measures by default — the TH-R11
 * reference example (`golden-set/manifest.json`'s own note): a clean
 * spirits label with every field matching, no glare/rotation/degradation.
 * The realistic "fast path" image PRD §3.8 budgets against, not a
 * deliberately hard judgment case. */
export const DEFAULT_CASE_ID = "case-01-clean-match-spirits";
export const DEFAULT_RUNS = 20;

/**
 * Hard ceiling on `--runs`. Every run spends real money on one live Haiku
 * call (`measure.ts`'s own module comment). The ticket brief itself says
 * 15-20 samples is plenty for a meaningful p50/p95 — this cap is not that
 * recommendation, it is a much looser backstop against a typo
 * (`--runs=2000`) silently burning real API spend. No override flag on
 * purpose: a genuine need for more than this many samples should be a
 * deliberate code change (edit this constant), not a CLI flag easy to pass
 * by accident.
 */
export const MAX_RUNS = 50;

export interface CliArgs {
  runs: number;
  caseId: string;
}

/**
 * Parses `process.argv.slice(2)`-shaped CLI args into `{ runs, caseId }`.
 * Throws `Error` on an unrecognized argument, a non-positive-integer
 * `--runs`, or a `--runs` above `MAX_RUNS`.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
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
  if (runs > MAX_RUNS) {
    throw new Error(
      `measure.ts: --runs=${runs} exceeds the ${MAX_RUNS}-run safety cap (each run spends real ` +
        `API money — see this file's MAX_RUNS comment). Edit MAX_RUNS if you genuinely need more.`,
    );
  }
  return { runs, caseId };
}
