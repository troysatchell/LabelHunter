/**
 * POST /api/verify — the single-label verify flow (TRO-465, PRD §3.8, §5,
 * TH-R1).
 *
 * One request does the whole cascade's fast path: preprocess the uploaded
 * photo, run the Haiku extractor, route the result deterministically, and
 * persist every table PRD §3.6 names for a single-label verify
 * (`applications`, `label_images`, `verifications`, `field_results`, and
 * `review_queue` when the label needs review). It returns per-field
 * verdicts plus the label verdict in the same response — no polling.
 *
 * On a REVIEW route this returns immediately with the reason (PRD §3.8's
 * "verdict or an explicit flag" latency contract). It never calls Sonnet —
 * the cascade is the architecture (TH-R19): Sonnet only ever sees escalations
 * the router routed to it, and only LH-014's resolver (a sibling ticket, not
 * yet merged) calls it, asynchronously, off the `review_queue` row this
 * route writes.
 *
 * **Comparators.** LH-013 (TRO-463) merged: `productionComparators`
 * (`../../../server/comparators`) — fuzzy brand/class matching (normalized
 * similarity, TH-R8's STONE'S THROW case), and real ABV/net-contents
 * parsing — is wired in below. `brand_name`/`class_type` still never
 * assert `MISMATCH` (CP-1 §5.3: distance beyond threshold routes to
 * REVIEW, a judgment call, never a silent FAIL); `alcohol_content` and
 * `net_contents` now DO assert `MISMATCH` on a genuine numeric
 * disagreement (LH-013's own design, not this ticket's). This is the ONE
 * place a `FieldComparators` value reaches `routeLabel` in this route —
 * this ticket's earlier provisional stand-in (`provisional-comparators.ts`)
 * is deleted, superseded by this import.
 *
 * **Government warning (TRO-514).** LH-020 built the comparator. This
 * route now calls it on every request: `deps.compareGovernmentWarning`
 * (default `compareGovernmentWarningFromImage`, `../../../server/warning`)
 * reaches `routeLabel` as a real `WarningComparatorResult`, not a
 * hardcoded `null`. TH-R9's word-for-word check is live.
 *
 * CP-2 §4.4 sets two rules for the call, both about latency:
 *
 * 1. **Concurrent, not serial.** `deps.compareGovernmentWarning` starts
 *    before the Haiku call resolves. It receives the extraction as a
 *    still-pending `Promise` (`extractionPromise.then(...)`, never an
 *    `await`ed value) — so region detection and OCR run alongside Haiku,
 *    not after it. PRD §3.8's latency budget has no room for both,
 *    serially.
 * 2. **A thrown error degrades one field. It never fails the request.** A
 *    REVIEW outcome is `compareGovernmentWarning`'s normal return value,
 *    not a throw — `reconcileWarningChannels` is pure and synchronous, and
 *    the OCR half already converts its own failures to
 *    `{ available: false }` (`../../../server/warning/index.ts`). A throw
 *    here means a genuine infrastructure failure. `resolveWarningOrDegrade`
 *    (below) catches it — a synchronous throw or a rejected promise, either
 *    one — and passes `null` for `warningResult`: the same "uncertain beats
 *    wrong" behavior this route always had. `resolveGovernmentWarningField`
 *    (`../../../server/router/field-resolution.ts`) already routes a
 *    `null` result to `NEEDS_REVIEW`, never a fabricated match.
 *
 * The comparator reads `preprocessed.original`, the full-resolution image
 * — never the resized `haikuVariant`. CP-2 §8.3: the resized variant falls
 * below the OCR engine's usable resolution at the statute's legal minimum
 * print size (1 mm).
 *
 * **Single-label resolution trigger (TRO-511, CP-3 §9/§12 open question
 * 5).** On a REVIEW verdict this route still inserts a `review_queue` row
 * immediately, unchanged — a human sees "needs review" the moment this
 * request returns (PRD §5), never gated on a Sonnet call this route does
 * NOT make (TH-R19, PRD §3.8's 5-second budget). New: the row now ALSO
 * carries `resolverInput`, a `{ schemaVersion, extraction, router,
 * flaggedFields }` snapshot built by `deriveFlaggedFields`/
 * `buildResolverInputSnapshot` (`../../../server/batch-queue/resolver-snapshot`
 * — the SAME pure functions the batch `EXTRACT` worker already uses for its
 * own `batch_queue_items.resolver_input` snapshot, CP-3 §2.3, reused here
 * rather than re-derived). `src/server/single-label-resolve`'s worker polls
 * for exactly this: a `review_queue` row with `resolverInput` set and no
 * resolution yet, and calls `resolveEscalatedLabel` for it off the request
 * path, in the SAME background-worker process PRD §3.6 names (singular).
 *
 * **Per-stage timing (TRO-539, PRD §3.8).** Every 200 response carries a
 * `Server-Timing` header with one measured entry per PRD §3.8 stage --
 * preprocess, ocr, haiku, router, db (`./server-timing.ts`). `ocr` times
 * `deps.compareGovernmentWarning` as a whole (region detection + OCR +
 * reconciliation, CP-2 §4.4) -- PRD §3.8's table names the row "OCR"; this
 * is the closest single number this route can attribute to it without
 * instrumenting inside the warning subsystem's own internals. `db` times
 * `deps.saveLabelImage` (TRO-518: image bytes to Postgres) together with
 * the transaction below, as one combined figure -- PRD §3.8's table has no
 * separate row for "save the image" versus "write the verification
 * tables". `haiku` and `ocr` run concurrently (rule 1 above); their
 * reported durations can overlap in wall-clock time and are not meant to
 * sum to the total. A non-200 response carries no `Server-Timing` header --
 * an early error means at least one stage never ran, and a header with a
 * missing entry is worse than no header (a reader could mistake "absent"
 * for "0ms"). `scripts/latency/measure.ts`'s `--url` mode
 * (`parseServerTimingHeader`) reads this header off a real network
 * response to get the same per-stage breakdown a browser's own DevTools
 * Network panel already shows for any request.
 */
import { NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import type { FieldName } from "../../../lib/db/enums";
import { db as defaultDb } from "../../../lib/db";
import { applications, fieldResults, labelImages, reviewQueue, verifications } from "../../../lib/db/schema";
import {
  extractLabel as defaultExtractLabel,
  getDefaultExtractorClient,
  HaikuExtractionError,
  type ExtractLabelOptions,
  type HaikuExtractionResult,
  type PreprocessedLabelImage,
} from "../../../server/extractor";
import {
  computeResizeDimensions,
  HAIKU_MAX_LONG_EDGE_PX,
  preprocessImage as defaultPreprocessImage,
  PreprocessingError,
  type PreprocessedImage,
} from "../../../server/preprocessing";
import {
  routeLabel,
  type ApplicationRecord,
  type FieldComparators,
  type RouterFieldKey,
  type WarningComparatorResult,
} from "../../../server/router";
import { productionComparators } from "../../../server/comparators";
import { buildResolverInputSnapshot, deriveFlaggedFields } from "../../../server/batch-queue/resolver-snapshot";
import { buildFieldReasonText } from "../../../server/router/reason-text";
import {
  compareGovernmentWarningFromImage as defaultCompareGovernmentWarning,
  type CompareGovernmentWarningFromImageInput,
  type CompareGovernmentWarningFromImageResult,
} from "../../../server/warning";
import { saveLabelImage as defaultSaveLabelImage, type SavedLabelImage } from "../../../server/storage/db-image-storage";
import { checkVerifyRateLimit, type RateLimitCheckResult } from "../../../server/rate-limit/instances";
import {
  BUDGET_CHECK_UNAVAILABLE_MESSAGE,
  BUDGET_EXHAUSTED_MESSAGE,
  HAIKU_CALL_RESERVE_ESTIMATE_USD,
  reserveDailyBudget,
  settleBudgetReservation,
  type BudgetReservation,
} from "../../../server/budget/daily-budget";
import { haikuCallCostUsd, wrapAnthropicClientForUsageCapture } from "../../../server/budget/anthropic-usage";
import { parseVerifyFormData } from "./parse-request";
import { buildServerTimingHeader, SERVER_TIMING_STAGES, type ServerTimingStage, type StageTimingsMs } from "./server-timing";
import { FIELD_LABELS, type VerifyErrorKind, type VerifyErrorResponse, type VerifyFieldResult, type VerifySuccessResponse } from "./types";

const ROUTER_FIELD_TO_DB_FIELD_NAME: Record<RouterFieldKey, FieldName> = {
  brand_name: "BRAND_NAME",
  class_type: "CLASS_TYPE",
  alcohol_content: "ALCOHOL_CONTENT",
  net_contents: "NET_CONTENTS",
  government_warning: "GOVERNMENT_WARNING",
};

/**
 * Everything this route calls out to — a real Anthropic client, a real
 * database, real disk I/O. Every test in `route.test.ts` supplies its own
 * `deps`, the same dependency-injection shape `extractLabel` itself uses
 * (`ExtractLabelOptions.client`, `../../../server/extractor/index.test.ts`):
 * no live Anthropic call and no accidental write into the real
 * `var/uploads` ever happens from the unit suite.
 */
export interface VerifyRouteDeps {
  db: typeof defaultDb;
  preprocessImage: (upload: Buffer) => Promise<PreprocessedImage>;
  extractLabel: (image: PreprocessedLabelImage, options?: ExtractLabelOptions) => Promise<HaikuExtractionResult>;
  /** LH-020's warning comparator (`compareGovernmentWarningFromImage`,
   * `../../../server/warning`) — injectable so a test can supply a fake
   * with a controlled result or controlled timing, the same DI shape as
   * every other dependency here. Called with the extraction as a still-
   * pending `Promise` (see this file's header comment); a fake that wants
   * to prove the concurrency requirement can hold that promise open.
   * Returns `{ comparator, boldSignal }` (TRO-533). `comparator` reaches
   * `routeLabel` as `warningResult`; `boldSignal` reaches it too (TRO-569),
   * but only as its `.signal` discriminant, passed as a separate,
   * dedicated parameter — never folded into `comparator`/`warningResult`
   * itself. `boldSignal` is also persisted in full, independent of what
   * `routeLabel` does with `.signal`. */
  compareGovernmentWarning: (input: CompareGovernmentWarningFromImageInput) => Promise<CompareGovernmentWarningFromImageResult>;
  saveLabelImage: (bytes: Buffer, originalFilename: string) => Promise<SavedLabelImage>;
  comparators: FieldComparators;
  /** Threaded into `extractLabel`'s own `options.client` — see the
   * `extractLabel` test suite's `fakeClient` pattern. `undefined` in
   * production, which makes `extractLabel` fall back to its own shared
   * default client. */
  anthropicClient?: ExtractLabelOptions["client"];
  /**
   * TRO-482 / LH-061, PRD §8. Checked FIRST, before any expensive work —
   * per-IP + global fixed-window limits (`../../../server/rate-limit/`).
   * Optional, with an always-allow fallback in `handleVerifyRequest`
   * itself: this field predates none of the existing test suite, so every
   * test built before this ticket keeps passing with no changes — it
   * simply never sets this field, and gets the safe default. Production
   * (`POST` below) always supplies the real, shared limiter singletons.
   */
  checkRateLimit?: (request: Request) => RateLimitCheckResult;
  /**
   * TRO-482 / LH-061, PRD §8. Checked second, still BEFORE the Haiku call
   * — the persisted daily spend budget (`../../../server/budget/
   * daily-budget.ts`). Same optional/always-allow-by-default shape as
   * `checkRateLimit`, for the same reason.
   *
   * TRO-566 finding 2: renamed from `checkBudget` (a read-only check) to
   * `reserveBudget` (an atomic reservation) — a plain read-then-decide
   * left a check-then-act race open: two concurrent requests could both
   * read "under budget" before either had spent anything, and both
   * proceed. `reserveDailyBudget` closes it (see that function's own doc
   * comment).
   */
  reserveBudget?: (estimatedUsd: number) => Promise<BudgetReservation>;
  /**
   * TRO-482 / LH-061. Corrects this request's reservation to the real,
   * measured Haiku cost after the call (or refunds it in full if the call
   * failed) — TRO-566 finding 2's other half. Optional, no-op by default —
   * the pre-existing test suite neither sets this nor needs to: with no
   * settler wired, nothing is written, so those tests touch `daily_spend`
   * not at all. Production wires the real, DB-backed
   * `settleBudgetReservation`.
   */
  settleBudget?: (reservedUsd: number, realUsd: number) => Promise<void>;
}

/**
 * The production wiring. Exported so `route.test.ts` can run the real
 * object — not a hand-rebuilt copy of it — and prove each guard is really
 * bound. A test that rebuilds this object cannot detect a binding this
 * object loses, which is the exact failure that shipped a budget nothing
 * ever wrote to (TRO-482, merge review round 1).
 */
export const defaultDeps: VerifyRouteDeps = {
  db: defaultDb,
  preprocessImage: defaultPreprocessImage,
  extractLabel: defaultExtractLabel,
  compareGovernmentWarning: defaultCompareGovernmentWarning,
  saveLabelImage: defaultSaveLabelImage,
  comparators: productionComparators,
  checkRateLimit: checkVerifyRateLimit,
  reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, defaultDb),
  settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, defaultDb),
  /**
   * TRO-482, merge review round 1. This binding is what makes the daily
   * budget real, and it was missing until that review found it.
   *
   * Without it, `deps.anthropicClient` was `undefined` in production.
   * `wrapAnthropicClientForUsageCapture(undefined)` then returned a
   * capture whose `takeLastUsage()` always answers `null`, so
   * `settleBudget` below was never reached with a real cost, `daily_spend`
   * was never written, and the reservation check read 0 forever. The
   * guard could not trip. Binding the same shared client `extractLabel`
   * would have fallen back to gives the wrapper something real to read
   * usage from.
   *
   * A getter, not a plain value: `getDefaultExtractorClient()` builds the
   * client on first use, so importing this route never constructs one.
   * The call memoizes, so every request after the first reuses it.
   *
   * Sharing that one client across concurrent requests is safe. The
   * wrapper does not mutate it — see `anthropic-usage.ts`'s own header.
   */
  get anthropicClient(): ExtractLabelOptions["client"] {
    return getDefaultExtractorClient();
  },
};

/** Used only when a caller's `deps` does not set `checkRateLimit` — see
 * that field's own doc comment. */
const ALLOW_ALL_RATE_LIMIT: RateLimitCheckResult = { allowed: true, message: "" };

/** Used only when a caller's `deps` does not set `reserveBudget` — see
 * that field's own doc comment. `reservedUsd: 0`: nothing was really
 * reserved, so a later settle call (also given THIS reservation's own
 * `reservedUsd`, not the constant directly) correctly no-ops too. */
const ALLOW_ALL_RESERVATION: BudgetReservation = { reserved: true, reservedUsd: 0, spentUsd: 0, budgetUsd: 0 };

/** Used only when a caller's `deps` does not set `settleBudget` — see that
 * field's own doc comment. */
async function noopSettleBudget(): Promise<void> {}

function errorResponse(status: number, kind: VerifyErrorKind, message: string): NextResponse<VerifyErrorResponse> {
  return NextResponse.json({ error: { kind, message } }, { status });
}

/**
 * Settles a reservation, logging (never throwing) a write failure — the
 * same best-effort posture this route already used for its own spend
 * recording pre-TRO-566: a ledger write failure must not fail an
 * otherwise-successful request, and it must not be silent either
 * (standing rule 24). Mirrors `extract-worker.ts`'s own
 * `settleReservationBestEffort` — small, independent duplication between
 * two call sites, the same posture this file's `resolveWarningOrDegrade`
 * already takes relative to that file's own copy.
 */
async function settleReservationBestEffort(
  settleBudget: VerifyRouteDeps["settleBudget"],
  reservedUsd: number,
  realUsd: number,
): Promise<void> {
  try {
    await (settleBudget ?? noopSettleBudget)(reservedUsd, realUsd);
  } catch (cause) {
    console.error("Could not settle a daily-budget reservation for a verify request", cause);
  }
}

/**
 * Runs the warning comparator and turns a thrown error into `null` — CP-2
 * §4.4 rule 3: an OCR failure degrades the answer, it never fails the
 * request. `try`/`await`/`catch` here catches both a rejected promise and
 * a synchronous throw from `compare` — an injected dependency's failure
 * mode is not guaranteed, so this is the boundary that checks it (standing
 * rule 13), not an assumption that every implementation is a well-behaved
 * `async function`.
 */
async function resolveWarningOrDegrade(
  compare: VerifyRouteDeps["compareGovernmentWarning"],
  input: CompareGovernmentWarningFromImageInput,
): Promise<CompareGovernmentWarningFromImageResult | null> {
  try {
    return await compare(input);
  } catch {
    return null;
  }
}

/** One `handleVerifyRequest` call's own stage clock (TRO-539). `null` until
 * that stage completes — a local, per-request value, never shared across
 * requests, so concurrent requests to this route never see one another's
 * timings. */
type MutableStageTimingsMs = Record<ServerTimingStage, number | null>;

function newStageTimings(): MutableStageTimingsMs {
  return { preprocess: null, ocr: null, haiku: null, router: null, db: null };
}

/**
 * Turns a `MutableStageTimingsMs` into the `StageTimingsMs`
 * `buildServerTimingHeader` needs, once every stage has actually run.
 * Throws if any stage is still `null` — this route only calls it right
 * before building the 200 response, by which point preprocess, haiku, ocr,
 * router, and db have all necessarily completed (every earlier `return`
 * is an error response, built before this function is ever reached).
 * Naming this invariant here, rather than trusting it silently, is
 * standing rule 13 — the same posture the REVIEW/headlineReason check
 * below already takes.
 */
function requireCompleteStageTimings(timings: MutableStageTimingsMs): StageTimingsMs {
  const complete = {} as StageTimingsMs;
  for (const stage of SERVER_TIMING_STAGES) {
    const value = timings[stage];
    if (value === null) {
      throw new Error(`handleVerifyRequest: reached a 200 response with no "${stage}" stage timing recorded`);
    }
    complete[stage] = value;
  }
  return complete;
}

export async function handleVerifyRequest(request: Request, deps: VerifyRouteDeps = defaultDeps): Promise<Response> {
  // TRO-482 / LH-061, PRD §8 — key protection. Both checks below run
  // BEFORE any expensive work: no form parsing, no preprocessing, no
  // Haiku call. Rate limit first (cheap, in-memory, no I/O), budget
  // second (a real database read) — cheapest, most common rejection
  // reason checked first. They also run before the stage clock below: a
  // rejected request runs no stage at all, so it reports no timings.
  const rateLimitResult = (deps.checkRateLimit ?? (() => ALLOW_ALL_RATE_LIMIT))(request);
  if (!rateLimitResult.allowed) {
    return errorResponse(429, "RATE_LIMITED", rateLimitResult.message);
  }

  // TRO-566 finding 2 — an atomic RESERVATION, not a read-then-decide
  // check: closes the race where concurrent requests could all read
  // "under budget" before any of them had spent anything. TRO-566 finding
  // 3 — a ledger failure here fails closed (no model call happens either
  // way) with the DESIGNED 503 response, never an unhandled 500.
  let budgetReservation: BudgetReservation;
  try {
    budgetReservation = await (deps.reserveBudget ?? (async () => ALLOW_ALL_RESERVATION))(HAIKU_CALL_RESERVE_ESTIMATE_USD);
  } catch (cause) {
    console.error("Could not check today's spending limit", cause);
    return errorResponse(503, "SERVICE", BUDGET_CHECK_UNAVAILABLE_MESSAGE);
  }
  if (!budgetReservation.reserved) {
    return errorResponse(503, "BUDGET_EXHAUSTED", BUDGET_EXHAUSTED_MESSAGE);
  }

  // TRO-539: this request's own stage clock — see this file's header
  // comment ("Per-stage timing") and `./server-timing.ts`. Local to this
  // call; never shared across concurrent requests.
  const stageTimingsMs = newStageTimings();

  // TRO-566 — every early return between the reservation above and the
  // Haiku call below must refund it in full; none of these represents any
  // real spend. The Haiku call's own success/failure paths settle for
  // real, further down.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    await settleReservationBestEffort(deps.settleBudget, budgetReservation.reservedUsd, 0);
    return errorResponse(400, "VALIDATION", "LabelHunter could not read this submission. Try again.");
  }

  const parsed = parseVerifyFormData(formData);
  if (!parsed.ok) {
    await settleReservationBestEffort(deps.settleBudget, budgetReservation.reservedUsd, 0);
    return errorResponse(400, "VALIDATION", parsed.message);
  }
  const input = parsed.value;
  const imageBytes = Buffer.from(await input.imageFile.arrayBuffer());

  const preprocessStart = performance.now();
  let preprocessed: PreprocessedImage;
  try {
    preprocessed = await deps.preprocessImage(imageBytes);
  } catch (cause) {
    await settleReservationBestEffort(deps.settleBudget, budgetReservation.reservedUsd, 0);
    if (cause instanceof PreprocessingError) {
      return errorResponse(422, "IMAGE", cause.message);
    }
    return errorResponse(503, "SERVICE", "LabelHunter could not process this photo. Try again.");
  }
  stageTimingsMs.preprocess = performance.now() - preprocessStart;

  const extractorImage: PreprocessedLabelImage = {
    data: preprocessed.haikuVariant.toString("base64"),
    mediaType: preprocessed.mediaType,
  };
  // TRO-482 — wraps whatever client this call would already use (a real
  // Anthropic client in production, a test fake in `route.test.ts`)
  // transparently: same request, same response, same error behavior. If
  // `deps.anthropicClient` is `undefined`, `usageCapture.client` is too,
  // and `extractLabel` falls back to its own shared default client exactly
  // as before this ticket — this is a NEW way to read usage off whatever
  // client ends up handling the call, not a new client. See
  // `../../../server/budget/anthropic-usage.ts`'s own header comment for
  // why this file does not wrap the shared default client directly.
  const usageCapture = wrapAnthropicClientForUsageCapture(deps.anthropicClient);
  const haikuStart = performance.now();
  const extractionPromise = deps.extractLabel(extractorImage, { client: usageCapture.client }).finally(() => {
    stageTimingsMs.haiku = performance.now() - haikuStart;
  });

  // `.then`, not `await` — this is what starts the warning check in the
  // same tick as the Haiku call instead of after it resolves (this file's
  // header comment, rule 1). The `.catch(() => {})` below only marks the
  // derived promise as handled, so a fake `compareGovernmentWarning` (most
  // tests' `deps`) that never reads `input.extracted` cannot log a
  // spurious Node "unhandled rejection" when extraction itself fails,
  // below — it does not change what either promise resolves or rejects
  // with.
  const governmentWarningExtraction = extractionPromise.then((result) => result.government_warning);
  governmentWarningExtraction.catch(() => {});
  const ocrStart = performance.now();
  const warningPromise = resolveWarningOrDegrade(deps.compareGovernmentWarning, {
    extracted: governmentWarningExtraction,
    // The ORIGINAL, full-resolution image — never `haikuVariant`. See this
    // file's header comment.
    originalImage: preprocessed.original,
  }).finally(() => {
    stageTimingsMs.ocr = performance.now() - ocrStart;
  });

  let extraction: HaikuExtractionResult;
  let warningOutcome: CompareGovernmentWarningFromImageResult | null;
  try {
    [extraction, warningOutcome] = await Promise.all([extractionPromise, warningPromise]);
  } catch (cause) {
    // TRO-566 — the Haiku call itself failed (or never happened, if it
    // lost the race to the warning promise's own rejection path, which
    // resolveWarningOrDegrade already prevents by catching its own
    // errors — this branch is reached only by a genuine extraction
    // failure). No real cost was incurred; refund the reservation in
    // full.
    await settleReservationBestEffort(deps.settleBudget, budgetReservation.reservedUsd, 0);
    if (cause instanceof HaikuExtractionError) {
      return errorResponse(502, "EXTRACTION", "LabelHunter could not read this label. Take a clearer photo and try again.");
    }
    return errorResponse(503, "SERVICE", "LabelHunter could not reach the verification service. Try again.");
  }

  // TRO-533 — `warningOutcome` carries the router-facing comparator result
  // AND the bold advisory signal, kept apart on purpose (see
  // `CompareGovernmentWarningFromImageResult`'s own doc comment,
  // `../../../server/warning`). `warningResult` reaches `routeLabel` below
  // as its `warningResult` argument. `boldSignalResult` is ALSO persisted
  // in full (the transaction below) AND reaches `routeLabel` — but only as
  // its `.signal` discriminant, passed as a separate argument (TRO-569 /
  // INT-005: a `not-bold` signal degrades an otherwise-MATCH warning to
  // REVIEW; see `field-resolution.ts`'s own header comment for the rule).
  const warningResult: WarningComparatorResult | null = warningOutcome?.comparator ?? null;
  const boldSignalResult = warningOutcome?.boldSignal ?? null;

  // TRO-482 — the Haiku call above succeeded and really happened; its real
  // cost is owed regardless of what happens next in this request. Settled
  // best-effort: a failure to WRITE the ledger entry must not fail an
  // otherwise-successful verification the requester is waiting on — the
  // same "degrade, don't fail the request" posture `resolveWarningOrDegrade`
  // already uses above for a different dependency. TRO-566: settles the
  // REAL cost against the reservation taken before the call, rather than
  // recording a fresh, unguarded amount.
  const haikuUsage = usageCapture.takeLastUsage();
  await settleReservationBestEffort(deps.settleBudget, budgetReservation.reservedUsd, haikuUsage ? haikuCallCostUsd(haikuUsage) : 0);

  const application: ApplicationRecord = {
    beverageType: input.beverageType,
    brandName: input.brandName,
    classType: input.classType,
    alcoholContentPercent: input.alcoholContentPercent ?? undefined,
    netContentsValue: input.netContentsValue,
    netContentsUnit: input.netContentsUnit,
  };

  // Long edge of the image actually sent to the extractor — recomputed with
  // the same pure resize math `preprocessImage` used internally
  // (`computeResizeDimensions`), rather than re-measuring `haikuVariant`
  // with another sharp call for a number the pipeline already derived once.
  const haikuDims = computeResizeDimensions(
    { width: preprocessed.width, height: preprocessed.height },
    HAIKU_MAX_LONG_EDGE_PX,
  );

  const routerStart = performance.now();
  const result = routeLabel(
    extraction,
    application,
    deps.comparators,
    warningResult,
    {
      rejected: false,
      longEdgePx: Math.max(haikuDims.width, haikuDims.height),
    },
    // TRO-569 — the ONLY place `boldSignalResult` reaches the router:
    // just the `signal` discriminant, never the full result (ratio,
    // reason, etc. stay UI/persistence-only). See field-resolution.ts's
    // own header comment for the degrade rule this enables.
    boldSignalResult?.signal ?? null,
  );
  stageTimingsMs.router = performance.now() - routerStart;

  // Defensive: `routeLabel`'s own contract guarantees a REVIEW verdict
  // always carries a headline reason (every field-level or label-level
  // REVIEW path adds one to `reasonsPresent` before rolling up) — see
  // `precedence.ts`. Naming this invariant here, rather than trusting it
  // silently, is standing rule 13.
  if (result.labelVerdict === "REVIEW" && result.headlineReason === null) {
    throw new Error("routeLabel returned REVIEW with no headlineReason — router invariant violated");
  }

  // TRO-539: starts the "db" stage clock — see this file's header comment.
  // Covers both the label-image write below (TRO-518, saveLabelImage) and
  // the transactional writes further down, as one combined figure.
  const dbStart = performance.now();
  let saved: SavedLabelImage;
  try {
    saved = await deps.saveLabelImage(preprocessed.original, input.imageFile.name);
  } catch {
    return errorResponse(503, "SERVICE", "LabelHunter could not save this photo. Try again.");
  }

  const headlineMessage =
    result.labelVerdict === "REVIEW" && result.headlineReason
      ? `Needs review — ${buildFieldReasonText("NEEDS_REVIEW", result.headlineReason, undefined)}`
      : null;

  try {
    const body = await deps.db.transaction(async (tx) => {
      const [applicationRow] = await tx
        .insert(applications)
        .values({
          beverageType: input.beverageType,
          brandName: input.brandName,
          classType: input.classType,
          alcoholContentRaw: input.alcoholContentPercent !== null ? `${input.alcoholContentPercent}%` : null,
          abvPercent: input.alcoholContentPercent,
          netContentsRaw: `${input.netContentsValue} ${input.netContentsUnit}`,
          netContentsValue: input.netContentsValue,
          netContentsUnit: input.netContentsUnit,
        })
        .returning();

      const [labelImageRow] = await tx
        .insert(labelImages)
        .values({
          applicationId: applicationRow.id,
          storagePath: saved.storagePath,
          originalFilename: input.imageFile.name,
          widthPx: preprocessed.width,
          heightPx: preprocessed.height,
        })
        .returning();

      const [verificationRow] = await tx
        .insert(verifications)
        .values({
          applicationId: applicationRow.id,
          labelImageId: labelImageRow.id,
          verdict: result.labelVerdict,
          // Sonnet has not run in this request — see the file comment.
          // LH-014's resolver updates this once it consumes the
          // review_queue row below.
          resolutionPath: "EXTRACTOR_ONLY",
          // TRO-533 — persisted for EVERY verification, escalated or not
          // (`schema.ts`'s own comment on this column), independent of
          // what `routeLabel` did with it. TRO-569: `result.labelVerdict`
          // above WAS computed with `boldSignalResult.signal` in view (the
          // MATCH -> REVIEW degrade rule) — this column still stores the
          // full result (ratio, reason, both stroke widths), not only the
          // one field the router reads.
          boldSignal: boldSignalResult,
        })
        .returning();

      await tx.insert(fieldResults).values(
        result.fields.map((row) => ({
          verificationId: verificationRow.id,
          fieldName: ROUTER_FIELD_TO_DB_FIELD_NAME[row.field],
          extractedValue: row.labelValue,
          evidence: row.evidence,
          confidence: row.confidence,
          verdict: row.verdict,
          reason: row.reason,
        })),
      );

      if (result.labelVerdict === "REVIEW" && result.headlineReason) {
        // TRO-511 — see this file's header comment. flaggedFields/the
        // snapshot use the SAME derivation the batch EXTRACT worker already
        // uses for its own resolver_input column (resolver-snapshot.ts) —
        // deriveFlaggedFields's own contract guarantees a non-empty result
        // whenever routeLabel produced a genuine REVIEW verdict.
        const flaggedFields = deriveFlaggedFields(result);
        await tx.insert(reviewQueue).values({
          verificationId: verificationRow.id,
          reason: result.headlineReason,
          resolverInput: buildResolverInputSnapshot(extraction, result, flaggedFields),
        });
      }

      const responseFields: VerifyFieldResult[] = result.fields.map((row) => ({
        field: row.field,
        fieldLabel: FIELD_LABELS[row.field],
        verdict: row.verdict,
        labelValue: row.labelValue,
        evidence: row.evidence,
        reason: row.reason,
        reviewReason: row.reviewReason,
      }));

      const responseBody: VerifySuccessResponse = {
        applicationId: applicationRow.id,
        verificationId: verificationRow.id,
        labelVerdict: result.labelVerdict,
        headlineReason: result.headlineReason,
        headlineMessage,
        fields: responseFields,
      };
      return responseBody;
    });
    stageTimingsMs.db = performance.now() - dbStart;

    return NextResponse.json(body, {
      status: 200,
      headers: { "Server-Timing": buildServerTimingHeader(requireCompleteStageTimings(stageTimingsMs)) },
    });
  } catch {
    return errorResponse(503, "SERVICE", "LabelHunter could not save this verification. Try again.");
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleVerifyRequest(request);
}
