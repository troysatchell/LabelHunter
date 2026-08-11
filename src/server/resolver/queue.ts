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
 *
 * This function alone does not prevent the WASTE a duplicate call causes —
 * by the time an insert here fails, a second, real-money Sonnet call has
 * already happened. `findExistingReviewQueueEntry` below is the check that
 * runs BEFORE the model call, in `index.ts`, precisely to avoid paying for
 * that call at all on a retry.
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

export interface ExistingReviewQueueEntry {
  id: number;
  resolverOutput: ResolverResolution;
}

/**
 * Narrows an unknown jsonb value to `ResolverResolution` — a shallow but
 * decisive check. It exists to tell this module's own shape apart from
 * `db:seed.ts`'s own hand-written `resolverOutput` fixture, which predates
 * this ticket and uses a different ad hoc shape (`{ resolvedAbvPercent,
 * note, confidence }`, no `outcome`/`fields`) — that fixture correctly
 * fails this check rather than being silently misread as a real resolution.
 */
function isResolverResolution(value: unknown): value is ResolverResolution {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (obj.outcome === "resolved" || obj.outcome === "needs-human") && Array.isArray(obj.fields);
}

/**
 * Looks up an existing `review_queue` row for a verification, if one
 * exists. `resolveEscalatedLabel` (`index.ts`) calls this BEFORE calling
 * the model — the review-queue unique index already guarantees at most one
 * row per verification, but by the time an insert hits that constraint, a
 * second Sonnet call has already been paid for. A duplicate call for one
 * verification is exactly the shape of an at-least-once retry (a caller
 * bug today, and a completely ordinary event once the future batch worker's
 * own retry/backoff exists, CP-1 §9 open question 6) — checking first turns
 * a wasted real-money call into a free, correct no-op.
 *
 * Throws when a row exists but its `resolverOutput` does not match this
 * module's `ResolverResolution` shape, rather than silently trusting or
 * silently ignoring data it cannot interpret (this repo's "reject, never
 * clamp/guess" boundary rule — CLAUDE.md lesson 13).
 */
export async function findExistingReviewQueueEntry(
  verificationId: number,
  db: ResolverDb = defaultDb,
): Promise<ExistingReviewQueueEntry | null> {
  const existing = await db.query.reviewQueue.findFirst({
    where: (rq, { eq }) => eq(rq.verificationId, verificationId),
  });
  if (!existing) return null;
  if (!isResolverResolution(existing.resolverOutput)) {
    throw new Error(
      `findExistingReviewQueueEntry: verification ${verificationId} already has a review_queue row ` +
        `(id ${existing.id}) whose resolverOutput does not match this module's ResolverResolution shape ` +
        "— refusing to reuse it or to silently re-run the model behind the unique constraint's back.",
    );
  }
  return { id: existing.id, resolverOutput: existing.resolverOutput };
}
