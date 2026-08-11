/**
 * Review-queue insertion (LH-014 / TRO-464, PRD §3.3/§3.4, TH-R22).
 *
 * One row per escalated verification (`../../lib/db/schema.ts`'s
 * `reviewQueue`, unique on `verificationId`) — both a `resolved` and a
 * `needs-human` outcome insert here, matching `db:seed`'s own fixture
 * (a `REVIEW`-verdict verification gets a `review_queue` row with
 * `disposition: null` even though the resolver already produced output;
 * `disposition` is a HUMAN's approve/reject action, recorded by a later
 * ticket, never set by this module).
 *
 * `resolverOutput` carries the full, business-rule-enforced resolution
 * (`ResolverResolution` — the recomputed `outcome` plus every
 * `ResolvedFieldResult`) as the schema's jsonb column already expects
 * (`db:seed`'s own fixture stores a comparable ad hoc shape). This is the
 * auditable trail TH-R22 asks for: a reviewer can see exactly what the
 * resolver read and why, without re-running the model.
 */
import { reviewQueue } from "../../lib/db/schema";
import { db as defaultDb } from "../../lib/db";
import type { ReviewReason } from "../router/types";
import type { ResolverResolution } from "./types";

export interface InsertReviewQueueEntryParams {
  verificationId: number;
  /** The label's headline `ReviewReason` (`LabelRouterResult.headlineReason`) —
   * why this verification escalated in the first place. */
  reason: ReviewReason;
  resolverOutput: ResolverResolution;
}

/** The Drizzle database handle this module writes through — the shared
 * singleton by default, injectable for tests (same pattern as the
 * extractor's `client`). */
export type ResolverDb = typeof defaultDb;

/**
 * Inserts one `review_queue` row for an escalated verification. Postgres
 * enforces "at most one row per verification" via the table's own unique
 * index — a second call for the same `verificationId` throws, and this
 * function does not catch or paper over that; a pipeline calling it twice
 * for one verification is a real bug the constraint is there to catch.
 */
export async function insertReviewQueueEntry(
  params: InsertReviewQueueEntryParams,
  db: ResolverDb = defaultDb,
): Promise<{ id: number }> {
  const [row] = await db
    .insert(reviewQueue)
    .values({
      verificationId: params.verificationId,
      reason: params.reason,
      resolverOutput: params.resolverOutput,
    })
    .returning({ id: reviewQueue.id });
  return row;
}
