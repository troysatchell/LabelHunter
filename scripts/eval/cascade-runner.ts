/**
 * Runs one golden-set case through the real cascade and scores it (LH-030 /
 * TRO-470). Shared by `check.ts` (the regression gate) and `benchmark.ts`
 * (the cascade-vs-Sonnet-only benchmark's cascade arm) so the two scripts
 * cannot silently drift on what "run the real cascade" means.
 *
 * DI capture, not a second API call: `deps.extractLabel`, `deps.preprocessImage`,
 * and `deps.compareGovernmentWarning` below each wrap the real
 * implementation, capturing its result as a side effect before returning it
 * unchanged to `handleVerifyRequest` — the exact same values the response
 * body was built from, not a second, possibly-different re-run. Two
 * separate usage-capturing clients (`usage.ts`) cover the Haiku call and
 * the resolver call — one client, one call, ever, so there is no shared
 * mutable state two calls could race on (see `usage.ts`'s own module
 * comment for the finding this fixes). `routeLabel` IS called a second
 * time, deliberately: it is pure and deterministic (no I/O, no model call
 * — `src/server/router/index.ts`'s own doc comment), so calling it again
 * with the exact captured inputs `handleVerifyRequest` used internally
 * reproduces its result byte-for-byte, and doing so is the only way to get
 * the escalated case's real `LabelRouterResult` — needed for the
 * resolver's own input contract — without a synthetic, placeholder-filled
 * stand-in. A consistency assertion below confirms the re-derived result
 * agrees with the response body's own verdict.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../src/lib/db/schema";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import { handleVerifyRequest, type VerifyRouteDeps } from "../../src/app/api/verify/route";
import { extractLabel as defaultExtractLabel, HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor";
import type { HaikuExtractionResult } from "../../src/server/extractor/types";
import {
  computeResizeDimensions,
  HAIKU_MAX_LONG_EDGE_PX,
  preprocessImage as defaultPreprocessImage,
  type PreprocessedImage,
} from "../../src/server/preprocessing";
import { productionComparators } from "../../src/server/comparators";
import { pickHeadlineReason, routeLabel, rollupLabelVerdict } from "../../src/server/router";
import type {
  ApplicationRecord as RouterApplicationRecord,
  FieldComparators,
  LabelRouterResult,
  ReviewReason,
  WarningComparatorChannel,
  WarningComparatorResult,
} from "../../src/server/router/types";
import { resolveEscalatedLabel, SONNET_RESOLVER_MODEL } from "../../src/server/resolver";
import type { ResolverResolution } from "../../src/server/resolver";
import { compareGovernmentWarningFromImage as defaultCompareGovernmentWarning } from "../../src/server/warning";
import { saveLabelImage as defaultSaveLabelImage } from "../../src/server/storage/db-image-storage";
import { buildFlaggedFieldsForEscalatedLabel } from "./flagged-fields";
import { scoreExtraction } from "./extraction-scoring";
import { parseFullVerifySuccessBody } from "./response-validation";
import { rollUpOneField } from "./resolver-rollup";
import { ROUTER_FIELD_KEYS } from "./types";
import { buildMeasuredCost, createUsageCapturingClient, HAIKU_4_5_PRICING, selectSonnetPricing } from "./usage";
import { scoreVerdict, type ActualFieldOutcome, type ActualVerdict } from "./verdict-scoring";
import type { CascadeCaseResult, EvalCaseFailure } from "./types";
import type { FullVerifyFieldResult } from "./response-validation";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * No SDK-level retry on the clients this file constructs for DI — the
 * SAME choice `src/server/extractor/index.ts` and `src/server/resolver/index.ts`
 * make on their own default clients (`DEFAULT_CLIENT_MAX_RETRIES = 0`,
 * both with the same reasoning). A harness client without this override
 * would silently retry on the SDK's own default policy instead, meaning a
 * "one real call" measurement could quietly become two or three real
 * calls, at a cost and a call-count neither this file's own accounting nor
 * the real production client would produce (a PR review finding).
 */
const DI_CLIENT_OPTIONS = { maxRetries: 0 } as const;

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

function mediaTypeForImagePath(imagePath: string): string {
  const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
  const mediaType = EXTENSION_TO_MEDIA_TYPE[ext];
  if (!mediaType) {
    throw new Error(`cascade-runner.ts: no known media type for image extension ".${ext}" (${imagePath})`);
  }
  return mediaType;
}

/** Same shape `route.test.ts`'s `buildFormData` and
 * `scripts/latency/measure.ts`'s `buildRequest` use — this file's own copy
 * rather than an import, since neither of those functions is exported and
 * this ticket does not touch either file (out of scope). */
function buildVerifyRequest(imageBytes: Buffer, imagePath: string, mediaType: string, caseSpec: GoldenSetCase): Request {
  const fd = new FormData();
  const file = new File([imageBytes as unknown as BlobPart], path.basename(imagePath), { type: mediaType });
  fd.set("image", file);
  fd.set("beverageType", caseSpec.beverageType);
  fd.set("brandName", caseSpec.application.brandName);
  fd.set("classType", caseSpec.application.classType);
  if (caseSpec.application.abvPercent !== undefined) {
    fd.set("alcoholContentPercent", String(caseSpec.application.abvPercent));
  }
  fd.set("netContentsValue", String(caseSpec.application.netContentsValue));
  fd.set("netContentsUnit", caseSpec.application.netContentsUnit);
  return new Request("http://localhost/api/verify", { method: "POST", body: fd });
}

/** Builds the router's `ApplicationRecord` from a golden-set case — the
 * same field mapping for every caller in this ticket
 * (`benchmark.ts`'s Sonnet-only arm needs the identical record). */
export function buildApplicationRecord(caseSpec: GoldenSetCase): RouterApplicationRecord {
  return {
    beverageType: caseSpec.beverageType,
    brandName: caseSpec.application.brandName,
    classType: caseSpec.application.classType,
    alcoholContentPercent: caseSpec.application.abvPercent,
    netContentsValue: caseSpec.application.netContentsValue,
    netContentsUnit: caseSpec.application.netContentsUnit,
  };
}

/**
 * Reads `applicationId` out of an UNVALIDATED response body, for
 * best-effort cleanup only — never for scoring. Used on the one path
 * where `parseFullVerifySuccessBody` has already rejected the body (so
 * nothing about its shape is trusted) but a real `applications` row may
 * still have been created and deserves a cleanup attempt. Mirrors
 * `scripts/latency/measure.ts`'s own documented choice on the identical
 * question (its "200 response body did not match" comment): a malformed
 * body's `applicationId` is inherently best-effort, never a second,
 * redundant identity channel — this just widens "best-effort" from "give
 * up" to "try the one field that's cheap to check," it does not add a new
 * trust boundary.
 */
function extractApplicationIdBestEffort(rawBody: unknown): number | null {
  if (!rawBody || typeof rawBody !== "object") return null;
  const candidate = (rawBody as Record<string, unknown>).applicationId;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
}

async function cleanupApplicationRow(
  db: ReturnType<typeof drizzle<typeof schema>>,
  applicationId: number | null,
  caseId: string,
): Promise<void> {
  if (applicationId === null) return;
  // Same "delete every application row this script creates" discipline as
  // scripts/latency/measure.ts — best-effort; a delete failure is a
  // housekeeping problem, not a reason to lose an already-computed score.
  try {
    await db.delete(schema.applications).where(eq(schema.applications.id, applicationId));
  } catch (cleanupError) {
    console.warn(
      `cascade-runner.ts: cleanup of application ${applicationId} (case "${caseId}") failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
}

/**
 * Converts one real `/api/verify` response field row into `ActualVerdict`'s
 * discriminated-union shape (TRO-469 / LH-021, PRD §3.7's warning
 * segmentation needs each field's own `reviewReason`, not just its
 * verdict — see `verdict-scoring.ts`'s `ActualFieldOutcome`). A `NEEDS_REVIEW`
 * row's `reviewReason` CAN be `null` here — `ActualFieldOutcome`'s own doc
 * comment explains the real, deliberate router path that produces it
 * (an absent required field a label-level `LOW_IMAGE_QUALITY` blocker
 * already explains) — so this is a straight passthrough, not a narrowing
 * that could fail.
 */
function toActualFieldOutcome(f: FullVerifyFieldResult): ActualFieldOutcome {
  if (f.verdict !== "NEEDS_REVIEW") return { field: f.field, verdict: f.verdict };
  return { field: f.field, verdict: "NEEDS_REVIEW", reviewReason: f.reviewReason };
}

/**
 * Merges a resolver resolution into the router's own field rows, producing
 * the cascade's END STATE verdict (TRO-538 / LH-033). A resolved field
 * OVERRIDES its router row; a router row the resolver did NOT flag carries
 * through unchanged — `buildFlaggedFieldsForEscalatedLabel` flags a
 * per-field subset for a field-specific reason, or every field for a
 * label-level blocker (that function's own doc comment), so either shape is
 * a normal input here, not a special case this function has to detect.
 *
 * Reuses `resolver-rollup.ts`'s own per-disposition mapping
 * (`rollUpOneField` — judged fields: the resolver's disposition IS the
 * verdict, TH-R8; correction fields: the resolver's reading re-runs the
 * SAME deterministic comparator, CP-1 §6.5) and the router's own
 * `rollupLabelVerdict`/`pickHeadlineReason`, so this arm's rollup rule
 * cannot drift from either the Sonnet-only arm's or the router's own.
 *
 * OPEN DESIGN QUESTION, decided here, flagged for Troy to confirm (see the
 * TRO-538 PR body's "Open design question" section): this function ALWAYS
 * rolls up with `labelLevelBlocker: false` — it never reads
 * `routerResult.labelVerdict` or `.headlineReason` at all, only `.fields`.
 * The router's own LOW_IMAGE_QUALITY/CONFLICTING_EXTRACTION blocker
 * therefore never survives into the cascade end state. Rationale: a
 * label-level blocker's whole justification is "the fields under it are
 * not trustworthy" — and `buildFlaggedFieldsForEscalatedLabel` already
 * guarantees that whenever the blocker fired with no field individually
 * carrying its own reason (the common shape), EVERY field gets sent to
 * Sonnet, so the distrust the blocker asserted has been independently
 * checked, not merely repeated. This is the same choice
 * `resolver-rollup.ts`'s Sonnet-only arm already makes (there: because that
 * arm has no router pass to take a blocker FROM at all).
 *
 * HONEST LIMIT: `buildFlaggedFieldsForEscalatedLabel` flags a PARTIAL field
 * set whenever at least one field already carries its OWN reviewReason —
 * reachable even alongside a label-level blocker (e.g. one field's own
 * override rejection sets CONFLICTING_EXTRACTION on that field AND the
 * label, while an unrelated field's clean MATCH never gets a second Sonnet
 * look). On that path, "blocker dropped" does not mean "every field was
 * independently re-verified" — only that every FLAGGED field was; an
 * un-flagged field still carries the router's own, blocker-era verdict into
 * this merged result. This is a real, unresolved gap in the evidence, not a
 * design choice — see the PR body.
 *
 * A SECOND HONEST LIMIT, specific to `government_warning`: `rollUpOneField`
 * dispatches a resolved warning through `rollUpGovernmentWarning`, which —
 * exactly like the Sonnet-only arm — has no OCR channel to corroborate a
 * deviation with, so it can only ever return MATCH or NEEDS_REVIEW, never
 * MISMATCH (`resolver-rollup.ts`'s own doc comment). A router-level warning
 * MISMATCH that gets swept into a label-level "flag all five" resolver call
 * therefore cannot survive into the cascade end state as a MISMATCH — it
 * downgrades to NEEDS_REVIEW / WARNING_MISMATCH, an honest reason in place
 * of a suppressed one, not the router's original, dual-channel-corroborated
 * verdict. See this file's own test suite (`cascade-runner.test.ts`) for a
 * worked example.
 *
 * `routerWarningChannel` (TRO-535 / TRO-538 merge-integration fix, found
 * resolving the two tickets' overlapping diffs — neither ticket's own test
 * suite could have caught this alone, since the gap only exists once both
 * land together): the router's own channel provenance for
 * `government_warning` (`extractWarningChannel`'s return value at the real
 * call site). Threaded through to the merged `ActualVerdict.warningChannel`
 * ONLY when `government_warning` was NOT itself a resolved field — a
 * resolved warning has no channel of its own (the second honest limit
 * above), so the merge reports `null` there rather than the stale,
 * misleading router-stage value. Without this parameter, EVERY cascade
 * end-state verdict would silently report `warningChannel: null`, even on
 * the common case where an unrelated field escalated and government_warning
 * simply passed through the router unchanged with a perfectly good known
 * channel.
 */
export function mergeResolutionIntoActualVerdict(
  routerResult: LabelRouterResult,
  resolution: ResolverResolution,
  application: RouterApplicationRecord,
  comparators: FieldComparators,
  routerWarningChannel: WarningComparatorChannel | null,
): ActualVerdict {
  const routerByField = new Map(routerResult.fields.map((row) => [row.field, row]));
  const resolvedByField = new Map(resolution.fields.map((field) => [field.field, field]));
  if (resolvedByField.size !== resolution.fields.length) {
    throw new Error(
      `mergeResolutionIntoActualVerdict: resolution.fields has ${resolution.fields.length} entries but only ${resolvedByField.size} distinct fields — a duplicate field disposition from the resolver (Sonnet's own response) is a harness-visible bug, not silently resolved by "whichever entry the Map kept last." Same guard verdict-scoring.ts's scoreVerdict already applies to actual.fields.`,
    );
  }

  const reasons = new Set<ReviewReason>();
  const fields: ActualVerdict["fields"] = ROUTER_FIELD_KEYS.map((field) => {
    const resolved = resolvedByField.get(field);
    if (resolved) {
      const { verdict, reviewReason } = rollUpOneField(resolved, application, comparators);
      if (reviewReason) reasons.add(reviewReason);
      return verdict === "NEEDS_REVIEW" ? { field, verdict, reviewReason } : { field, verdict };
    }
    const row = routerByField.get(field);
    if (!row) {
      throw new Error(
        `mergeResolutionIntoActualVerdict: router result has no row for field "${field}" — router invariant violated (routeLabel always returns all five rows).`,
      );
    }
    const verdict = row.verdict;
    if (row.reviewReason) reasons.add(row.reviewReason);
    return verdict === "NEEDS_REVIEW" ? { field, verdict, reviewReason: row.reviewReason } : { field, verdict };
  });

  const labelVerdict = rollupLabelVerdict(false, fields.map((f) => f.verdict));
  const warningChannel = resolvedByField.has("government_warning") ? null : routerWarningChannel;
  // TRO-542: `lowImageQualityTrigger: null`, always — this function's own
  // `labelLevelBlocker: false` choice above (see the OPEN DESIGN QUESTION
  // doc comment) already means the router's LOW_IMAGE_QUALITY blocker does
  // not survive into the cascade end state; the trigger that named WHICH
  // rule produced that blocker cannot survive it either.
  return { labelVerdict, headlineReason: pickHeadlineReason(reasons), fields, warningChannel, lowImageQualityTrigger: null };
}

/**
 * Reads `channel` off a possibly-`null` `WarningComparatorResult` (TRO-535 /
 * LH-030b). A plain function, not an inline `capturedWarningResult?.channel
 * ?? null` at the call site — TypeScript's control-flow analysis
 * over-narrows a `let` variable that a nested closure
 * (`deps.compareGovernmentWarning` below) reassigns: read directly, its
 * type collapses to `never` at any later property access, even though the
 * real runtime value is exactly what the closure assigned (a known
 * TypeScript limitation, not a bug in the captured value itself). Passing
 * the variable as an argument gives it a fresh type binding from this
 * function's own parameter annotation, which resets that over-narrowing.
 */
function extractWarningChannel(result: WarningComparatorResult | null): WarningComparatorChannel | null {
  return result?.channel ?? null;
}

export interface CaseRunOutcome {
  result: CascadeCaseResult | null;
  failure: EvalCaseFailure | null;
  /** The real Haiku extraction this case's cascade run captured, or `null`
   * on a failed run. Exposed so `benchmark.ts`'s Sonnet-only arm can reuse
   * the SAME extraction (and `rawPreprocessed` below) instead of paying for
   * a second Haiku call and a second preprocessing pass for the identical
   * image — holding Haiku's reading constant between the two arms is also
   * what makes the benchmark's comparison isolate the one variable PRD §4
   * actually asks about (selective vs. universal Sonnet judgment), not a
   * second source of noise from two independent Haiku calls. `check.ts`
   * never reads this field — the committed report stores scores, not raw
   * extractions. */
  rawExtraction: HaikuExtractionResult | null;
  rawPreprocessed: PreprocessedImage | null;
}

/** Runs one golden-set case through the real cascade and scores it — see
 * this file's module comment for the DI-capture design. */
export async function runOneCase(
  caseSpec: GoldenSetCase,
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<CaseRunOutcome> {
  const imagePath = caseSpec.imagePath;
  const mediaType = mediaTypeForImagePath(imagePath);
  const imageBytes = readFileSync(path.resolve(REPO_ROOT, imagePath));

  let capturedExtraction: HaikuExtractionResult | undefined;
  let capturedPreprocessed: PreprocessedImage | undefined;
  let capturedWarningResult: WarningComparatorResult | null = null;
  let haikuUsage: Anthropic.Usage | null = null;

  // One dedicated client per logical call (usage.ts's own requirement) —
  // the Haiku call and the resolver call never share one client instance.
  const haikuUsageCapture = createUsageCapturingClient(new Anthropic(DI_CLIENT_OPTIONS));

  const deps: VerifyRouteDeps = {
    db,
    preprocessImage: async (bytes) => {
      const result = await defaultPreprocessImage(bytes);
      capturedPreprocessed = result;
      return result;
    },
    extractLabel: async (image, options) => {
      const result = await defaultExtractLabel(image, options);
      capturedExtraction = result;
      haikuUsage = haikuUsageCapture.takeLastUsage();
      return result;
    },
    compareGovernmentWarning: async (input) => {
      try {
        const result = await defaultCompareGovernmentWarning(input);
        capturedWarningResult = result;
        return result;
      } catch (cause) {
        capturedWarningResult = null;
        throw cause; // route.ts's own resolveWarningOrDegrade catches this — matches production exactly.
      }
    },
    // TRO-518: writes through the SAME `db` connection this script already
    // opened for its own queries, not a scratch directory — there is no
    // longer a filesystem detail to isolate a test/eval run from.
    saveLabelImage: (bytes, originalFilename) => defaultSaveLabelImage(bytes, originalFilename, { db }),
    comparators: productionComparators,
    anthropicClient: haikuUsageCapture.client,
  };

  const request = buildVerifyRequest(imageBytes, imagePath, mediaType, caseSpec);
  let response: Response;
  try {
    response = await handleVerifyRequest(request, deps);
  } catch (cause) {
    return {
      result: null,
      failure: { caseId: caseSpec.caseId, error: cause instanceof Error ? cause.message : String(cause) },
      rawExtraction: capturedExtraction ?? null,
      rawPreprocessed: capturedPreprocessed ?? null,
    };
  }

  const rawBody: unknown = await response.json().catch(() => null);
  if (response.status !== 200) {
    const message =
      rawBody && typeof rawBody === "object" && "error" in rawBody
        ? JSON.stringify((rawBody as { error: unknown }).error)
        : `HTTP ${response.status}`;
    return {
      result: null,
      failure: { caseId: caseSpec.caseId, error: message },
      rawExtraction: capturedExtraction ?? null,
      rawPreprocessed: capturedPreprocessed ?? null,
    };
  }
  const body = parseFullVerifySuccessBody(rawBody);
  if (!body) {
    // The body's shape is not trusted past this point — but a real
    // `applications` row may still exist, so a best-effort cleanup by ID
    // is still worth attempting (see extractApplicationIdBestEffort's own
    // doc comment).
    await cleanupApplicationRow(db, extractApplicationIdBestEffort(rawBody), caseSpec.caseId);
    return {
      result: null,
      failure: { caseId: caseSpec.caseId, error: "cascade-runner.ts: 200 response body did not match the expected shape" },
      rawExtraction: capturedExtraction ?? null,
      rawPreprocessed: capturedPreprocessed ?? null,
    };
  }
  if (!capturedExtraction || !capturedPreprocessed || !haikuUsage) {
    // Defensive: handleVerifyRequest returned 200, which is only reachable
    // after deps.extractLabel and deps.preprocessImage both resolved.
    throw new Error(
      `cascade-runner.ts: case "${caseSpec.caseId}" returned 200 but the harness's own capture hooks did not fire — harness bug, not a case result.`,
    );
  }

  try {
    const application = buildApplicationRecord(caseSpec);
    const haikuDims = computeResizeDimensions({ width: capturedPreprocessed.width, height: capturedPreprocessed.height }, HAIKU_MAX_LONG_EDGE_PX);
    const routerResult: LabelRouterResult = routeLabel(capturedExtraction, application, productionComparators, capturedWarningResult, {
      rejected: false,
      longEdgePx: Math.max(haikuDims.width, haikuDims.height),
    });
    if (routerResult.labelVerdict !== body.labelVerdict) {
      throw new Error(
        `cascade-runner.ts: case "${caseSpec.caseId}" — re-derived router verdict "${routerResult.labelVerdict}" disagrees with the response body's "${body.labelVerdict}". ` +
          "routeLabel is pure and deterministic; this means the harness captured different inputs than route.ts actually used — a harness bug, not a case result.",
      );
    }
    // TRO-542 (CodeRabbit finding): the same consistency check, on
    // `headlineReason` — `actualVerdict` below reports `body.headlineReason`
    // (the trusted, real HTTP response) but `lowImageQualityTrigger` from
    // `routerResult` (the re-derived value, the only place a trigger exists
    // at all). `labelVerdict` agreeing does not, by itself, prove
    // `headlineReason` agrees too — two different reasons can both roll up
    // to REVIEW. Catch that gap here, before it can pair a body-sourced
    // headline with a routerResult-sourced trigger that names a different
    // run's decision.
    if (routerResult.headlineReason !== body.headlineReason) {
      throw new Error(
        `cascade-runner.ts: case "${caseSpec.caseId}" — re-derived router headlineReason "${routerResult.headlineReason}" disagrees with the response body's "${body.headlineReason}". ` +
          "routeLabel is pure and deterministic; this means the harness captured different inputs than route.ts actually used — a harness bug, not a case result.",
      );
    }

    const extractionScore = scoreExtraction(caseSpec, capturedExtraction);
    const actualVerdict: ActualVerdict = {
      labelVerdict: body.labelVerdict,
      headlineReason: body.headlineReason,
      fields: body.fields.map(toActualFieldOutcome),
      // TRO-535 / LH-030b: `capturedWarningResult` (captured above, at the
      // `deps.compareGovernmentWarning` DI hook) is the ONLY place this
      // harness can still see which reconciliation table decided the
      // government_warning verdict — by the time `body.fields` (the HTTP
      // response) is built, `routeLabel` has already turned it into a
      // `FieldResultRow` that carries no channel of its own.
      warningChannel: extractWarningChannel(capturedWarningResult),
      // TRO-542: `body` (the HTTP response) carries no trigger field of its
      // own — read it straight off `routerResult`, the re-derived
      // `LabelRouterResult` this function already verified agrees with both
      // `body.labelVerdict` and `body.headlineReason` above.
      lowImageQualityTrigger: routerResult.lowImageQualityTrigger,
    };
    const routerVerdictScore = scoreVerdict(caseSpec, actualVerdict, capturedExtraction);
    const haikuCost = buildMeasuredCost(HAIKU_EXTRACTOR_MODEL, haikuUsage, HAIKU_4_5_PRICING);

    let resolverCost: CascadeCaseResult["resolverCost"] = null;
    let resolverOutcome: CascadeCaseResult["resolverOutcome"] = null;
    let resolverDurationMs: CascadeCaseResult["resolverDurationMs"] = null;
    let resolverError: CascadeCaseResult["resolverError"] = null;
    // Hoisted to this scope (TRO-538 / LH-033), not declared inside the
    // `if` block below: `mergeResolutionIntoActualVerdict` needs the full
    // resolution object AFTER that block ends, to build the cascade's
    // post-resolution end-state verdict — not just `resolution.outcome`,
    // which is all the pre-existing code below ever read.
    let resolution: ResolverResolution | null = null;
    if (routerResult.labelVerdict === "REVIEW") {
      // handleVerifyRequest's own transaction already inserted a
      // review_queue row for this verification (route.ts: "if
      // result.labelVerdict === REVIEW ... await tx.insert(reviewQueue)")
      // — resolverOutput: null, the real production shape, since route.ts
      // never resolves it inline (TH-R19). resolveEscalatedLabel's own
      // duplicate-call guard (findExistingReviewQueueEntry) sees that row,
      // cannot tell "genuinely already resolved" apart from "a bare
      // placeholder no pipeline has consumed yet" (there is no pipeline —
      // LH-015/LH-016 have not merged), and correctly refuses to guess.
      // This harness is the resolver's first real caller; deleting the
      // placeholder first (never produced by any code this ticket owns —
      // it is real route.ts behavior this harness must accommodate, not
      // route.ts's own bug) lets insertReviewQueueEntry write the real,
      // complete row cleanly, matching what a real consumer pipeline would
      // eventually need to do here too.
      await db.delete(schema.reviewQueue).where(eq(schema.reviewQueue.verificationId, body.verificationId));

      // A resolver-call failure (a transient API error, most likely — this
      // harness is a real, live caller of a real, paid endpoint) must not
      // take down the whole sweep and lose every already-computed,
      // already-paid-for case before it (a PR review finding). Extraction
      // and verdict scores above are already computed and stay valid
      // either way; only the resolver evidence for THIS case is missing.
      // The catch below is scoped to the remote call alone — the
      // "usage must exist after a successful call" check right after it
      // stays an uncaught, deliberate harness-bug throw, same as the other
      // defensive throws in this function; a bug in THIS harness's own
      // capture code is not a remote failure to record and move past.
      const resolverUsageCapture = createUsageCapturingClient(new Anthropic(DI_CLIENT_OPTIONS));
      const flaggedFields = buildFlaggedFieldsForEscalatedLabel(routerResult);
      const resolverStart = Date.now();
      try {
        resolution = await resolveEscalatedLabel(
          {
            verificationId: body.verificationId,
            image: { data: capturedPreprocessed.sonnetVariant.toString("base64"), mediaType: capturedPreprocessed.mediaType },
            extraction: capturedExtraction,
            application,
            router: routerResult,
            flaggedFields,
          },
          { client: resolverUsageCapture.client, db },
        );
      } catch (cause) {
        resolverError = cause instanceof Error ? cause.message : String(cause);
        console.warn(`cascade-runner.ts: case "${caseSpec.caseId}" — resolver call failed: ${resolverError}`);
      }
      if (resolution) {
        resolverDurationMs = Date.now() - resolverStart;
        const sonnetUsage = resolverUsageCapture.takeLastUsage();
        if (!sonnetUsage) {
          throw new Error(`cascade-runner.ts: case "${caseSpec.caseId}" — resolver call completed but no usage was captured — harness bug.`);
        }
        resolverCost = buildMeasuredCost(SONNET_RESOLVER_MODEL, sonnetUsage, selectSonnetPricing(new Date()));
        resolverOutcome = resolution.outcome;
      }
    }

    // The cascade's END STATE (TRO-538 / LH-033): identical to the router's
    // own verdict when nothing escalated (nothing to merge) — a real
    // resolver call, even a failed one, is the only thing that can move
    // this away from `routerVerdictScore`. `resolverError` deliberately
    // does NOT gate this: a failed resolver call leaves `resolution` `null`,
    // so the `: routerVerdictScore` branch below already runs — the cascade
    // end state honestly falls back to "whatever the router alone decided"
    // when Sonnet's own evidence is missing, the same "uncertain beats
    // wrong" posture as every other stage in this pipeline.
    const cascadeVerdictScore = resolution
      ? scoreVerdict(
          caseSpec,
          mergeResolutionIntoActualVerdict(
            routerResult,
            resolution,
            application,
            productionComparators,
            extractWarningChannel(capturedWarningResult),
          ),
          capturedExtraction,
        )
      : routerVerdictScore;

    return {
      result: {
        caseId: caseSpec.caseId,
        category: caseSpec.category,
        extraction: extractionScore,
        routerVerdict: routerVerdictScore,
        cascadeVerdict: cascadeVerdictScore,
        haikuCost,
        resolverCost,
        resolverOutcome,
        resolverError,
        resolverDurationMs,
        imageQuality: capturedExtraction.image_quality,
        beverageType: {
          value: capturedExtraction.beverage_type.value,
          evidence: capturedExtraction.beverage_type.evidence,
          confidence: capturedExtraction.beverage_type.confidence,
        },
      },
      failure: null,
      rawExtraction: capturedExtraction,
      rawPreprocessed: capturedPreprocessed,
    };
  } finally {
    await cleanupApplicationRow(db, body.applicationId, caseSpec.caseId);
  }
}
