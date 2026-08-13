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
  /** `--cleanup-db` (TRO-539, CodeRabbit local review round 2, major): the
   * operator's own EXPLICIT claim that `DATABASE_URL`, if set, is the SAME
   * database the `--url` target itself uses — never inferred automatically.
   * A `--url` target's hostname resolving to loopback is NOT sufficient
   * proof of that on its own: this repo's own factory workflow routinely
   * runs several worktree-scoped Postgres databases on the SAME localhost
   * Postgres server (`CLAUDE.md`'s "DATABASE_URL discipline"), so a
   * loopback target and a stale, differently-scoped `DATABASE_URL` can
   * coexist on one machine. `measure.ts` still ALSO requires the target
   * to be loopback before attempting a delete (`isLoopbackHostname`,
   * `target-info.ts`) — this flag narrows an automatic decision down to an
   * explicit one, it does not replace that check. Meaningless (ignored,
   * not an error) in the default in-process mode, which always has its own
   * definitely-correct `db`. `undefined` (not `false`) when the flag is
   * absent, same reasoning as `url` above — treat both as "not passed". */
  cleanupDb?: boolean;
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
  let cleanupDb: boolean | undefined;
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
    if (arg === "--cleanup-db") {
      cleanupDb = true;
      continue;
    }
    throw new Error(
      `measure.ts: unrecognized argument "${arg}" (expected --runs=<n>, --case=<caseId>, ` +
        `--url=<origin>, --out=<path>, --note=<text>, or --cleanup-db)`,
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
    // An origin only — no path, query, or fragment (CodeRabbit local review
    // round 2, minor). measure.ts builds the real request URL with
    // `new URL("/api/verify", url)`, and a LEADING SLASH there replaces the
    // whole path component of `url`: a `--url` with its own path (e.g. a
    // reverse-proxy prefix) would have that path silently dropped, hitting
    // the wrong endpoint with no error. Rejecting it here, at parse time,
    // turns a confusing silent wrong-endpoint request into an immediate,
    // specific CLI error instead.
    if ((parsedUrl.pathname !== "" && parsedUrl.pathname !== "/") || parsedUrl.search !== "" || parsedUrl.hash !== "") {
      throw new Error(
        `measure.ts: --url=${JSON.stringify(url)} must be a bare origin, with no path, query, or ` +
          `fragment — this harness appends /api/verify itself, and a path on --url would be ` +
          `silently dropped, not combined (expected e.g. --url=http://localhost:3874)`,
      );
    }
    // No embedded credentials (CodeRabbit local review round 2, major).
    // `fetch` already rejects a request URL carrying a non-empty username or
    // password, so this is unreachable via a successful run either way —
    // rejecting it HERE gives a clear, specific CLI error naming --url,
    // instead of a generic TypeError several seconds into a run.
    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
      throw new Error(
        `measure.ts: --url must not include a username or password — pass a bare origin ` +
          `(expected e.g. --url=http://localhost:3874, never --url=http://user:pass@host)`,
      );
    }
  }
  return { runs, caseId, url, outPath, note, cleanupDb };
}
