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
 * body was built from, not a second, possibly-different re-run. `deps.anthropicClient`
 * is a usage-capturing client (`usage.ts`) so the real Haiku call's token
 * usage is available too, with no second call. `routeLabel` IS called a
 * second time, deliberately: it is pure and deterministic (no I/O, no model
 * call — `src/server/router/index.ts`'s own doc comment), so calling it
 * again with the exact captured inputs `handleVerifyRequest` used
 * internally reproduces its result byte-for-byte, and doing so is the only
 * way to get the escalated case's real `LabelRouterResult` — needed for the
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
import { routeLabel } from "../../src/server/router";
import type { ApplicationRecord as RouterApplicationRecord, LabelRouterResult, WarningComparatorResult } from "../../src/server/router/types";
import { resolveEscalatedLabel, SONNET_RESOLVER_MODEL } from "../../src/server/resolver";
import { compareGovernmentWarningFromImage as defaultCompareGovernmentWarning } from "../../src/server/warning";
import { saveLabelImage as defaultSaveLabelImage } from "../../src/server/storage/local-file-storage";
import { buildFlaggedFieldsForEscalatedLabel } from "./flagged-fields";
import { scoreExtraction } from "./extraction-scoring";
import { parseFullVerifySuccessBody } from "./response-validation";
import { buildMeasuredCost, createUsageCapturingClient, HAIKU_4_5_PRICING, SONNET_5_INTRO_PRICING } from "./usage";
import { scoreVerdict, type ActualVerdict } from "./verdict-scoring";
import type { CascadeCaseResult, EvalCaseFailure } from "./types";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
  scratchDir: string,
): Promise<CaseRunOutcome> {
  const imagePath = caseSpec.imagePath;
  const mediaType = mediaTypeForImagePath(imagePath);
  const imageBytes = readFileSync(path.resolve(REPO_ROOT, imagePath));

  let capturedExtraction: HaikuExtractionResult | undefined;
  let capturedPreprocessed: PreprocessedImage | undefined;
  let capturedWarningResult: WarningComparatorResult | null = null;
  let haikuUsage: Anthropic.Usage | null = null;

  const usage = createUsageCapturingClient(new Anthropic());

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
      haikuUsage = usage.takeLastUsage();
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
    saveLabelImage: (bytes, originalFilename) => defaultSaveLabelImage(bytes, originalFilename, { baseDir: scratchDir }),
    comparators: productionComparators,
    anthropicClient: usage.client,
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

    const extractionScore = scoreExtraction(caseSpec, capturedExtraction);
    const actualVerdict: ActualVerdict = {
      labelVerdict: body.labelVerdict,
      headlineReason: body.headlineReason,
      fields: body.fields.map((f) => ({ field: f.field, verdict: f.verdict })),
    };
    const verdictScore = scoreVerdict(caseSpec, actualVerdict);
    const haikuCost = buildMeasuredCost(HAIKU_EXTRACTOR_MODEL, haikuUsage, HAIKU_4_5_PRICING);

    let resolverCost = null as CascadeCaseResult["resolverCost"];
    let resolverOutcome: CascadeCaseResult["resolverOutcome"] = null;
    let resolverDurationMs = 0;
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

      const flaggedFields = buildFlaggedFieldsForEscalatedLabel(routerResult);
      const resolverStart = Date.now();
      const resolution = await resolveEscalatedLabel(
        {
          verificationId: body.verificationId,
          image: { data: capturedPreprocessed.sonnetVariant.toString("base64"), mediaType: capturedPreprocessed.mediaType },
          extraction: capturedExtraction,
          application,
          router: routerResult,
          flaggedFields,
        },
        { client: usage.client, db },
      );
      resolverDurationMs = Date.now() - resolverStart;
      const sonnetUsage = usage.takeLastUsage();
      if (!sonnetUsage) {
        throw new Error(`cascade-runner.ts: case "${caseSpec.caseId}" — resolver call completed but no usage was captured — harness bug.`);
      }
      resolverCost = buildMeasuredCost(SONNET_RESOLVER_MODEL, sonnetUsage, SONNET_5_INTRO_PRICING);
      resolverOutcome = resolution.outcome;
    }

    return {
      result: {
        caseId: caseSpec.caseId,
        category: caseSpec.category,
        extraction: extractionScore,
        verdict: verdictScore,
        haikuCost,
        resolverCost,
        resolverOutcome,
        resolverDurationMs,
      },
      failure: null,
      rawExtraction: capturedExtraction,
      rawPreprocessed: capturedPreprocessed,
    };
  } finally {
    // Same "delete every application row this script creates" discipline as
    // scripts/latency/measure.ts — best-effort; a delete failure is a
    // housekeeping problem, not a reason to lose an already-computed score.
    try {
      await db.delete(schema.applications).where(eq(schema.applications.id, body.applicationId));
    } catch (cleanupError) {
      console.warn(
        `cascade-runner.ts: cleanup of application ${body.applicationId} (case "${caseSpec.caseId}") failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
  }
}
