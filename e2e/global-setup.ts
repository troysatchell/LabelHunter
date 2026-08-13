/**
 * Playwright's global setup (TRO-524): clears the rows earlier E2E runs
 * left behind, before this run starts.
 *
 * Cleanup runs at the START of a run, not the end, on purpose. A run that
 * crashes, times out, or is interrupted never reaches a teardown — and
 * those are exactly the runs that leave rows behind. Clearing first means
 * the queue is empty for every run regardless of how the last one ended,
 * which is what "reliably" has to mean here.
 *
 * It also keeps the evidence: after a failed run, the rows that run
 * created are still in the database for a person to read.
 */
import { closePool, db } from "../src/lib/db";
import { deleteE2ETaggedApplications } from "../scripts/e2e/cleanup";

export default async function globalSetup(): Promise<void> {
  try {
    const removed = await deleteE2ETaggedApplications(db);
    console.log(`[e2e] cleared ${removed} application(s) left by earlier E2E runs`);
  } finally {
    // Playwright's config process must be able to exit; an open pool holds
    // idle sockets that keep it alive. Closed in `finally` so a failed
    // delete still releases the connection (standing rule 24 — one step's
    // failure must not skip the rest of the cleanup).
    await closePool();
  }
}
