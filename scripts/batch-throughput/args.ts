/**
 * CLI argument parsing for the batch-throughput harness (TRO-544 / LH-039).
 *
 * Split out from `measure.ts` so it has no side effects at import time —
 * same reasoning as `scripts/latency/args.ts`'s own header comment:
 * `measure.ts` submits a real batch and spends real API money the moment
 * it runs, so `args.test.ts` must be able to import this file for free.
 */

/** `BatchProgressBrowser.tsx`'s own default poll cadence — reusing it here
 * means this script observes the batch at the same granularity the UI
 * does, not an arbitrary different one. */
export const DEFAULT_POLL_INTERVAL_MS = 3000;

/** Generous upper bound on how long this script waits for a batch to
 * reach a terminal state before giving up. Proposed, not measured against
 * a real multi-hundred-item batch — sized for the 32-case golden-set
 * fixture (this ticket's own real run) plus real headroom for Sonnet
 * escalations and retry backoff, not tuned to it exactly. */
export const DEFAULT_MAX_WAIT_MS = 30 * 60_000;

export const DEFAULT_FIXTURE_DIR = "var/batch-fixture";

/** Node (and every browser) silently clamps a `setTimeout`/`AbortSignal.timeout`
 * delay above the 32-bit signed integer range to a near-immediate fire —
 * the HTML timer spec's own documented behavior, not a Node bug. A
 * `--max-wait-ms` above this would silently mean "almost no wait," the
 * opposite of what a caller typing a huge number intends (review finding,
 * local review round 2). Rejected explicitly instead. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

function defaultBaseUrl(): string {
  // APP_PORT is the factory-assigned port for this worktree (.factory-env);
  // PORT is the equivalent for a plain local checkout — same fallback order
  // playwright.config.ts already established for the same two variables.
  const port = process.env.APP_PORT ?? process.env.PORT ?? "3000";
  return `http://localhost:${port}`;
}

export interface CliArgs {
  baseUrl: string;
  fixtureDir: string;
  pollIntervalMs: number;
  maxWaitMs: number;
}

/**
 * Parses `process.argv.slice(2))`-shaped CLI args. Recognizes
 * `--base-url=`, `--fixture-dir=`, `--poll-interval-ms=`, `--max-wait-ms=`.
 * Throws `Error` on an unrecognized argument or an out-of-range number.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  let baseUrl = defaultBaseUrl();
  let fixtureDir = DEFAULT_FIXTURE_DIR;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let maxWaitMs = DEFAULT_MAX_WAIT_MS;

  for (const arg of argv) {
    // `pnpm run batch:throughput -- --base-url=...` forwards the literal
    // `--` token into argv (pnpm quirk — same as scripts/latency/args.ts).
    if (arg === "--") continue;
    const baseUrlMatch = /^--base-url=(.+)$/.exec(arg);
    if (baseUrlMatch) {
      baseUrl = baseUrlMatch[1];
      continue;
    }
    const fixtureDirMatch = /^--fixture-dir=(.+)$/.exec(arg);
    if (fixtureDirMatch) {
      fixtureDir = fixtureDirMatch[1];
      continue;
    }
    const pollMatch = /^--poll-interval-ms=(\d+)$/.exec(arg);
    if (pollMatch) {
      pollIntervalMs = Number(pollMatch[1]);
      continue;
    }
    const maxWaitMatch = /^--max-wait-ms=(\d+)$/.exec(arg);
    if (maxWaitMatch) {
      maxWaitMs = Number(maxWaitMatch[1]);
      continue;
    }
    throw new Error(
      `measure.ts: unrecognized argument "${arg}" (expected --base-url=, --fixture-dir=, --poll-interval-ms=, or --max-wait-ms=)`,
    );
  }

  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`measure.ts: --poll-interval-ms must be an integer between 250 and ${MAX_TIMER_DELAY_MS}, got ${pollIntervalMs}`);
  }
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < pollIntervalMs || maxWaitMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`measure.ts: --max-wait-ms must be an integer between --poll-interval-ms and ${MAX_TIMER_DELAY_MS}, got ${maxWaitMs}`);
  }

  return { baseUrl, fixtureDir, pollIntervalMs, maxWaitMs };
}
