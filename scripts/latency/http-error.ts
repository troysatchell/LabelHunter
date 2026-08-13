/**
 * Renders a caught `fetch`/`response.json()` error into a human-readable
 * message for `--url` mode's `RunResult.error` (TRO-539). Pure — split
 * out from `measure.ts` so it is unit-testable without a real socket, the
 * same reason `args.ts`/`cleanup.ts`/`exit-status.ts`/`response.ts` are.
 *
 * **Why this exists.** `runOnceHttp` (`measure.ts`) bounds its whole
 * request — the `fetch` call AND the subsequent `response.json()` body
 * read — behind one shared `AbortSignal.timeout(...)`, the same "one timer
 * across every await" pattern `src/server/warning/ocr.ts`'s
 * `OCR_TIMEOUT_MS` already established for the identical class of bug
 * (lessons.md rule 23; CodeRabbit local review round 1, major: `--url`
 * mode must not reintroduce the exact "no deadline, can hang forever"
 * defect TRO-519 just fixed server-side, this time on the CLIENT side of
 * the same request). `describeHttpError` distinguishes that timeout from
 * every other network failure so a caller sees "the target may be hung or
 * unreachable" instead of a generic, easy-to-miss `AbortError` stack
 * trace.
 */

/**
 * `wasAborted` should be the SAME `AbortSignal`'s own `.aborted` flag,
 * read by the caller at the moment its `catch` block runs — this function
 * does no signal inspection of its own so it stays a plain, synchronous,
 * fully unit-testable function.
 */
export function describeHttpError(cause: unknown, wasAborted: boolean, timeoutMs: number): string {
  if (wasAborted) {
    return `measure.ts: request timed out after ${timeoutMs}ms — the target may be hung or unreachable`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
