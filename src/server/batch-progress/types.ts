/**
 * Shapes for the batch progress + results read side (LH-042 / TRO-475, PRD
 * §3.5, §5, TH-R4).
 */
import type { BatchJobStatus, FieldVerdict } from "../../lib/db/enums";
import type { BatchThroughputStats } from "../../lib/utils/batch-throughput";
import type { LatencyStats } from "../../lib/utils/latency-stats";

/**
 * Which visual family a result row's overall Status belongs to — drives a
 * CSS class, the same "tone, not a bare word" shape `LABEL_BANNER_CLASS`
 * (`ResultsChecklist.tsx`) already uses for the single-label verdict
 * banner. `"pending"` covers both a still-QUEUED and a currently-PROCESSING
 * item — `statusText` carries the more specific word; the tone only needs
 * to say "nothing to act on yet" for styling purposes.
 */
export const BATCH_RESULT_STATUS_TONES = ["pass", "fail", "review", "failed", "pending"] as const;
export type BatchResultStatusTone = (typeof BATCH_RESULT_STATUS_TONES)[number];

/**
 * One row of the batch results table (PRD §5: "Label / Brand / ABV / Net /
 * Warning / Status"). `brand`/`abv`/`net`/`warning` are the per-FIELD
 * verdict (✓ / ✗ / ⚠) — the batch-table digitization of the same checklist
 * Sarah's own quote names field by field ("Brand name matches? Check. ABV
 * is correct? Check. Government warning is there? Check.",
 * `audit/requirements/source-TH.md`) — `null` when that field's verdict is
 * not available yet (the label has not finished the EXTRACT phase, or it
 * failed before producing one). `statusText`/`statusTone` are the OVERALL
 * label-level outcome, separate from the four field marks — a first-time
 * user reads Status for "is this label done, and how," and the four field
 * columns for "which field, specifically."
 */
export interface BatchResultRow {
  /** Stable React/DOM key: `v-<verificationId>` once the label has a
   * verification row, `q-<batchQueueItemId>` while it does not yet
   * (queued, processing, or a failed EXTRACT with no verification at all —
   * CP-3 §7.3). */
  key: string;
  label: string;
  brandName: string;
  brand: FieldVerdict | null;
  abv: FieldVerdict | null;
  net: FieldVerdict | null;
  warning: FieldVerdict | null;
  statusText: string;
  statusTone: BatchResultStatusTone;
  /** A secondary, more specific diagnostic line — populated only for a
   * FAILED row, straight from `batch_queue_items.last_error` (CP-3 §7.3:
   * "the single source of truth LH-042's results table reads for a failed
   * row's status text"). `statusText` alone stays a clean, always-safe
   * sentence; this carries whatever more specific detail the stored error
   * gives, exactly the way a field row's own `reason` line already
   * supplements its verdict badge (`DetailView.tsx`). `null` for every
   * other row. */
  statusDetail: string | null;
  /** Click-through target (PRD §5's "→ click-through to detail"). `null`
   * when there is no detail page yet — a queued, processing, or failed
   * item never produced a `verifications` row. */
  verificationId: number | null;
}

/** Surfaces LH-041's own real backoff/cooldown state (`../batch-queue/backoff.ts`)
 * without recomputing it — observed as its effect on the queue rows this
 * batch owns, since the worker pool's in-memory cooldown timestamp lives in
 * a separate process (`scripts/batch-worker/run.ts`) this HTTP route cannot
 * read directly. `active` is true when at least one item is PENDING with an
 * `availableAt` still in the future and at least one prior attempt — i.e.
 * genuinely waiting out a scheduled retry delay, not merely unclaimed yet. */
export interface BatchRateLimitBackoff {
  active: boolean;
  itemCount: number;
}

export interface BatchProgressSummary {
  batchJobId: number;
  status: BatchJobStatus;
  totalCount: number;
  processedCount: number;
  /** PASS + FAIL combined — decided without Sonnet or a human (CP-3 §7.1's
   * own explicit warning: this does NOT mean "passed"; see `passCount`/
   * `failCount` for that split). */
  autoVerifiedCount: number;
  /** Computed from `verifications.verdict` directly (CP-3 §7.1), not
   * derived from `autoVerifiedCount` — the split that column cannot answer
   * on its own. */
  passCount: number;
  failCount: number;
  resolvedBySonnetCount: number;
  needsHumanCount: number;
  failedCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  /** `null` until at least one label has finished the EXTRACT phase —
   * never a fabricated `0` (standing rules 1/2). */
  latency: LatencyStats | null;
  /** Items/minute and the reciprocal per-item average, for the WHOLE batch
   * (PRD §3.8, TH-R4) — `null` until the batch reaches a terminal state
   * (`startedAt`/`completedAt` both set), since the wall-clock span is not
   * final before then. See `../../lib/utils/batch-throughput.ts`'s own doc
   * comment for how this differs from `latency` above. */
  throughput: BatchThroughputStats | null;
  /** The share of PROCESSED labels finished without a resolver call
   * (CP-1 §4.5 step 3's own definition) — a `0..1` fraction, `null` until
   * at least one label has processed. This is what turns the disposition
   * mix into a claim about time an agent did not have to spend. */
  autoVerifiedShare: number | null;
  rateLimitBackoff: BatchRateLimitBackoff;
  results: BatchResultRow[];
}

export type GetBatchProgressResult = { found: true; progress: BatchProgressSummary } | { found: false };
