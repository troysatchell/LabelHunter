import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Closed-set vocabulary for LabelHunter's data model (PRD §3.6).
 *
 * Each value list is the single source of truth for three things at once:
 * the TypeScript literal union, the Postgres enum type (via `pgEnum`), and
 * the runtime guard that validates an untyped string against the set. Keep
 * all three in sync by editing only the array — everything else derives
 * from it.
 */

/**
 * Beverage type. PRD §2: the beverage-type selector (beer/wine/spirits)
 * that later tickets use to adjust field rules, e.g. ABV optionality.
 * This ticket stores the value; it does not implement the rule (LH-013).
 */
export const BEVERAGE_TYPES = ["beer", "wine", "spirits"] as const;
export type BeverageType = (typeof BEVERAGE_TYPES)[number];
export const beverageTypeEnum = pgEnum("beverage_type", BEVERAGE_TYPES);

/** Label-level verdict (PRD §3.3). A `verifications` row always has one —
 * there is no "pending" state, because the row exists only once the
 * cascade has produced a result. */
export const LABEL_VERDICTS = ["PASS", "FAIL", "REVIEW"] as const;
export type LabelVerdict = (typeof LABEL_VERDICTS)[number];
export const labelVerdictEnum = pgEnum("label_verdict", LABEL_VERDICTS);

/** Per-field verdict (PRD §3.3). */
export const FIELD_VERDICTS = ["MATCH", "MISMATCH", "NEEDS_REVIEW"] as const;
export type FieldVerdict = (typeof FIELD_VERDICTS)[number];
export const fieldVerdictEnum = pgEnum("field_verdict", FIELD_VERDICTS);

/** The five fields the router compares (PRD §2's "5 example fields": brand
 * name, class/type, alcohol content, net contents, government warning). */
export const FIELD_NAMES = [
  "BRAND_NAME",
  "CLASS_TYPE",
  "ALCOHOL_CONTENT",
  "NET_CONTENTS",
  "GOVERNMENT_WARNING",
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
export const fieldNameEnum = pgEnum("field_name", FIELD_NAMES);

/** Reason a verification escalates to the Sonnet resolver or to a human
 * (PRD §3.3, quoted verbatim). */
export const REVIEW_REASONS = [
  "LOW_IMAGE_QUALITY",
  "AMBIGUOUS_BRAND",
  "AMBIGUOUS_ABV",
  "AMBIGUOUS_NET_CONTENTS",
  "WARNING_MISMATCH",
  "MISSING_REQUIRED_FIELD",
  "CONFLICTING_EXTRACTION",
  "LOW_MODEL_CONFIDENCE",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export const reviewReasonEnum = pgEnum("review_reason", REVIEW_REASONS);

/** Which model(s) produced a verification's verdict (PRD §3.1 cascade):
 * the Haiku extractor alone, or the extractor plus the Sonnet resolver. */
export const RESOLUTION_PATHS = ["EXTRACTOR_ONLY", "EXTRACTOR_RESOLVER"] as const;
export type ResolutionPath = (typeof RESOLUTION_PATHS)[number];
export const resolutionPathEnum = pgEnum("resolution_path", RESOLUTION_PATHS);

/** A batch job's lifecycle state (PRD §3.5). `FAILED` is a whole-job
 * failure (e.g. the manifest could not be read) — one bad image inside a
 * running job fails that item only and shows up in `failedCount`, never
 * this status. */
export const BATCH_JOB_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED"] as const;
export type BatchJobStatus = (typeof BATCH_JOB_STATUSES)[number];
export const batchJobStatusEnum = pgEnum("batch_job_status", BATCH_JOB_STATUSES);

/** A human reviewer's disposition of a `review_queue` item. Deliberately
 * has no reviewer identity column anywhere near it — see TH-R6 in
 * schema.ts. */
export const REVIEW_DISPOSITIONS = ["APPROVED", "REJECTED"] as const;
export type ReviewDisposition = (typeof REVIEW_DISPOSITIONS)[number];
export const reviewDispositionEnum = pgEnum("review_disposition", REVIEW_DISPOSITIONS);

/**
 * Narrows an arbitrary string to a member of a closed set, or throws.
 *
 * Values entering these tables often start as loosely-typed strings — model
 * output, a CSV cell, a query param — not a typed literal. This is the one
 * checkpoint between that string and an insert, so a bad value fails loudly
 * here with the full list of legal values, instead of surfacing later as an
 * opaque Postgres enum-constraint error.
 */
export function assertEnumMember<T extends string>(
  values: readonly T[],
  value: string,
  label: string,
): T {
  if ((values as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(
    `${label}: "${value}" is not one of ${values.map((v) => `"${v}"`).join(", ")}.`,
  );
}

/** Narrows a string to a `ReviewReason`, or throws. See `assertEnumMember`. */
export function toReviewReason(value: string): ReviewReason {
  return assertEnumMember(REVIEW_REASONS, value, "toReviewReason");
}

/** Narrows a string to a `BeverageType`, or throws. See `assertEnumMember`. */
export function toBeverageType(value: string): BeverageType {
  return assertEnumMember(BEVERAGE_TYPES, value, "toBeverageType");
}
