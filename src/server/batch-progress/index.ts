/**
 * Public entry point for the batch progress read side (LH-042 / TRO-475).
 * The polling route (`src/app/api/batch/[batchJobId]/route.ts`) imports
 * from here, matching `../batch-queue/index.ts`'s own convention.
 */
export { getBatchProgress } from "./get-batch-progress";
export type { BatchProgressSummary, BatchRateLimitBackoff, BatchResultRow, BatchResultStatusTone, GetBatchProgressResult } from "./types";
export { BATCH_RESULT_STATUS_TONES } from "./types";
