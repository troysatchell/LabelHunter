/**
 * Shapes for `GET /api/batch/:batchJobId` — the batch progress polling
 * endpoint (LH-042 / TRO-475, PRD §3.5, §5, TH-R4). Pure types only — no
 * server-only import — matching every other route's own `types.ts` file's
 * discipline in this codebase.
 */
import type { BatchJobStatus, FieldVerdict } from "../../../../lib/db/enums";
import type { LatencyStats } from "../../../../lib/utils/latency-stats";
import type { BatchResultStatusTone } from "../../../../server/batch-progress/types";

export type { BatchResultStatusTone };

/** The wire twin of `src/server/batch-progress/types.ts`'s `BatchResultRow`
 * — identical shape; this file exists only because that one's `Date`-typed
 * fields would otherwise cross a real `fetch()`/JSON boundary silently
 * mistyped (the same reasoning `src/app/api/review-queue/types.ts`'s own
 * header comment states). `BatchResultRow` carries no `Date` field itself,
 * so this type is structurally identical today — kept as its own type
 * anyway, matching this codebase's established wire/server split, so a
 * future server-side addition (e.g. a timestamp) does not silently leak
 * across the boundary unnoticed. */
export interface BatchResultRowWire {
  key: string;
  label: string;
  brandName: string;
  brand: FieldVerdict | null;
  abv: FieldVerdict | null;
  net: FieldVerdict | null;
  warning: FieldVerdict | null;
  statusText: string;
  statusTone: BatchResultStatusTone;
  statusDetail: string | null;
  verificationId: number | null;
}

export interface BatchRateLimitBackoffWire {
  active: boolean;
  itemCount: number;
}

export interface BatchProgressResponse {
  batchJobId: number;
  status: BatchJobStatus;
  totalCount: number;
  processedCount: number;
  autoVerifiedCount: number;
  passCount: number;
  failCount: number;
  resolvedBySonnetCount: number;
  needsHumanCount: number;
  failedCount: number;
  startedAt: string | null;
  completedAt: string | null;
  latency: LatencyStats | null;
  rateLimitBackoff: BatchRateLimitBackoffWire;
  results: BatchResultRowWire[];
}

export const BATCH_PROGRESS_ERROR_KINDS = ["VALIDATION", "NOT_FOUND", "SERVICE"] as const;
export type BatchProgressErrorKind = (typeof BATCH_PROGRESS_ERROR_KINDS)[number];

export interface BatchProgressErrorResponse {
  error: {
    kind: BatchProgressErrorKind;
    message: string;
  };
}
