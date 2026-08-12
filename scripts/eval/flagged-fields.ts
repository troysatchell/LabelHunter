/**
 * Builds the Sonnet resolver's `FlaggedField[]` input (LH-030 / TRO-470).
 * Pure — no I/O.
 *
 * Reused by both benchmark arms, for two different reasons:
 *   - the cascade arm (`check.ts`): builds `FlaggedField[]` from the real
 *     router's own field rows — exactly the fields the router escalated,
 *     matching production behavior (never force Sonnet onto a field the
 *     cascade would not route to it).
 *   - the Sonnet-only arm (`benchmark.ts`): flags every field regardless of
 *     what the router decided — see `resolver-rollup.ts`'s module comment
 *     for why "every field, always" is this benchmark's own definition of
 *     "Sonnet only".
 */
import type { FlaggedField } from "../../src/server/resolver";
import type { LabelRouterResult, ReviewReason, RouterFieldKey } from "../../src/server/router/types";

/** The minimal shape `buildFlaggedFields` needs from one field row — a
 * structural subset of `FieldResultRow`, not the whole thing, so a caller
 * with only a `VerifyFieldResult` (the API response shape, which carries
 * these three properties but not `confidence`/`applicationValue`) can call
 * this without building an unused placeholder. */
export interface FlaggableFieldRow {
  field: RouterFieldKey;
  reviewReason: ReviewReason | null;
  reason: string;
}

/**
 * Every field whose `reviewReason` is non-null becomes one `FlaggedField`,
 * `trigger` set to that field's own `reason` text — matching
 * `FlaggedField`'s own doc comment ("typically the router's own
 * FieldResultRow.reason for this field"). CP-1's own router contract
 * guarantees a NEEDS_REVIEW verdict always carries a reviewReason
 * (`src/server/router/field-resolution.ts`'s `resolveComparatorField`/
 * `resolveGovernmentWarningField` — every `NEEDS_REVIEW` return sets one),
 * so filtering on `reviewReason !== null` is equivalent to filtering on
 * "this field needs review" without also importing `FieldVerdict` just to
 * re-check it.
 */
export function buildFlaggedFields(fields: readonly FlaggableFieldRow[]): FlaggedField[] {
  const flagged: FlaggedField[] = [];
  for (const row of fields) {
    if (row.reviewReason !== null) {
      flagged.push({ field: row.field, reviewReason: row.reviewReason, trigger: row.reason });
    }
  }
  return flagged;
}

/**
 * Builds the resolver's `FlaggedField[]` for one escalated label
 * (`routerResult.labelVerdict === "REVIEW"`), handling BOTH escalation
 * shapes CP-1 describes:
 *
 *   1. A field-specific reason (`AMBIGUOUS_ABV`, `MISSING_REQUIRED_FIELD`,
 *      …) — `buildFlaggedFields`' own per-field case, the common one.
 *   2. A LABEL-LEVEL blocker (`LOW_IMAGE_QUALITY`, `CONFLICTING_EXTRACTION`)
 *      that fires independent of any one field's own comparator result — a
 *      label can escalate this way with EVERY field individually scoring a
 *      clean MATCH (`field-resolution.ts`'s own required/lowImageQuality
 *      interaction: a field-level `MISSING_REQUIRED_FIELD` is explicitly
 *      suppressed when `lowImageQuality` already explains the label). A
 *      real, observed case in the golden set (case-11): Haiku's own
 *      `image_quality` read triggered `LOW_IMAGE_QUALITY` while every
 *      individual field still parsed and compared cleanly.
 *
 * `resolveEscalatedLabel` refuses an empty `flaggedFields` list outright
 * ("nothing to resolve") — a caller that only ever flags fields with their
 * OWN non-null `reviewReason` crashes on shape 2 (found running this
 * ticket's own `--live --full` sweep against the real golden set, not a
 * hypothetical). When no field carries its own reason, every router field
 * is flagged instead, using the label's own `headlineReason` as the
 * trigger: a label-level blocker means Haiku's WHOLE reading is suspect,
 * not that one field individually failed — a field's clean MATCH is
 * exactly as suspect as a flagged one when the extraction under it might
 * be unreliable.
 */
export function buildFlaggedFieldsForEscalatedLabel(routerResult: LabelRouterResult): FlaggedField[] {
  const perField = buildFlaggedFields(
    routerResult.fields.map((f) => ({ field: f.field, reviewReason: f.reviewReason, reason: f.reason })),
  );
  if (perField.length > 0) return perField;

  if (!routerResult.headlineReason) {
    // Defensive: routeLabel's own invariant guarantees a REVIEW verdict
    // always carries a headlineReason (route.ts asserts this same
    // invariant on its own response) — naming it here rather than
    // silently constructing a FlaggedField with no real reason.
    throw new Error(
      "buildFlaggedFieldsForEscalatedLabel: labelVerdict is REVIEW but headlineReason is null — router invariant violated.",
    );
  }
  const headlineReason = routerResult.headlineReason;
  return routerResult.fields.map((f) => ({
    field: f.field,
    reviewReason: headlineReason,
    trigger: `Label-level blocker (${headlineReason}): no field individually failed, but the whole label's reading is suspect, so every field needs Sonnet's own re-read.`,
  }));
}

const ALL_ROUTER_FIELDS: readonly RouterFieldKey[] = [
  "brand_name",
  "class_type",
  "alcohol_content",
  "net_contents",
  "government_warning",
];

/**
 * Flags every one of the five router fields, regardless of what any
 * router decided — the Sonnet-only arm's own definition of "bypass the
 * cascade's selective escalation" (`resolver-rollup.ts`'s module comment).
 * `trigger` is a fixed, honest placeholder ("Sonnet-only benchmark: every
 * field routed to Sonnet, not escalation-selected") rather than a real
 * router reason, since no router decision produced this list.
 */
export function buildAllFieldsFlagged(): FlaggedField[] {
  return ALL_ROUTER_FIELDS.map((field) => ({
    field,
    reviewReason: "LOW_MODEL_CONFIDENCE",
    trigger: "Sonnet-only benchmark: every field routed to Sonnet, not escalation-selected.",
  }));
}
