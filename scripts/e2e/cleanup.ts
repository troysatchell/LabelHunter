/**
 * Removes the rows an E2E run leaves behind (TRO-524).
 *
 * The suite seeds through the real product surface — a real verify
 * submission, a real batch — so every run files real `review_queue` rows.
 * Some are disposed of by the spec that made them; the batch happy path's
 * deliberately-escalated row is not. Repeated runs against the same
 * persistent worktree database therefore accumulated unresolved items,
 * with nothing to stop them from crowding a real reviewer's queue.
 *
 * **Deletes by tag, not by table.** Every spec that creates data brands it
 * with `fixtures.ts`'s `uniqueTag`, which always starts `e2e-`. Deleting
 * applications with that brand prefix removes exactly what the suite made,
 * and nothing a person or another test file put there. Deleting one
 * application cascades to its label image, its verification, and its
 * review-queue row (`src/lib/db/schema.ts` — every FK is
 * `ON DELETE CASCADE`), so one statement cleans a whole fixture tree.
 */
import { like } from "drizzle-orm";
import { db as defaultDb } from "../../src/lib/db";
import { applications } from "../../src/lib/db/schema";

/** The prefix `scripts/e2e/fixtures.ts`'s `uniqueTag` puts on every value
 * it produces. `cleanup.test.ts` asserts the two still agree, so a change
 * to that function cannot silently turn this cleanup into a no-op. */
export const E2E_TAG_PREFIX = "e2e-";

/**
 * Deletes every application an E2E run created, and everything that
 * cascades from it. Returns how many applications it removed, so a caller
 * can report the number rather than claim a cleanup it never observed.
 */
export async function deleteE2ETaggedApplications(db: typeof defaultDb = defaultDb): Promise<number> {
  // `like`, with the prefix as a literal parameter — the prefix is this
  // module's own constant, never caller input, and it carries no LIKE
  // wildcard of its own.
  const deleted = await db
    .delete(applications)
    .where(like(applications.brandName, `${E2E_TAG_PREFIX}%`))
    .returning({ id: applications.id });
  return deleted.length;
}
