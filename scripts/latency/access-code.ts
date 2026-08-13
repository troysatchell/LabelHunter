/**
 * The access credential `--url` mode has to present (TRO-568, TH-R2, TH-R6).
 *
 * TRO-482 put a shared access-code gate in front of every route except an
 * explicit exemption list (`src/proxy.ts`). `/api/verify` is not exempt, so
 * a `--url` run that sends no credential gets a 401 before any pipeline
 * stage executes. The harness would then report timings for the guard
 * rejecting it, not for the cascade — a measurement that looks like a
 * latency figure and is not one.
 *
 * The header, not the cookie: PRD §8 provides `x-access-code` precisely so
 * non-browser callers do not have to run the browser sign-in flow first
 * ("do not force everything through a browser flow"). This harness is that
 * caller.
 *
 * **Read from the environment, never from a file.** The deployed instance
 * reads `ACCESS_CODE` from its platform environment (`render.yaml` declares
 * it `sync: false`, so the value never travels in the repo). A local `.env`
 * does not configure the deployed target, and an hour was lost to exactly
 * that confusion on 2026-08-13.
 */

/** PRD §8's non-browser credential header. Must match
 * `src/server/auth/access-code.ts`'s `ACCESS_CODE_HEADER_NAME` — the
 * server reads this exact name. */
export const ACCESS_CODE_HEADER_NAME = "x-access-code";

/**
 * Thrown before the first request when `--url` mode has no credential to
 * present.
 *
 * Failing here rather than letting the run proceed is the whole point. A
 * harness that sends 50 unauthenticated requests reports 50 identical 401s,
 * which reads as "the deployed app is broken" rather than "you did not
 * supply a credential" — and it spends the target's per-IP rate-limit
 * budget on the way, which can lock out the next honest attempt.
 */
export class MissingAccessCodeError extends Error {
  constructor() {
    super(
      "measure.ts: --url mode needs an access code, and ACCESS_CODE is not set.\n" +
        "The deployed instance is gated (TRO-482). Every request without a credential returns 401 " +
        "before any stage runs, so the run would measure the gate, not the cascade.\n" +
        "Set ACCESS_CODE to the value configured on the deployed target, then re-run. " +
        "That value lives in the platform's own environment settings, not in any file in this repo.",
    );
    this.name = "MissingAccessCodeError";
  }
}

/** The one variable this module reads. Narrower than `NodeJS.ProcessEnv` on
 * purpose: it names exactly what the function depends on, and lets a test
 * pass `{}` without asserting a whole environment into existence. */
export interface AccessCodeEnv {
  ACCESS_CODE?: string;
  /** Present so the real `process.env` is assignable. Without it TypeScript's
   * weak-type check rejects a type whose only members are optional. */
  [key: string]: string | undefined;
}

/**
 * The headers a `--url` request must carry.
 *
 * `env` is a parameter so tests can supply their own; production passes
 * nothing and reads the real environment. Whitespace-only is treated as
 * absent — a variable set to `"   "` is a configuration mistake, not a
 * credential, and letting it through would produce the 401 storm this
 * function exists to prevent (standing rule 13: name the invariant and
 * check it).
 */
export function buildAccessCodeHeaders(env: AccessCodeEnv = process.env): Record<string, string> {
  const code = env.ACCESS_CODE?.trim();
  if (!code) {
    throw new MissingAccessCodeError();
  }
  return { [ACCESS_CODE_HEADER_NAME]: code };
}
