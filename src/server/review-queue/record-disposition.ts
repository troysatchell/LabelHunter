/**
 * Records a human reviewer's approve/reject decision on one review-queue
 * item (TRO-476, PRD §5: "approve/reject records disposition"). This is
 * the ONLY write this ticket makes to `review_queue` — it never touches
 * `verifications.verdict`. The PRD line asks for exactly one fact to be
 * recorded (the disposition); it says nothing about changing a stored
 * verdict, so this module does not invent that mutation. See this ticket's
 * report for this scope decision, flagged as an open question rather than
 * built silently.
 *
 * No reviewer identity is recorded anywhere here — deliberate, per TH-R6
 * (`schema.ts`'s own comment on `reviewQueue`). Do not add one.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { db as defaultDb } from "../../lib/db";
import { reviewQueue } from "../../lib/db/schema";
import type { ReviewDisposition } from "../../lib/db/enums";
import type { RecordDispositionOutcome } from "./types";

/**
 * The `WHERE` clause below guards against two different races with one
 * condition: `disposition IS NULL` means this UPDATE only ever touches a
 * row that is still genuinely pending, so two reviewers acting on the same
 * item at nearly the same moment cannot both "win" — exactly one UPDATE
 * matches a row, the other matches zero and falls through to the
 * `already-disposed` branch below. This is also what makes the write
 * atomic with respect to the schema's own CHECK constraint
 * (`review_queue_disposition_disposed_at_consistency`): `disposition` and
 * `disposedAt` are set together, in the same single-statement UPDATE,
 * never one before the other.
 */
export async function recordDisposition(
  db: typeof defaultDb,
  id: number,
  disposition: ReviewDisposition,
): Promise<RecordDispositionOutcome> {
  const disposedAt = new Date();
  const [updated] = await db
    .update(reviewQueue)
    .set({ disposition, disposedAt })
    .where(and(eq(reviewQueue.id, id), isNull(reviewQueue.disposition)))
    .returning({ id: reviewQueue.id });

  if (updated) {
    return { status: "recorded", id: updated.id, disposition, disposedAt };
  }

  // The guarded UPDATE above matched zero rows — either this id does not
  // exist, or it exists but was already disposed (by this call or an
  // earlier one). Read the row plainly to tell the two apart.
  const [existing] = await db
    .select({ disposition: reviewQueue.disposition, disposedAt: reviewQueue.disposedAt })
    .from(reviewQueue)
    .where(eq(reviewQueue.id, id));
  if (!existing) return { status: "not-found" };

  // Invariant: the guarded UPDATE's WHERE clause only fails to match an
  // EXISTING id when disposition IS NOT NULL for it — so both columns must
  // be set here (the schema's own CHECK constraint guarantees they are set
  // together). Naming this rather than trusting it silently, standing
  // rule 13.
  if (existing.disposition === null || existing.disposedAt === null) {
    throw new Error(
      `recordDisposition: review_queue row ${id} did not match the pending UPDATE but has no disposition — ` +
        "the disposition/disposedAt consistency invariant is violated.",
    );
  }
  return { status: "already-disposed", disposition: existing.disposition, disposedAt: existing.disposedAt };
}
