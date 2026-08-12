/**
 * Processes one claimed `RESOLVE` `batch_queue_items` row (LH-041 /
 * TRO-474, CP-3 §2.3, §3.3, §6, §7.1, §8 step 6): rebuilds `ResolverInput`
 * from the `EXTRACT` worker's own snapshot, reserves this batch's Sonnet
 * call budget, calls `resolveEscalatedLabel` (LH-014, already merged —
 * this module calls it, never re-implements its pre-check or its
 * `review_queue` insert), and persists the outcome.
 *
 * **The completion guard runs in a SEPARATE transaction from the
 * `review_queue` write, deliberately.** `resolveEscalatedLabel` (and this
 * module's own `insertSkippedReviewQueueEntry` call for a cap-skip) commit
 * their own `review_queue` insert independently — that write is not, and
 * cannot cleanly be, wrapped inside this module's own completion
 * transaction: `resolveEscalatedLabel` is a black box this ticket calls,
 * not restructures (CP-3 §2.4), and threading a live network call inside
 * an open database transaction is worse practice than the two-step shape
 * here. CP-3 §8 step 6's own worked example describes exactly this
 * ordering: the resolver call happens, THEN "the worker... runs §3.2's
 * completion guard against its RESOLVE row... in the same transaction it
 * updates verifications.resolutionPath... and marks the RESOLVE item
 * DONE" — the guard transaction comes after, not around, the call.
 */
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import { batchJobs, verifications } from "../../lib/db/schema";
import {
  resolveEscalatedLabel as defaultResolveEscalatedLabel,
  insertSkippedReviewQueueEntry,
  type ResolveEscalatedLabelOptions,
  type ResolverInput,
  type ResolverResult,
} from "../resolver";
import { classifyModelCallError, computeBackoffDelayMs, DEFAULT_BACKOFF_CONFIG, type BackoffConfig } from "./backoff";
import type { ClaimedBatchQueueItem } from "./claim";
import { markDone, markFailed, maybeCompleteBatchJob, releaseForRetry } from "./complete";
import { toApplicationRecord, type ApplicationRow } from "./extract-worker";
import { computeSonnetCallCapThreshold, ESCALATION_CAP_EXCEEDED_SKIP_REASON, reserveSonnetCall } from "./escalation-cap";
import { resizeStoredOriginalToSonnetVariant } from "./image";
import { parseResolverInputSnapshot } from "./resolver-snapshot";

export interface ResolveWorkerDeps {
  db: typeof defaultDb;
  readLabelImage: (storagePath: string) => Promise<Buffer>;
  resolveEscalatedLabel?: (input: ResolverInput, options?: ResolveEscalatedLabelOptions) => Promise<ResolverResult>;
  anthropicClient?: ResolveEscalatedLabelOptions["client"];
  backoffConfig: BackoffConfig;
}

export type ResolveOutcomeLabel = "resolved" | "needs-human" | "cap-skipped";

export type ResolveClaimOutcome =
  | { kind: "done"; outcome: ResolveOutcomeLabel }
  /** See `ExtractClaimOutcome`'s matching comment — `isRateLimit` drives
   * `pool.ts`'s whole-pool cooldown (CP-3 §5.3). */
  | { kind: "retry"; delayMs: number; isRateLimit: boolean }
  | { kind: "failed"; reason: string }
  | { kind: "stale" };

function defaultDeps(): Omit<ResolveWorkerDeps, "readLabelImage"> {
  return { db: defaultDb, backoffConfig: DEFAULT_BACKOFF_CONFIG };
}

/**
 * `code`/`constraint` are `pg`'s own `DatabaseError` fields. Verified
 * empirically (not assumed — `resolve-worker.test.ts`'s own TRO-506 case
 * caught this): Drizzle's node-postgres driver does NOT throw that error
 * directly — it wraps it in its own `DrizzleQueryError`, with the real `pg`
 * error underneath as `.cause` (`drizzle-orm/errors.js`). This checks both
 * the caught error itself and one level of `.cause`, so it recognizes a
 * unique violation regardless of which layer's shape changes first.
 *
 * `constraintName`, when given, is checked leniently: a caller that cannot
 * see a `.constraint` (some error-verbosity settings omit it) still counts
 * as a match on `code` alone, rather than silently falling through to "not
 * a unique violation" for a genuine one.
 */
function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  const matches = (candidate: unknown): boolean => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const e = candidate as { code?: unknown; constraint?: unknown };
    if (e.code !== "23505") return false;
    if (constraintName && e.constraint !== undefined && e.constraint !== constraintName) return false;
    return true;
  };
  if (matches(error)) return true;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return matches((error as { cause?: unknown }).cause);
  }
  return false;
}

type ReviewQueueWinningOutcome = { kind: "resolved"; disposition: "resolved" | "needs-human" } | { kind: "skipped" };

/**
 * Reads back who won a `review_queue_verification_id_unique` race, after
 * THIS caller's own insert attempt lost it — either `resolveEscalatedLabel`'s
 * real insert (the TRO-506 shape, CP-3 §3.3) or this module's own
 * `insertSkippedReviewQueueEntry` (a symmetrical race this design adds:
 * one worker's real resolution colliding with another's cap-skip marker,
 * or two cap-skips colliding, both reachable under the SAME lease-expiry
 * double-claim §3.3 already names). Does not reuse
 * `findExistingReviewQueueEntry`'s strict `ResolverResolution` validator —
 * that function is deliberately paranoid for a different purpose (handing
 * a fully-typed result back to a caller expecting one); this only needs
 * the coarse fact of which counter and `resolutionPath` outcome apply.
 */
async function readReviewQueueOutcome(db: typeof defaultDb, verificationId: number): Promise<ReviewQueueWinningOutcome> {
  const row = await db.query.reviewQueue.findFirst({ where: (rq, { eq }) => eq(rq.verificationId, verificationId) });
  if (!row) {
    throw new Error(`expected an existing review_queue row for verification ${verificationId} after a unique-constraint collision; found none.`);
  }
  if (row.resolverSkipReason !== null) return { kind: "skipped" };
  const output = row.resolverOutput as { outcome?: unknown } | null;
  if (output && typeof output === "object" && (output.outcome === "resolved" || output.outcome === "needs-human")) {
    return { kind: "resolved", disposition: output.outcome };
  }
  throw new Error(`review_queue row ${row.id} for verification ${verificationId} has neither a resolverSkipReason nor a recognizable resolverOutput.outcome.`);
}

interface CompletionPlan {
  setResolverPath: boolean;
  counterKey: "resolvedBySonnetCount" | "needsHumanCount";
  outcome: ResolveOutcomeLabel;
}

function planFromWinningOutcome(winning: ReviewQueueWinningOutcome): CompletionPlan {
  if (winning.kind === "skipped") {
    return { setResolverPath: false, counterKey: "needsHumanCount", outcome: "cap-skipped" };
  }
  return {
    setResolverPath: true,
    counterKey: winning.disposition === "resolved" ? "resolvedBySonnetCount" : "needsHumanCount",
    outcome: winning.disposition,
  };
}

/** Guarded completion: marks the `RESOLVE` item `DONE`, conditionally
 * updates `verifications.resolutionPath`, increments the right counter,
 * and checks whether the batch just finished — all in one transaction
 * (CP-3 §3.2, §8 step 6). */
async function completeResolveItem(db: typeof defaultDb, item: ClaimedBatchQueueItem, plan: CompletionPlan): Promise<ResolveClaimOutcome> {
  const guarded = await db.transaction(async (tx) => {
    const ok = await markDone(tx, item.id, item.claimToken as string);
    if (!ok) return false;
    if (plan.setResolverPath) {
      await tx.update(verifications).set({ resolutionPath: "EXTRACTOR_RESOLVER" }).where(sql`${verifications.id} = ${item.verificationId}`);
    }
    const counterColumn = plan.counterKey === "resolvedBySonnetCount" ? batchJobs.resolvedBySonnetCount : batchJobs.needsHumanCount;
    await tx
      .update(batchJobs)
      .set({ [plan.counterKey]: sql`${counterColumn} + 1` })
      .where(sql`${batchJobs.id} = ${item.batchJobId}`);
    await maybeCompleteBatchJob(tx, item.batchJobId);
    return true;
  });
  return guarded ? { kind: "done", outcome: plan.outcome } : { kind: "stale" };
}

/** Releases (retryable, under maxAttempts) or permanently fails (§5.1/§5.2)
 * a claimed RESOLVE item. Only `failedCount` increments on permanent
 * failure — `processedCount` was already incremented when this label's
 * `EXTRACT` item reached `DONE` (CP-3 §7.1's own table — counting it again
 * here would double-count one label). */
async function handleResolveFailure(
  db: typeof defaultDb,
  item: ClaimedBatchQueueItem,
  backoffConfig: BackoffConfig,
  error: unknown,
): Promise<ResolveClaimOutcome> {
  const classification = classifyModelCallError(error);
  const message = error instanceof Error ? error.message : String(error);

  if (classification.retryable && item.attempts < backoffConfig.maxAttempts) {
    const delayMs = computeBackoffDelayMs(item.attempts, backoffConfig, classification.retryAfterMs);
    const guarded = await releaseForRetry(db, item.id, item.claimToken as string, delayMs);
    return guarded ? { kind: "retry", delayMs, isRateLimit: classification.isRateLimit } : { kind: "stale" };
  }

  const lastError = classification.retryable ? `${message} (exhausted after ${item.attempts} attempt(s))` : message;
  const guarded = await db.transaction(async (tx) => {
    const ok = await markFailed(tx, item.id, item.claimToken as string, lastError);
    if (!ok) return false;
    await tx.update(batchJobs).set({ failedCount: sql`${batchJobs.failedCount} + 1` }).where(sql`${batchJobs.id} = ${item.batchJobId}`);
    await maybeCompleteBatchJob(tx, item.batchJobId);
    return true;
  });
  return guarded ? { kind: "failed", reason: lastError } : { kind: "stale" };
}

/** The cap-exhausted path (CP-3 §6.2): no Sonnet call, a skip-marker
 * `review_queue` row instead. Symmetrically races against
 * `resolveEscalatedLabel`'s own insert the same way §3.3 requires for a
 * real call — see the module comment on `readReviewQueueOutcome`. */
async function completeCapSkip(
  db: typeof defaultDb,
  item: ClaimedBatchQueueItem,
  headlineReason: NonNullable<ResolverInput["router"]["headlineReason"]>,
): Promise<ResolveClaimOutcome> {
  let plan: CompletionPlan;
  try {
    await insertSkippedReviewQueueEntry(
      { verificationId: item.verificationId as number, reason: headlineReason, resolverSkipReason: ESCALATION_CAP_EXCEEDED_SKIP_REASON },
      db,
    );
    plan = { setResolverPath: false, counterKey: "needsHumanCount", outcome: "cap-skipped" };
  } catch (error) {
    if (!isUniqueViolation(error, "review_queue_verification_id_unique")) throw error;
    plan = planFromWinningOutcome(await readReviewQueueOutcome(db, item.verificationId as number));
  }
  return completeResolveItem(db, item, plan);
}

/**
 * Runs the resolver for one claimed `RESOLVE` item and persists the
 * outcome. Never throws for an ordinary processing failure — see
 * `processExtractClaim`'s own doc comment for why.
 */
export async function processResolveClaim(item: ClaimedBatchQueueItem, deps: Partial<ResolveWorkerDeps> & Pick<ResolveWorkerDeps, "readLabelImage">): Promise<ResolveClaimOutcome> {
  const d: ResolveWorkerDeps = { ...defaultDeps(), ...deps };
  if (item.kind !== "RESOLVE" || item.verificationId === null || item.resolverInput === null || item.claimToken === null) {
    throw new Error(`processResolveClaim called with a non-RESOLVE or malformed claim (item ${item.id})`);
  }

  const parsed = parseResolverInputSnapshot(item.resolverInput);
  if (!parsed.ok) {
    return handleResolveFailure(d.db, item, d.backoffConfig, new Error(`resolver_input rejected: ${parsed.reason}`));
  }
  const snapshot = parsed.snapshot;
  const headlineReason = snapshot.router.headlineReason;
  if (!headlineReason) {
    // Contract violation, not a normal input — the EXTRACT worker's own
    // invariant check (extract-worker.ts) already guarantees a REVIEW
    // snapshot always carries one. Defensive, standing rule 13.
    return handleResolveFailure(d.db, item, d.backoffConfig, new Error("resolver_input.router has labelVerdict REVIEW but no headlineReason"));
  }

  let resolverInput: ResolverInput;
  try {
    const verificationRow = await d.db.query.verifications.findFirst({
      where: (v, { eq }) => eq(v.id, item.verificationId as number),
      with: { application: true, labelImage: true },
    });
    if (!verificationRow || !verificationRow.application || !verificationRow.labelImage) {
      throw new Error(`verification ${item.verificationId} or its application/labelImage not found for batch_queue_item ${item.id}`);
    }
    const applicationRow: ApplicationRow = verificationRow.application;
    const labelImageRow = verificationRow.labelImage;

    const original = await d.readLabelImage(labelImageRow.storagePath);
    const sonnetVariant = await resizeStoredOriginalToSonnetVariant(original, labelImageRow.widthPx, labelImageRow.heightPx);

    resolverInput = {
      verificationId: item.verificationId as number,
      image: { data: sonnetVariant.toString("base64"), mediaType: "image/jpeg" },
      extraction: snapshot.extraction,
      application: toApplicationRecord(applicationRow),
      router: snapshot.router,
      flaggedFields: snapshot.flaggedFields,
    };
  } catch (error) {
    return handleResolveFailure(d.db, item, d.backoffConfig, error);
  }

  const batchJobRow = await d.db.query.batchJobs.findFirst({ where: (bj, { eq }) => eq(bj.id, item.batchJobId) });
  if (!batchJobRow) {
    // Unreachable under normal operation — batch_queue_items.batch_job_id
    // is a NOT NULL FK to batch_jobs. Defensive, not a real code path.
    throw new Error(`batch job ${item.batchJobId} not found for batch_queue_item ${item.id}`);
  }
  const capThreshold = computeSonnetCallCapThreshold(batchJobRow.totalCount);
  const reserved = await reserveSonnetCall(d.db, item.batchJobId, capThreshold);

  if (!reserved) {
    return completeCapSkip(d.db, item, headlineReason);
  }

  let plan: CompletionPlan;
  try {
    const result = await (d.resolveEscalatedLabel ?? defaultResolveEscalatedLabel)(resolverInput, { client: d.anthropicClient, db: d.db });
    plan = { setResolverPath: true, counterKey: result.outcome === "resolved" ? "resolvedBySonnetCount" : "needsHumanCount", outcome: result.outcome };
  } catch (error) {
    if (isUniqueViolation(error, "review_queue_verification_id_unique")) {
      plan = planFromWinningOutcome(await readReviewQueueOutcome(d.db, item.verificationId as number));
    } else {
      return handleResolveFailure(d.db, item, d.backoffConfig, error);
    }
  }

  return completeResolveItem(d.db, item, plan);
}
