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
 * **Government warning.** LH-020 (the warning subsystem, gated by CP-2)
 * has not merged either. This route passes `warningResult: null` to
 * `routeLabel` — honestly: standing rule 12 (uncertain beats wrong) means
 * a warning this route cannot actually compare must never be reported as a
 * confident match. `resolveGovernmentWarningField`
 * (`../../../server/router/field-resolution.ts`) already handles a `null`
 * result defensively: a present warning with no comparator result routes
 * to `NEEDS_REVIEW`. Until LH-020 lands, every label with a warning on it
 * needs review for that one field — expected, not a bug in this ticket.
 */
import { NextResponse } from "next/server";
import type { FieldName } from "../../../lib/db/enums";
import { db as defaultDb } from "../../../lib/db";
import { applications, fieldResults, labelImages, reviewQueue, verifications } from "../../../lib/db/schema";
import {
  extractLabel as defaultExtractLabel,
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
import { routeLabel, type ApplicationRecord, type FieldComparators, type RouterFieldKey } from "../../../server/router";
import { productionComparators } from "../../../server/comparators";
import { buildFieldReasonText } from "../../../server/router/reason-text";
import { saveLabelImage as defaultSaveLabelImage, type SavedLabelImage } from "../../../server/storage/local-file-storage";
import { parseVerifyFormData } from "./parse-request";
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
  saveLabelImage: (bytes: Buffer, originalFilename: string) => Promise<SavedLabelImage>;
  comparators: FieldComparators;
  /** Threaded into `extractLabel`'s own `options.client` — see the
   * `extractLabel` test suite's `fakeClient` pattern. `undefined` in
   * production, which makes `extractLabel` fall back to its own shared
   * default client. */
  anthropicClient?: ExtractLabelOptions["client"];
}

const defaultDeps: VerifyRouteDeps = {
  db: defaultDb,
  preprocessImage: defaultPreprocessImage,
  extractLabel: defaultExtractLabel,
  saveLabelImage: defaultSaveLabelImage,
  comparators: productionComparators,
};

function errorResponse(status: number, kind: VerifyErrorKind, message: string): NextResponse<VerifyErrorResponse> {
  return NextResponse.json({ error: { kind, message } }, { status });
}

export async function handleVerifyRequest(request: Request, deps: VerifyRouteDeps = defaultDeps): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(400, "VALIDATION", "LabelHunter could not read this submission. Try again.");
  }

  const parsed = parseVerifyFormData(formData);
  if (!parsed.ok) {
    return errorResponse(400, "VALIDATION", parsed.message);
  }
  const input = parsed.value;
  const imageBytes = Buffer.from(await input.imageFile.arrayBuffer());

  let preprocessed: PreprocessedImage;
  try {
    preprocessed = await deps.preprocessImage(imageBytes);
  } catch (cause) {
    if (cause instanceof PreprocessingError) {
      return errorResponse(422, "IMAGE", cause.message);
    }
    return errorResponse(503, "SERVICE", "LabelHunter could not process this photo. Try again.");
  }

  let extraction: HaikuExtractionResult;
  try {
    const extractorImage: PreprocessedLabelImage = {
      data: preprocessed.haikuVariant.toString("base64"),
      mediaType: preprocessed.mediaType,
    };
    extraction = await deps.extractLabel(extractorImage, { client: deps.anthropicClient });
  } catch (cause) {
    if (cause instanceof HaikuExtractionError) {
      return errorResponse(502, "EXTRACTION", "LabelHunter could not read this label. Take a clearer photo and try again.");
    }
    return errorResponse(503, "SERVICE", "LabelHunter could not reach the verification service. Try again.");
  }

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

  // No warning comparator yet (LH-020) — pass `null`, not a fabricated
  // match. See the file comment.
  const result = routeLabel(extraction, application, deps.comparators, null, {
    rejected: false,
    longEdgePx: Math.max(haikuDims.width, haikuDims.height),
  });

  // Defensive: `routeLabel`'s own contract guarantees a REVIEW verdict
  // always carries a headline reason (every field-level or label-level
  // REVIEW path adds one to `reasonsPresent` before rolling up) — see
  // `precedence.ts`. Naming this invariant here, rather than trusting it
  // silently, is standing rule 13.
  if (result.labelVerdict === "REVIEW" && result.headlineReason === null) {
    throw new Error("routeLabel returned REVIEW with no headlineReason — router invariant violated");
  }

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
        await tx.insert(reviewQueue).values({
          verificationId: verificationRow.id,
          reason: result.headlineReason,
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

    return NextResponse.json(body, { status: 200 });
  } catch {
    return errorResponse(503, "SERVICE", "LabelHunter could not save this verification. Try again.");
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleVerifyRequest(request);
}
