/**
 * Decides `measure.ts`'s process exit code (TRO-471 / LH-031). Pure
 * function — no I/O, no live call — split out so the decision itself is
 * unit-testable without mocking a real measurement run.
 */

export interface ExitStatusInputs {
  successfulCount: number;
  failedCount: number;
  cleanupFailureCount: number;
  scratchDirCleanupError: string | null;
  closePoolError: string | null;
}

/**
 * Non-zero on: no successful run to report, ANY failed run (even alongside
 * successful ones — a caller checking only "did it exit 0" must not read a
 * partial-failure run as clean), or any housekeeping failure (an
 * application row, the scratch directory, or the database pool itself).
 * Every one of these cases still writes a fully valid report; the exit code
 * exists so a caller knows follow-up is needed instead of trusting a silent
 * "0" that hid it.
 */
export function computeExitCode(inputs: ExitStatusInputs): 0 | 1 {
  const {
    successfulCount,
    failedCount,
    cleanupFailureCount,
    scratchDirCleanupError,
    closePoolError,
  } = inputs;
  if (
    successfulCount === 0 ||
    failedCount > 0 ||
    cleanupFailureCount > 0 ||
    scratchDirCleanupError !== null ||
    closePoolError !== null
  ) {
    return 1;
  }
  return 0;
}
