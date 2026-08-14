/**
 * Processes one claimed `EXTRACT` `batch_queue_items` row (LH-041 /
 * TRO-474, CP-3 §2.4, §7.1, §8): reads the stored image, runs the Haiku
 * extractor and the deterministic router — exactly the cascade
 * `src/app/api/verify/route.ts` already runs for a single label — then
 * persists the result, mirroring that route's own transaction shape
 * (§2.4's table) for `verifications`/`field_results`, plus a new `RESOLVE`
 * queue item when the router escalates (§8 step 5).
 *
 * **Government warning (TRO-517).** This worker calls LH-020's real
 * comparator on every claimed item: `deps.compareGovernmentWarning`
 * (default `compareGovernmentWarningFromImage`, `../warning`) reaches
 * `routeLabel` as a real `WarningComparatorResult`, not a hardcoded
 * `null`. TH-R9's word-for-word check is live for the batch path — the
 * same wiring TRO-514 built for `verify/route.ts`.
 *
 * CP-2 §4.4 sets two rules for the call, both about latency:
 *
 * 1. **Concurrent, not serial.** `deps.compareGovernmentWarning` starts
 *    before the Haiku call resolves. It receives the extraction as a
 *    still-pending `Promise` (`extractionPromise.then(...)`, never an
 *    `await`ed value) — so region detection and OCR run alongside Haiku,
 *    not after it.
 * 2. **A thrown error degrades one field. It never fails the item.**
 *    `resolveWarningOrDegrade` (below) catches it — a rejected promise or
 *    a synchronous throw, either one — and passes `null` for
 *    `warningResult`: the same "uncertain beats wrong" behavior
 *    `verify/route.ts` uses. `resolveGovernmentWarningField`
 *    (`../router/field-resolution.ts`) already routes a `null` result to
 *    `NEEDS_REVIEW`, never a fabricated match — the item still completes
 *    and is marked `DONE`, escalated to a `RESOLVE` item like any other
 *    REVIEW verdict, never `retry`/`failed`.
 *
 * The comparator reads `original` — the full-resolution buffer
 * `readLabelImage` returns — never the resized `haikuVariant`. CP-2 §8.3:
 * the resized variant falls below the OCR engine's usable resolution at
 * the statute's legal minimum print size (1 mm).
 *
 * **Daily budget (TRO-566 finding 1).** Before this ticket, this worker
 * never checked or recorded the daily spend budget at all — a batch
 * admitted under budget (`/api/batch/start`'s own gate) could run past the
 * daily cap once in flight. This module now reserves
 * `HAIKU_CALL_RESERVE_ESTIMATE_USD` of today's budget BEFORE every Haiku
 * call, atomically (`../budget/daily-budget.ts`'s `reserveDailyBudget` —
 * closes the check-then-act race finding 2 also named), and settles the
 * reservation to the call's REAL, measured cost right after (or refunds it
 * in full if the call never actually happened). A refused reservation
 * throws `BudgetExhaustedError`, caught by this function's own outer catch
 * below and classified by `backoff.ts`'s `classifyModelCallError` exactly
 * like any other retryable condition — see that error class's own doc
 * comment for the full design rationale (why "fail the remaining items,
 * not pause the batch").
 */
import type Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import type { FieldName } from "../../lib/db/enums";
import { batchJobs, batchQueueItems, fieldResults, verifications } from "../../lib/db/schema";
import {
  BudgetExhaustedError,
  HAIKU_CALL_RESERVE_ESTIMATE_USD,
  reserveDailyBudget,
  settleBudgetReservation,
  type BudgetReservation,
} from "../budget/daily-budget";
import { haikuCallCostUsd, wrapAnthropicClientForUsageCapture } from "../budget/anthropic-usage";
import {
  extractLabel as defaultExtractLabel,
  getDefaultExtractorClient,
  type ExtractLabelOptions,
  type HaikuExtractionResult,
  type PreprocessedLabelImage,
} from "../extractor";
import {
  routeLabel,
  type ApplicationRecord,
  type FieldComparators,
  type LabelVerdict,
  type RouterFieldKey,
  type WarningComparatorResult,
} from "../router";
import { readLabelImage as defaultReadLabelImage } from "../storage/db-image-storage";
import {
  compareGovernmentWarningFromImage as defaultCompareGovernmentWarning,
  type BoldSignalResult,
  type CompareGovernmentWarningFromImageInput,
  type CompareGovernmentWarningFromImageResult,
} from "../warning";
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
  /** LH-020's warning comparator (`compareGovernmentWarningFromImage`,
   * `../warning`), wired in for real by TRO-517 — see this file's header
   * comment. Injectable so a test can supply a fake with a controlled
   * result or controlled timing, the same DI shape `extractLabel` above
   * already uses. Called with the extraction as a still-pending `Promise`
   * (see `processExtractClaim`'s own comment); a fake that wants to prove
   * the concurrency requirement can hold that promise open. Defaults to
   * the real function in `defaultDeps()` below — production callers do
   * not need to set this. */
  compareGovernmentWarning?: (input: CompareGovernmentWarningFromImageInput) => Promise<CompareGovernmentWarningFromImageResult>;
  backoffConfig: BackoffConfig;
  /**
   * TRO-566 finding 1. Reserves `estimatedUsd` of today's daily spend
   * budget atomically, BEFORE the Haiku call — see this file's own header
   * comment. Optional, with an always-reserve fallback
   * (`ALLOW_ALL_RESERVATION`) inside `processExtractClaim` itself: this
   * field predates none of this file's own pre-existing test suite, so
   * every test built before this ticket keeps passing unchanged — it
   * never sets this field and gets the safe default. `defaultDeps()`
   * below binds the REAL, DB-backed function, so production (called via
   * `scripts/batch-worker/run.ts`, which does not override this field)
   * gets real enforcement without any change to that entry point.
   */
  reserveBudget?: (estimatedUsd: number) => Promise<BudgetReservation>;
  /**
   * TRO-566 finding 1. Corrects a reservation to the call's real, measured
   * cost (or refunds it in full when the call never happened) — see
   * `../budget/daily-budget.ts`'s `settleBudgetReservation`. Same
   * optional/safe-default shape as `reserveBudget`, for the same reason.
   */
  settleBudget?: (reservedUsd: number, realUsd: number) => Promise<void>;
}

export type ExtractClaimOutcome =
  | { kind: "done"; verificationId: number; verdict: LabelVerdict; escalated: boolean }
  /** `isRateLimit` distinguishes a 429 from any other retryable failure —
   * `pool.ts`'s whole-pool cooldown (CP-3 §5.3) only ever engages on a
   * rate limit specifically, matching the design doc's own "whenever any
   * worker sees a 429," not on every transient error. `isBudgetExhausted`
   * (TRO-566) is the SAME kind of pool-wide signal for a different cause —
   * see `backoff.ts`'s `classifyModelCallError`/`BudgetExhaustedError` and
   * `pool.ts`'s own comment on why the two flags stay distinct. */
  | { kind: "retry"; delayMs: number; isRateLimit: boolean; isBudgetExhausted?: boolean }
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

/** Used only when a caller's `deps` does not set `reserveBudget` — see
 * that field's own doc comment. `reservedUsd: 0`: nothing was really
 * reserved, so `settleBudgetReservation` (called with THIS reservation's
 * own `reservedUsd`, not the constant directly) correctly settles it as a
 * no-op too. */
const ALLOW_ALL_RESERVATION: BudgetReservation = { reserved: true, reservedUsd: 0, spentUsd: 0, budgetUsd: 0 };

/** Used only when a caller's `deps` does not set `settleBudget` — see that
 * field's own doc comment. */
async function noopSettleBudget(): Promise<void> {}

/**
 * Settles a reservation, logging (never throwing) a write failure — the
 * same best-effort posture `verify/route.ts` already uses for its own
 * spend recording: a ledger write failure must not fail an otherwise-
 * successful item, and it must not be silent either (standing rule 24).
 */
async function settleReservationBestEffort(
  settleBudget: ExtractWorkerDeps["settleBudget"],
  reservedUsd: number,
  realUsd: number,
): Promise<void> {
  try {
    await (settleBudget ?? noopSettleBudget)(reservedUsd, realUsd);
  } catch (cause) {
    console.error("Could not settle a daily-budget reservation for a batch EXTRACT item", cause);
  }
}

function defaultDeps(): ExtractWorkerDeps {
  return {
    db: defaultDb,
    comparators: undefined as unknown as FieldComparators, // production callers must supply real comparators explicitly
    readLabelImage: defaultReadLabelImage,
    extractLabel: defaultExtractLabel,
    compareGovernmentWarning: defaultCompareGovernmentWarning,
    backoffConfig: DEFAULT_BACKOFF_CONFIG,
    // TRO-566 — real, DB-backed by default (not an allow-all stand-in):
    // `scripts/batch-worker/run.ts` calls `processExtractClaim` with a
    // PARTIAL deps object that does not set either field, so this default
    // is what actually enforces the budget in production. Tests that want
    // a safe, deterministic stand-in set their own (this file's
    // `alwaysReserveBudget`/`noopSettleBudget`), the same shadowing
    // `compareGovernmentWarning` above already relies on.
    reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, defaultDb),
    settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, defaultDb),
    /**
     * TRO-566 — real, measured evidence (a live-API observed run) caught
     * this missing: without it, `d.anthropicClient` stays `undefined` in
     * production (`scripts/batch-worker/run.ts` does not set it either),
     * so `wrapAnthropicClientForUsageCapture(undefined)` wraps nothing —
     * `extractLabel` still calls the real API (falling back to its OWN
     * shared default client, `../extractor/index.ts`), but this worker's
     * usage capture never sees that call, `takeLastUsage()` always answers
     * `null`, and `settleBudget` always refunds the FULL reservation even
     * after a genuinely successful, real-money call. The EXACT bug shape
     * `verify/route.ts`'s own `defaultDeps` getter fixes for TRO-482 —
     * see that file's matching comment. A getter, not a plain value, for
     * the same reason: `getDefaultExtractorClient()` builds the client on
     * first use and memoizes, so importing this module never constructs
     * one, and every claim after the first reuses it.
     */
    get anthropicClient(): Anthropic {
      return getDefaultExtractorClient();
    },
  };
}

/**
 * Runs the warning comparator and turns a thrown error into `null` — CP-2
 * §4.4 rule 3: an OCR failure degrades the answer, it never fails the
 * item. Mirrors `verify/route.ts`'s own `resolveWarningOrDegrade`
 * (TRO-514) exactly: `try`/`await`/`catch` here catches both a rejected
 * promise and a synchronous throw from `compare` — an injected
 * dependency's failure mode is not guaranteed, so this is the boundary
 * that checks it (standing rule 13), not an assumption that every
 * implementation is a well-behaved `async function`.
 */
async function resolveWarningOrDegrade(
  compare: (input: CompareGovernmentWarningFromImageInput) => Promise<CompareGovernmentWarningFromImageResult>,
  input: CompareGovernmentWarningFromImageInput,
): Promise<CompareGovernmentWarningFromImageResult | null> {
  try {
    return await compare(input);
  } catch {
    return null;
  }
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
    return guarded
      ? { kind: "retry", delayMs, isRateLimit: classification.isRateLimit, isBudgetExhausted: classification.isBudgetExhausted }
      : { kind: "stale" };
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
  // TRO-533 — the bold advisory signal, captured alongside `warningResult`
  // below. TRO-569: its `.signal` discriminant IS threaded into
  // `routeLabel` too (a separate argument, never folded into
  // `warningResult` itself) — see `field-resolution.ts`'s own header
  // comment for the degrade rule this enables. `null` until the warning
  // check actually runs.
  let boldSignalResult: BoldSignalResult | null = null;

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
    const extractorImage: PreprocessedLabelImage = { data: haikuVariant.buffer.toString("base64"), mediaType: "image/jpeg" };

    // TRO-566 finding 1/2 — reserve BEFORE the Haiku call, atomically, so
    // this worker cannot spend past the daily cap and cannot race a
    // concurrent reservation (this file's own header comment). A refused
    // reservation throws; the outer catch below classifies and retries it
    // exactly like any other retryable condition.
    const reservation = await (d.reserveBudget ?? (async () => ALLOW_ALL_RESERVATION))(HAIKU_CALL_RESERVE_ESTIMATE_USD);
    if (!reservation.reserved) {
      throw new BudgetExhaustedError(reservation);
    }

    const usageCapture = wrapAnthropicClientForUsageCapture(d.anthropicClient);
    const extractionPromise = (d.extractLabel ?? defaultExtractLabel)(extractorImage, { client: usageCapture.client });
    // `.then`, not `await` — this is what starts the warning check in the
    // same tick as the Haiku call instead of after it resolves (this
    // file's header comment, CP-2 §4.4 rule 1). The `.catch(() => {})`
    // below only marks the derived promise as handled, so a fake
    // `compareGovernmentWarning` (most tests' `deps`) that never reads
    // `input.extracted` cannot log a spurious Node "unhandled rejection"
    // when extraction itself fails — it does not change what either
    // promise resolves or rejects with.
    const governmentWarningExtraction = extractionPromise.then((result) => result.government_warning);
    governmentWarningExtraction.catch(() => {});
    const warningPromise = resolveWarningOrDegrade(d.compareGovernmentWarning ?? defaultCompareGovernmentWarning, {
      extracted: governmentWarningExtraction,
      // The ORIGINAL, full-resolution image — never `haikuVariant`. See
      // this file's header comment / CP-2 §8.3.
      originalImage: original,
    });

    let warningOutcome: CompareGovernmentWarningFromImageResult | null;
    try {
      [extraction, warningOutcome] = await Promise.all([extractionPromise, warningPromise]);
    } catch (callError) {
      // The Haiku call itself failed — no real cost was incurred. Refund
      // the reservation in full before this propagates to the outer
      // catch's retry/fail classification, so a failed call never leaves a
      // permanent phantom charge in the ledger (TRO-566).
      await settleReservationBestEffort(d.settleBudget, reservation.reservedUsd, 0);
      throw callError;
    }
    // The call succeeded and really happened; its real cost is owed
    // regardless of what happens next in this item's processing —
    // recorded best-effort, mirroring verify/route.ts's own posture: a
    // ledger write failure must not fail an otherwise-successful item.
    const haikuUsage = usageCapture.takeLastUsage();
    await settleReservationBestEffort(d.settleBudget, reservation.reservedUsd, haikuUsage ? haikuCallCostUsd(haikuUsage) : 0);
    // TRO-533 — see `verify/route.ts`'s identical split: `warningResult` is
    // the ONLY piece of `warningOutcome` that reaches `routeLabel`, below.
    const warningResult: WarningComparatorResult | null = warningOutcome?.comparator ?? null;
    boldSignalResult = warningOutcome?.boldSignal ?? null;

    const applicationRecord = toApplicationRecord(application);
    // longEdgePx comes from the variant sharp ACTUALLY produced
    // (`haikuVariant.dims`), not a second, separately-computed
    // `computeResizeDimensions` call against the same width/height — one
    // real source of truth for what was actually sent to the model,
    // instead of two call sites that could silently drift apart.
    routerResult = routeLabel(
      extraction,
      applicationRecord,
      d.comparators,
      warningResult,
      {
        rejected: false,
        longEdgePx: Math.max(haikuVariant.dims.width, haikuVariant.dims.height),
      },
      // TRO-569 — same wiring as verify/route.ts: only the `.signal`
      // discriminant reaches the router.
      boldSignalResult?.signal ?? null,
    );

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
          // TRO-533 — persisted for every batch verification too, matching
          // verify/route.ts exactly, independent of what `routeLabel` did
          // with it. TRO-569: `routerResult` above WAS computed with
          // `boldSignalResult.signal` in view (the MATCH -> REVIEW degrade
          // rule) — this column still stores the full result.
          boldSignal: boldSignalResult,
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
