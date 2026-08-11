/**
 * Scratch-directory and connection-pool cleanup for the latency harness
 * (TRO-471 / LH-031). Split out from `measure.ts` for the same reason
 * `args.ts` is: `measure.ts` calls `main()` unconditionally at module
 * scope (a real, live, paid API call per run), so a test importing it
 * would spend real money just to load the module.
 *
 * This module fixes a real gap a PR review found: the original
 * `measure.ts` ran `await rm(scratchDir, ...)` then `await pool.end()`
 * inside one `finally` block. If `rm` itself threw (rare — `force: true`
 * already suppresses a missing-path error, but not e.g. a permissions
 * error), that throw propagated out of `main()` entirely — skipping the
 * report-writing code and losing every already-completed, already-paid-for
 * run's results. `pool.end()` did still run in that case (a prior fix
 * nested it in its own `finally`), but the report never got written.
 *
 * `cleanupScratchDirAndPool` never throws — from either step. A
 * `removeScratchDir` failure is caught and returned as
 * `scratchDirCleanupError`, not re-thrown — the caller (`main`) is
 * guaranteed to reach its own report-writing code afterward, every time.
 * `closePool` always runs, whether or not `removeScratchDir` succeeded — an
 * open pool keeps the Node event loop alive, which would hang the script
 * instead of exiting. A `closePool` failure is caught the same way, into
 * `closePoolError` — an earlier version of this function left that one
 * step unguarded (a PR review finding: the "never throws" claim above was
 * true for `removeScratchDir` but not yet for `closePool`).
 */

export interface CleanupOutcome {
  /** `null` on a clean removal. The error message on a failure — never
   * thrown, so a caller can always continue to write its report. */
  scratchDirCleanupError: string | null;
  /** `null` on a clean pool close. The error message on a failure — same
   * "never thrown" guarantee as `scratchDirCleanupError`. */
  closePoolError: string | null;
}

/**
 * Runs both cleanup steps unconditionally, in order: remove the scratch
 * directory, then close the pool. Callers inject both as closures —
 * production wires the real `rm(...)`/`pool.end()`; tests inject fakes,
 * including ones that reject, with no real filesystem or database
 * involved.
 */
export async function cleanupScratchDirAndPool(
  removeScratchDir: () => Promise<void>,
  closePool: () => Promise<void>,
): Promise<CleanupOutcome> {
  let scratchDirCleanupError: string | null = null;
  let closePoolError: string | null = null;
  try {
    await removeScratchDir();
  } catch (rmError) {
    scratchDirCleanupError = rmError instanceof Error ? rmError.message : String(rmError);
  } finally {
    try {
      await closePool();
    } catch (closeError) {
      closePoolError = closeError instanceof Error ? closeError.message : String(closeError);
    }
  }
  return { scratchDirCleanupError, closePoolError };
}
