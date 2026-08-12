/**
 * Public entry point for turning an accepted batch preview into a running
 * batch job (LH-042 / TRO-475). `src/app/api/batch/start/route.ts` imports
 * from here, matching `../batch-queue/index.ts`'s own convention.
 */
export { extractZipImageBytes, type ExtractZipImageBytesLimits, type ExtractZipImageBytesResult } from "./extract-zip-bytes";
export { startBatchFromPairings, type StartBatchDeps } from "./start-batch";
export type { StartBatchPairingInput, StartBatchResult, StartBatchSkippedImage } from "./types";
