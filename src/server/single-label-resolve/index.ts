/**
 * Public entry point for the single-label resolve trigger (TRO-511, CP-3
 * §9/§12 open question 5). `scripts/batch-worker/run.ts` imports from here,
 * not from individual files — same convention as `../batch-queue/index.ts`.
 */
export { claimNextReviewQueueResolveItem, type ClaimedReviewQueueResolveItem, type ClaimNextReviewQueueResolveItemOptions } from "./claim";
export {
  processSingleLabelResolveClaim,
  startSingleLabelResolveWorker,
  type SingleLabelResolveClaimOutcome,
  type SingleLabelResolveOutcomeLabel,
  type SingleLabelResolveWorkerConfig,
  type SingleLabelResolveWorkerDeps,
  type SingleLabelResolveWorkerHandle,
} from "./worker";
