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
  /** Set only by `--url=<origin>` (TRO-539). When present, the harness
   * sends a real multipart POST to `${url}/api/verify` instead of calling
   * `handleVerifyRequest` in-process — see `measure.ts`'s own module
   * comment and `target-info.ts`. `undefined`, not `null`, when the flag
   * is absent — an omitted CLI flag, not an explicit "no target". */
  url?: string;
  /** Set only by `--out=<path>`, resolved relative to the repo root by
   * `measure.ts` (this module does no filesystem work). Lets a `--url`
   * run write to a path OTHER than the default
   * `scripts/latency/results/single-label-verify.json` — the committed
   * evidence file for the real, in-process, billed measurement — so a
   * fake-model or deployed `--url` run can never silently overwrite it.
   * `undefined` when the flag is absent, same reasoning as `url` above. */
  outPath?: string;
  /** Set only by `--note=<text>`, written verbatim into the committed
   * report's own `validationNote` field. Exists so a run whose numbers
   * are NOT a real TH-R2 measurement — a fake-model or otherwise
   * non-representative run — can say so loudly INSIDE the artifact
   * itself, not only in its filename or in CHANGES.md (a reader who opens
   * the JSON directly, with neither in view, must still see it). `undefined`
   * when the flag is absent, same reasoning as `url` above. */
  note?: string;
}

/**
 * Parses `process.argv.slice(2)`-shaped CLI args into a `CliArgs`. Throws
 * `Error` on an unrecognized argument, a non-positive-integer `--runs`, a
 * `--runs` above `MAX_RUNS`, or a `--url` that is not a valid absolute
 * URL. `--note` text with spaces needs shell quoting (one argv token),
 * e.g. `--note="fake-model validation, not a TH-R2 number"`.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  let runs = DEFAULT_RUNS;
  let caseId = DEFAULT_CASE_ID;
  let url: string | undefined;
  let outPath: string | undefined;
  let note: string | undefined;
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
    const urlMatch = /^--url=(.+)$/.exec(arg);
    if (urlMatch) {
      url = urlMatch[1];
      continue;
    }
    const outMatch = /^--out=(.+)$/.exec(arg);
    if (outMatch) {
      outPath = outMatch[1];
      continue;
    }
    const noteMatch = /^--note=(.+)$/.exec(arg);
    if (noteMatch) {
      note = noteMatch[1];
      continue;
    }
    throw new Error(
      `measure.ts: unrecognized argument "${arg}" (expected --runs=<n>, --case=<caseId>, ` +
        `--url=<origin>, --out=<path>, or --note=<text>)`,
    );
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
  if (url !== undefined) {
    // `fetch` only ever sends this over http(s) anyway (measure.ts's
    // runOnceHttp) — rejecting any other scheme HERE, at parse time, turns
    // a typo like `--url=htp://...` or a copy-paste of a non-http URL into
    // an immediate, specific CLI error instead of a much less clear
    // TypeError out of `fetch` several seconds into a run (CodeRabbit local
    // review round 1, minor).
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(
        `measure.ts: --url=${JSON.stringify(url)} is not a valid absolute URL ` +
          `(expected e.g. --url=http://localhost:3874 — the harness appends /api/verify itself)`,
      );
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(
        `measure.ts: --url=${JSON.stringify(url)} must be http: or https: (got "${parsedUrl.protocol}") ` +
          `— this harness sends a real HTTP request, it cannot target any other scheme`,
      );
    }
  }
  return { runs, caseId, url, outPath, note };
}
