/**
 * Public entry point for the batch job queue + worker pool (LH-041 /
 * TRO-474, CP-3). LH-040 (batch upload) and LH-042 (progress UI) import
 * from here, not from individual files.
 */
export { claimNextBatchQueueItem, type ClaimedBatchQueueItem, type ClaimNextBatchQueueItemOptions } from "./claim";
export { markDone, markFailed, maybeCompleteBatchJob, releaseForRetry } from "./complete";
export {
  classifyModelCallError,
  computeBackoffDelayMs,
  DEFAULT_BACKOFF_CONFIG,
  DEFAULT_POOL_COOLDOWN_MS,
  noteRateLimited,
  waitMsForCooldown,
  type BackoffConfig,
  type ModelCallErrorClassification,
  type PoolCooldownState,
} from "./backoff";
export {
  computeSonnetCallCapThreshold,
  ESCALATION_CAP_EXCEEDED_SKIP_REASON,
  reserveSonnetCall,
  RESOLVER_SKIP_REASONS,
  SONNET_ESCALATION_CAP_FRACTION,
  type ResolverSkipReason,
} from "./escalation-cap";
export {
  buildResolverInputSnapshot,
  deriveFlaggedFields,
  parseResolverInputSnapshot,
  RESOLVER_INPUT_SCHEMA_VERSION,
  type ParsedResolverInputSnapshot,
  type ResolverInputSnapshotV1,
} from "./resolver-snapshot";
export { resizeStoredOriginalToHaikuVariant, resizeStoredOriginalToSonnetVariant } from "./image";
export { enqueueExtractItems, startBatchJob, type ExtractPairing } from "./lifecycle";
export { processExtractClaim, toApplicationRecord, type ExtractClaimOutcome, type ExtractWorkerDeps } from "./extract-worker";
export { processResolveClaim, type ResolveClaimOutcome, type ResolveOutcomeLabel, type ResolveWorkerDeps } from "./resolve-worker";
export { startWorkerPool, type MinimalClaimOutcome, type WorkerPoolConfig, type WorkerPoolHandle } from "./pool";
