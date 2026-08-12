/**
 * Validates the shape of a successful (HTTP 200) `/api/verify` response
 * body before the eval harness trusts it (LH-030 / TRO-470) — the same
 * boundary the latency harness already checks
 * (`scripts/latency/response.ts`'s `parseVerifySuccessBody`), extended to
 * also validate `fields`, which the eval harness needs for verdict-accuracy
 * scoring and the latency harness does not. Standing rule 13: validate at
 * the boundary where a value's shape is only assumed, not guaranteed —
 * `route.ts`'s own type system guarantees this shape today, but a caller
 * across a JSON-serialization boundary should check, not assume.
 */
import { FIELD_VERDICTS, LABEL_VERDICTS, REVIEW_REASONS } from "../../src/lib/db/enums";
import type { FieldVerdict, LabelVerdict, ReviewReason, RouterFieldKey } from "../../src/server/router/types";
import { ROUTER_FIELD_KEYS } from "./types";

export interface FullVerifyFieldResult {
  field: RouterFieldKey;
  verdict: FieldVerdict;
  labelValue: string | null;
  evidence: string;
  reason: string;
  reviewReason: ReviewReason | null;
}

export interface FullVerifySuccessBody {
  applicationId: number;
  verificationId: number;
  labelVerdict: LabelVerdict;
  headlineReason: ReviewReason | null;
  fields: FullVerifyFieldResult[];
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isReviewReasonOrNull(value: unknown): value is ReviewReason | null {
  return value === null || (typeof value === "string" && (REVIEW_REASONS as readonly string[]).includes(value));
}

function parseField(value: unknown): FullVerifyFieldResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.field !== "string" || !(ROUTER_FIELD_KEYS as readonly string[]).includes(candidate.field)) return null;
  if (typeof candidate.verdict !== "string" || !(FIELD_VERDICTS as readonly string[]).includes(candidate.verdict)) return null;
  if (candidate.labelValue !== null && typeof candidate.labelValue !== "string") return null;
  if (typeof candidate.evidence !== "string") return null;
  if (typeof candidate.reason !== "string") return null;
  if (!isReviewReasonOrNull(candidate.reviewReason)) return null;
  return {
    field: candidate.field as RouterFieldKey,
    verdict: candidate.verdict as FieldVerdict,
    labelValue: candidate.labelValue as string | null,
    evidence: candidate.evidence,
    reason: candidate.reason,
    reviewReason: candidate.reviewReason as ReviewReason | null,
  };
}

/**
 * Returns the typed body when `body` matches `FullVerifySuccessBody`'s
 * shape (all five router fields present, each individually valid), `null`
 * otherwise. Never throws.
 */
export function parseFullVerifySuccessBody(body: unknown): FullVerifySuccessBody | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Record<string, unknown>;
  if (!isPositiveSafeInteger(candidate.applicationId)) return null;
  if (!isPositiveSafeInteger(candidate.verificationId)) return null;
  if (typeof candidate.labelVerdict !== "string" || !(LABEL_VERDICTS as readonly string[]).includes(candidate.labelVerdict)) {
    return null;
  }
  if (!isReviewReasonOrNull(candidate.headlineReason)) return null;
  if (!Array.isArray(candidate.fields)) return null;

  // Exact length, not just "every required key present" — a body with a
  // duplicate field entry (two "brand_name" rows, one required key
  // missing) would pass a presence-only check; scoreVerdict downstream
  // would then have to catch it. Catching it here, at the actual JSON
  // boundary, is the more precise fix (standing rule 13).
  if (candidate.fields.length !== ROUTER_FIELD_KEYS.length) return null;

  const fields: FullVerifyFieldResult[] = [];
  for (const raw of candidate.fields) {
    const field = parseField(raw);
    if (!field) return null;
    fields.push(field);
  }
  if (ROUTER_FIELD_KEYS.some((key) => !fields.some((f) => f.field === key))) return null;

  return {
    applicationId: candidate.applicationId,
    verificationId: candidate.verificationId,
    labelVerdict: candidate.labelVerdict as LabelVerdict,
    headlineReason: candidate.headlineReason as ReviewReason | null,
    fields,
  };
}
