/**
 * `POST /api/extract` (TRO-576) — reads a label photo with the Haiku
 * extractor and returns a form-shaped prefill for the verify screen.
 *
 * This endpoint exists for one flow: the agent picks a photo, the form
 * fills itself with what the label already says, the agent confirms or
 * corrects, and the unchanged `/api/verify` runs the real comparison.
 * Sarah's own words name the pain this removes: "My agents spend half
 * their day doing what's essentially data entry verification"
 * (source-TH.md).
 *
 * What this endpoint deliberately does NOT do:
 * - No comparison, no verdicts — `/api/verify` owns those.
 * - No persistence. Nothing is written to the database; the application
 *   record is created only when the agent actually verifies.
 * - No Sonnet, ever. Haiku extracts; the cascade is the architecture
 *   (TH-R19), and an assist endpoint gets no exception.
 *
 * Cost posture (TH-R23 trade-off, documented in CHANGES.md): a verify
 * that used this assist spends two Haiku calls (extract, then verify's
 * own). Reusing the extraction server-side needs a draft lifecycle and a
 * schema migration — future work, not this ticket. The same rate-limit
 * and daily-budget guards as `/api/verify` run FIRST, and every real
 * Haiku call's measured cost is recorded to the same ledger.
 */
import { NextResponse } from "next/server";
import { db as defaultDb } from "../../../lib/db";
import {
  extractLabel as defaultExtractLabel,
  getDefaultExtractorClient,
  HaikuExtractionError,
  type ExtractLabelOptions,
  type HaikuExtractionResult,
  type PreprocessedLabelImage,
} from "../../../server/extractor";
import {
  preprocessImage as defaultPreprocessImage,
  PreprocessingError,
  type PreprocessedImage,
} from "../../../server/preprocessing";
import { checkVerifyRateLimit, type RateLimitCheckResult } from "../../../server/rate-limit/instances";
import { checkDailyBudget, recordSpendUsd, BUDGET_EXHAUSTED_MESSAGE, type BudgetStatus } from "../../../server/budget/daily-budget";
import { haikuCallCostUsd, wrapAnthropicClientForUsageCapture } from "../../../server/budget/anthropic-usage";
import { parseExtractFormData } from "./parse-request";
import { mapExtractionToPrefill } from "./prefill";
import type { ExtractErrorKind, ExtractErrorResponse } from "./types";

export interface ExtractRouteDeps {
  preprocessImage: (upload: Buffer) => Promise<PreprocessedImage>;
  extractLabel: (image: PreprocessedLabelImage, options?: ExtractLabelOptions) => Promise<HaikuExtractionResult>;
  /** Same optional/always-allow default shape as the verify route's own
   * guards — see `../verify/route.ts`'s field comments for the rationale;
   * production wires the same shared singletons. */
  checkRateLimit?: (request: Request) => RateLimitCheckResult;
  checkBudget?: () => Promise<BudgetStatus>;
  recordSpend?: (usd: number) => Promise<void>;
  /** Threaded into `extractLabel`'s `options.client`. See the verify
   * route's `defaultDeps.anthropicClient` comment (TRO-482): without this
   * binding, usage capture reads nothing and the budget never fills. */
  anthropicClient?: ExtractLabelOptions["client"];
}

/** Production wiring, exported so tests can run the real object and prove
 * each guard is bound — the same discipline `../verify/route.ts` adopted
 * after TRO-482's unbound-client defect. */
export const defaultDeps: ExtractRouteDeps = {
  preprocessImage: defaultPreprocessImage,
  extractLabel: defaultExtractLabel,
  checkRateLimit: checkVerifyRateLimit,
  checkBudget: () => checkDailyBudget(defaultDb),
  recordSpend: (usd) => recordSpendUsd(usd, defaultDb),
  get anthropicClient(): ExtractLabelOptions["client"] {
    return getDefaultExtractorClient();
  },
};

const ALLOW_ALL_RATE_LIMIT: RateLimitCheckResult = { allowed: true, message: "" };
const ALLOW_ALL_BUDGET: BudgetStatus = { exhausted: false, spentUsd: 0, budgetUsd: 0 };
async function noopRecordSpend(): Promise<void> {}

function errorResponse(status: number, kind: ExtractErrorKind, message: string): NextResponse<ExtractErrorResponse> {
  return NextResponse.json({ error: { kind, message } }, { status });
}

export async function handleExtractRequest(request: Request, deps: ExtractRouteDeps = defaultDeps): Promise<Response> {
  // Guards first, before any expensive work — same order and reasoning as
  // the verify route: rate limit (in-memory) then budget (one DB read).
  const rateLimitResult = (deps.checkRateLimit ?? (() => ALLOW_ALL_RATE_LIMIT))(request);
  if (!rateLimitResult.allowed) {
    return errorResponse(429, "RATE_LIMITED", rateLimitResult.message);
  }

  const budgetStatus = await (deps.checkBudget ?? (async () => ALLOW_ALL_BUDGET))();
  if (budgetStatus.exhausted) {
    return errorResponse(503, "BUDGET_EXHAUSTED", BUDGET_EXHAUSTED_MESSAGE);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(400, "VALIDATION", "LabelHunter could not read this submission. Try again.");
  }

  const parsed = parseExtractFormData(formData);
  if (!parsed.ok) {
    return errorResponse(400, "VALIDATION", parsed.message);
  }
  const imageBytes = Buffer.from(await parsed.imageFile.arrayBuffer());

  let preprocessed: PreprocessedImage;
  try {
    preprocessed = await deps.preprocessImage(imageBytes);
  } catch (cause) {
    if (cause instanceof PreprocessingError) {
      return errorResponse(422, "IMAGE", cause.message);
    }
    return errorResponse(503, "SERVICE", "LabelHunter could not process this photo. Try again.");
  }

  const extractorImage: PreprocessedLabelImage = {
    data: preprocessed.haikuVariant.toString("base64"),
    mediaType: preprocessed.mediaType,
  };

  const usageCapture = wrapAnthropicClientForUsageCapture(deps.anthropicClient);
  let extraction: HaikuExtractionResult;
  try {
    extraction = await deps.extractLabel(extractorImage, { client: usageCapture.client });
  } catch (cause) {
    if (cause instanceof HaikuExtractionError) {
      return errorResponse(502, "EXTRACTION", "LabelHunter could not read this label. You can fill in the fields yourself.");
    }
    return errorResponse(503, "SERVICE", "LabelHunter could not reach the extraction service. You can fill in the fields yourself.");
  }

  // The Haiku call happened; its real cost is owed regardless of what the
  // mapping below returns. Best-effort, same posture as the verify route:
  // a ledger-write failure never fails the request the agent is waiting on.
  const haikuUsage = usageCapture.takeLastUsage();
  if (haikuUsage) {
    try {
      await (deps.recordSpend ?? noopRecordSpend)(haikuCallCostUsd(haikuUsage));
    } catch (cause) {
      console.error("Could not record spend for a Haiku extract-assist call", cause);
    }
  }

  return NextResponse.json(mapExtractionToPrefill(extraction), { status: 200 });
}

export async function POST(request: Request): Promise<Response> {
  return handleExtractRequest(request);
}
