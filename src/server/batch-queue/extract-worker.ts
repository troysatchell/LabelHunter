/**
 * Processes one claimed `EXTRACT` `batch_queue_items` row (LH-041 /
 * TRO-474, CP-3 §2.4, §7.1, §8): reads the stored image, runs the Haiku
 * extractor and the deterministic router — exactly the cascade
 * `src/app/api/verify/route.ts` already runs for a single label — then
 * persists the result, mirroring that route's own transaction shape
 * (§2.4's table) for `verifications`/`field_results`, plus a new `RESOLVE`
 * queue item when the router escalates (§8 step 5).
 *
 * **`warningResult` is injectable, defaulting to `null`.** As of this
 * ticket, `verify/route.ts` passes `warningResult: null` to `routeLabel`
 * unconditionally — LH-020 (the warning subsystem) is not wired in yet.
 * Because `government_warning` is `required` for every beverage type
 * (`../router/required-fields.ts`) and `resolveGovernmentWarningField`
 * returns `NEEDS_REVIEW` whenever the field is present/required and no
 * comparator result is supplied, this means EVERY current submission —
 * single-label or batch — resolves to `REVIEW` at the label level today
 * (confirmed: `route.test.ts`'s own "happy path" test asserts
 * `labelVerdict === "REVIEW"`, not `PASS`). This worker inherits that same
 * honest limitation unchanged. `warningResult` is a constructor-injectable
 * dependency, not a hardcoded `null`, purely so this ticket's own tests can
 * exercise the PASS/FAIL/`autoVerifiedCount` code paths without waiting on
 * LH-020 — production code never sets it, so production behavior is
 * byte-for-byte identical to always passing `null`.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import type { FieldName } from "../../lib/db/enums";
import { batchJobs, batchQueueItems, fieldResults, verifications } from "../../lib/db/schema";
import { extractLabel as defaultExtractLabel, type ExtractLabelOptions, type HaikuExtractionResult, type PreprocessedLabelImage } from "../extractor";
import { computeResizeDimensions, HAIKU_MAX_LONG_EDGE_PX } from "../preprocessing";
import {
  routeLabel,
  type ApplicationRecord,
  type FieldComparators,
  type LabelVerdict,
  type RouterFieldKey,
  type WarningComparatorResult,
} from "../router";
import { readLabelImage as defaultReadLabelImage } from "../storage/local-file-storage";
import { classifyModelCallError, computeBackoffDelayMs, DEFAULT_BACKOFF_CONFIG, type BackoffConfig } from "./backoff";
import type { ClaimedBatchQueueItem } from "./claim";
import { markDone, markFailed, maybeCompleteBatchJob, releaseForRetry } from "./complete";
import { resizeStoredOriginalToHaikuVariant } from "./image";
import { buildResolverInputSnapshot, deriveFlaggedFields } from "./resolver-snapshot";

const ROUTER_FIELD_TO_DB_FIELD_NAME: Record<RouterFieldKey, FieldName> = {
  brand_name: "BRAND_NAME",
  class_type: "CLASS_TYPE",
  alcohol_content: "ALCOHOL_CONTENT",
  net_contents: "NET_CONTENTS",
  government_warning: "GOVERNMENT_WARNING",
};

export interface ExtractWorkerDeps {
  db: typeof defaultDb;
  comparators: FieldComparators;
  readLabelImage: (storagePath: string) => Promise<Buffer>;
  extractLabel?: (image: PreprocessedLabelImage, options?: ExtractLabelOptions) => Promise<HaikuExtractionResult>;
  anthropicClient?: Anthropic;
  /** See the file comment — always `null` in production. */
  warningResult?: WarningComparatorResult | null;
  backoffConfig: BackoffConfig;
}

export type ExtractClaimOutcome =
  | { kind: "done"; verificationId: number; verdict: LabelVerdict; escalated: boolean }
  /** `isRateLimit` distinguishes a 429 from any other retryable failure —
   * `pool.ts`'s whole-pool cooldown (CP-3 §5.3) only ever engages on a
   * rate limit specifically, matching the design doc's own "whenever any
   * worker sees a 429," not on every transient error. */
  | { kind: "retry"; delayMs: number; isRateLimit: boolean }
  | { kind: "failed"; reason: string }
  /** This worker's own claim episode was no longer current by the time it
   * tried to finish — another worker already reclaimed and completed (or
   * is completing) the item. Its result is discarded, not an error. */
  | { kind: "stale" };

/** Applications-row shape this module reads back — narrower than the full
 * Drizzle-inferred type, naming exactly the fields `toApplicationRecord`
 * and the caller need. Exported for `resolve-worker.ts`'s own use — the
 * SAME shape, read via a different join path (`verifications.application`
 * instead of a direct lookup), still needs the same conversion. */
export interface ApplicationRow {
  id: number;
  beverageType: ApplicationRecord["beverageType"];
  brandName: string;
  classType: string;
  abvPercent: number | null;
  netContentsValue: number | null;
  netContentsUnit: string | null;
}

/**
 * `netContentsValue`/`netContentsUnit` are nullable at the database level
 * (`schema.ts`'s `applications` table predates this ticket) but
 * `ApplicationRecord` requires both — a null value here is a malformed
 * application row, not a legal "not filed" state (unlike `abvPercent`,
 * which `ApplicationRecord` itself models as optional). Reject rather than
 * coerce to a fabricated `0`/`""` (standing rule 13).
 */
export function toApplicationRecord(row: ApplicationRow): ApplicationRecord {
  if (row.netContentsValue === null || row.netContentsUnit === null) {
    throw new Error(`applications row ${row.id} is missing netContentsValue/netContentsUnit — cannot build a valid ApplicationRecord.`);
  }
  return {
    beverageType: row.beverageType,
    brandName: row.brandName,
    classType: row.classType,
    alcoholContentPercent: row.abvPercent ?? undefined,
    netContentsValue: row.netContentsValue,
    netContentsUnit: row.netContentsUnit,
  };
}

function defaultDeps(): ExtractWorkerDeps {
  return {
    db: defaultDb,
    comparators: undefined as unknown as FieldComparators, // production callers must supply real comparators explicitly
    readLabelImage: defaultReadLabelImage,
    extractLabel: defaultExtractLabel,
    warningResult: null,
    backoffConfig: DEFAULT_BACKOFF_CONFIG,
  };
}

/** Releases (retryable, under maxAttempts) or permanently fails (CP-3
 * §5.1/§5.2) a claimed EXTRACT item that failed before persistence ever
 * started. Runs OUTSIDE any transaction — the item is still `CLAIMED` with
 * its original `claimToken`, whether the failure came from image I/O, the
 * extractor call, or the router's own invariant check. */
async function handleExtractFailure(
  db: typeof defaultDb,
  item: ClaimedBatchQueueItem,
  backoffConfig: BackoffConfig,
  error: unknown,
): Promise<ExtractClaimOutcome> {
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
    await tx
      .update(batchJobs)
      .set({ processedCount: sql`${batchJobs.processedCount} + 1`, failedCount: sql`${batchJobs.failedCount} + 1` })
      .where(sql`${batchJobs.id} = ${item.batchJobId}`);
    await maybeCompleteBatchJob(tx, item.batchJobId);
    return true;
  });
  return guarded ? { kind: "failed", reason: lastError } : { kind: "stale" };
}

/**
 * Runs the cascade for one claimed `EXTRACT` item and persists the result.
 * Never throws for an ordinary processing failure — every retryable/
 * non-retryable/stale-lease outcome is returned, not thrown, so a worker
 * pool loop (`pool.ts`) can move on to its next claim unconditionally.
 *
 * Throws (does NOT return a `failed` outcome) for a caller/config bug: a
 * malformed claim, or a missing `comparators` dependency. `defaultDeps()`
 * deliberately stubs `comparators` with a value that is unsafe to actually
 * call `routeLabel` with — a misconfigured worker must stop loudly, not
 * mark every item it touches `FAILED` one at a time with a confusing
 * `TypeError` as `last_error`, which would read as a data problem instead
 * of the deployment problem it actually is.
 */
export async function processExtractClaim(item: ClaimedBatchQueueItem, deps: Partial<ExtractWorkerDeps> = {}): Promise<ExtractClaimOutcome> {
  const d: ExtractWorkerDeps = { ...defaultDeps(), ...deps };
  if (item.kind !== "EXTRACT" || item.applicationId === null || item.labelImageId === null || item.claimToken === null) {
    throw new Error(`processExtractClaim called with a non-EXTRACT or malformed claim (item ${item.id})`);
  }
  if (!d.comparators) {
    throw new Error("processExtractClaim: ExtractWorkerDeps.comparators is required — the pool operator must supply real comparators, e.g. productionComparators.");
  }

  let extraction: HaikuExtractionResult;
  let routerResult: ReturnType<typeof routeLabel>;
  let application: ApplicationRow;

  try {
    // Two independent reads — run concurrently, not sequentially.
    const [applicationRow, labelImageRow] = await Promise.all([
      d.db.query.applications.findFirst({ where: (a, { eq }) => eq(a.id, item.applicationId as number) }),
      d.db.query.labelImages.findFirst({ where: (li, { eq }) => eq(li.id, item.labelImageId as number) }),
    ]);
    if (!applicationRow || !labelImageRow) {
      throw new Error(`application ${item.applicationId} or label image ${item.labelImageId} not found for batch_queue_item ${item.id}`);
    }
    application = applicationRow;

    const original = await d.readLabelImage(labelImageRow.storagePath);
    const haikuVariant = await resizeStoredOriginalToHaikuVariant(original, labelImageRow.widthPx, labelImageRow.heightPx);
    const extractorImage: PreprocessedLabelImage = { data: haikuVariant.toString("base64"), mediaType: "image/jpeg" };
    extraction = await (d.extractLabel ?? defaultExtractLabel)(extractorImage, { client: d.anthropicClient });

    const applicationRecord = toApplicationRecord(application);
    const haikuDims = computeResizeDimensions({ width: labelImageRow.widthPx, height: labelImageRow.heightPx }, HAIKU_MAX_LONG_EDGE_PX);
    routerResult = routeLabel(extraction, applicationRecord, d.comparators, d.warningResult ?? null, {
      rejected: false,
      longEdgePx: Math.max(haikuDims.width, haikuDims.height),
    });

    // Mirrors verify/route.ts's own defensive invariant check exactly —
    // standing rule 13: name the invariant, don't trust it silently.
    if (routerResult.labelVerdict === "REVIEW" && routerResult.headlineReason === null) {
      throw new Error("routeLabel returned REVIEW with no headlineReason — router invariant violated");
    }
  } catch (error) {
    return handleExtractFailure(d.db, item, d.backoffConfig, error);
  }

  try {
    const result = await d.db.transaction(async (tx) => {
      const guarded = await markDone(tx, item.id, item.claimToken as string);
      if (!guarded) return { kind: "stale" as const };

      const [verificationRow] = await tx
        .insert(verifications)
        .values({
          applicationId: item.applicationId as number,
          labelImageId: item.labelImageId as number,
          batchJobId: item.batchJobId,
          verdict: routerResult.labelVerdict,
          // Sonnet has not run in this transaction — matches
          // verify/route.ts:225-227's own comment: LH-014's resolver
          // updates this once it consumes the review_queue row.
          resolutionPath: "EXTRACTOR_ONLY",
        })
        .returning();

      await tx.insert(fieldResults).values(
        routerResult.fields.map((row) => ({
          verificationId: verificationRow.id,
          fieldName: ROUTER_FIELD_TO_DB_FIELD_NAME[row.field],
          extractedValue: row.labelValue,
          evidence: row.evidence,
          confidence: row.confidence,
          verdict: row.verdict,
          reason: row.reason,
        })),
      );

      const escalated = routerResult.labelVerdict === "REVIEW";
      if (escalated) {
        const flaggedFields = deriveFlaggedFields(routerResult);
        const snapshot = buildResolverInputSnapshot(extraction, routerResult, flaggedFields);
        await tx.insert(batchQueueItems).values({
          batchJobId: item.batchJobId,
          kind: "RESOLVE",
          verificationId: verificationRow.id,
          resolverInput: snapshot,
        });
      }

      await tx
        .update(batchJobs)
        .set({
          processedCount: sql`${batchJobs.processedCount} + 1`,
          ...(escalated ? {} : { autoVerifiedCount: sql`${batchJobs.autoVerifiedCount} + 1` }),
        })
        .where(sql`${batchJobs.id} = ${item.batchJobId}`);

      await maybeCompleteBatchJob(tx, item.batchJobId);

      return { kind: "done" as const, verificationId: verificationRow.id, verdict: routerResult.labelVerdict, escalated };
    });
    return result;
  } catch (error) {
    return handleExtractFailure(d.db, item, d.backoffConfig, error);
  }
}
