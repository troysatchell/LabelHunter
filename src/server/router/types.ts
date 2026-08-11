/**
 * Types for the Validation Router (LH-012 / TRO-462, PRD §3.3, CP-1 §4-§5).
 *
 * The router answers one question: given what the extractor read and what
 * the applicant filed, does the label pass? It never calls a model (TH-R19).
 * It takes the Haiku extractor's output (`../extractor/types.ts`) as
 * untrusted input and a caller-supplied application record, and produces one
 * verdict row per field plus a label-level verdict.
 *
 * Scope note (see `.gitkeep`'s original text and TRO-462's brief): this
 * ticket owns the router's decision logic — confidence bands, the
 * deterministic overrides, the `ReviewReason` precedence and rollup. It does
 * NOT own the real field comparators (normalization, fuzzy brand/class
 * matching, ABV parsing, net-contents parsing) — that is LH-013 / TRO-463.
 * `FieldComparator` below is the interface LH-013 implements against.
 */
import type { BeverageType, ReviewReason } from "../../lib/db/enums";
import type { ExtractedField } from "../extractor/types";

export type { BeverageType, ReviewReason };

/** Per-field verdict the router assigns (PRD §3.3). */
export type FieldVerdict = "MATCH" | "MISMATCH" | "NEEDS_REVIEW";

/** Label-level verdict the router assigns (PRD §3.3, CP-1 §5.4). */
export type LabelVerdict = "PASS" | "FAIL" | "REVIEW";

/**
 * The five fields the router writes a row for (CP-1 §5.5). Snake_case to
 * match `HaikuExtractionResult`'s own keys (`../extractor/types.ts`) —
 * `src/lib/db/enums.ts`'s `FieldName` uses a different, upper-snake-case
 * convention for the Postgres enum column. Mapping between the two belongs
 * to the persistence ticket that writes `field_results` rows, not this one.
 */
export type RouterFieldKey =
  | "brand_name"
  | "class_type"
  | "alcohol_content"
  | "net_contents"
  | "government_warning";

/** The four fields a `FieldComparator` judges. `government_warning` is not
 * one of them — it is compared by its own subsystem (LH-020, CP-2). */
export type ComparatorFieldKey = Exclude<RouterFieldKey, "government_warning">;

/**
 * The application record the router compares a label reading against.
 * Field names mirror `ExtractedField`'s counterparts so a row's "label
 * value" / "application value" pair is easy to read side by side.
 */
export interface ApplicationRecord {
  beverageType: BeverageType;
  brandName: string;
  classType: string;
  /**
   * Percent ABV as filed. Omitted when the applicant's form did not ask for
   * one. CP-1 §5.3 marks `alcohol_content`'s requiredness for beer/wine
   * **VERIFY** — see `required-fields.ts` — so an omitted value here is a
   * normal input, not a contract violation, regardless of what the required-
   * field table currently says.
   */
  alcoholContentPercent?: number;
  netContentsValue: number;
  /** Unit as filed, e.g. "mL", "L", "fl oz". */
  netContentsUnit: string;
}

/** What a `FieldComparator` decides for one field. */
export interface ComparatorResult {
  verdict: FieldVerdict;
  /** One line of UI English (PRD §3.3) — never a bare confidence number. */
  note?: string;
}

/** Context a comparator needs beyond the two values it compares. */
export interface ComparatorContext {
  beverageType: BeverageType;
}

/**
 * The shape LH-013's real field comparators satisfy: brand_name, class_type,
 * alcohol_content, net_contents. This ticket (LH-012) defines the shape and
 * the routing decisions that consume its output. It does not implement real
 * normalization, fuzzy brand/class matching, ABV parsing, or net-contents
 * parsing — see `test-support.ts` for this ticket's own placeholder
 * comparators, honestly scoped and never claimed as the real judgment logic.
 *
 * `applicationValue` is `string` for brand_name/class_type and `number` for
 * alcohol_content (percent) and net_contents (the applicant's filed value,
 * in the applicant's stated unit — unit conversion is the comparator's job).
 */
export type FieldComparator = (
  extracted: ExtractedField,
  applicationValue: string | number,
  context: ComparatorContext,
) => ComparatorResult;

/** One comparator per `ComparatorFieldKey`, supplied by the caller. */
export type FieldComparators = Record<ComparatorFieldKey, FieldComparator>;

/**
 * The government-warning comparator's contract (CP-1 §5.3 "WARNING_MISMATCH").
 * The real comparator — VLM transcription + OCR, exact statutory comparison —
 * is LH-020's job, gated by CP-2, not yet cleared. This ticket accepts an
 * already-computed result in this shape and routes on it. It builds no
 * warning-comparison logic of its own.
 *
 * A discriminated union, not one interface with an optional `reviewReason`.
 * CP-1 §5.3's contract table always pairs a REVIEW outcome with a specific
 * reason (`WARNING_MISMATCH`, `LOW_IMAGE_QUALITY`, or
 * `MISSING_REQUIRED_FIELD`). Making `reviewReason` required on the
 * `NEEDS_REVIEW` branch, and absent everywhere else, makes a REVIEW result
 * with no stated reason a compile error for LH-020 to hit, not a silent
 * default this router would otherwise have to guess.
 */
export type WarningComparatorResult =
  | { verdict: "MATCH" | "MISMATCH"; note?: string }
  | {
      verdict: "NEEDS_REVIEW";
      reviewReason: Extract<ReviewReason, "WARNING_MISMATCH" | "LOW_IMAGE_QUALITY" | "MISSING_REQUIRED_FIELD">;
      note?: string;
    };

/**
 * What LH-010's preprocessing stage found before the image reached the
 * extractor. LH-010's decode/resize/reject path has not landed in this repo
 * yet (only the crop hook, `src/server/preprocessing/region.ts`, has) — the
 * router accepts this as an explicit caller-supplied signal instead of
 * importing a module that does not exist, so a caller wires it in once that
 * path lands. `LOW_IMAGE_QUALITY` needs it directly (CP-1 §5.3).
 */
export interface PreprocessingSignal {
  /** True when preprocessing could not decode the file, or rejected it outright. */
  rejected: boolean;
  /** Long edge of the image sent to the extractor, in pixels. */
  longEdgePx: number;
}

/** One row of the router's output table (CP-1 §5.5, exact columns). */
/**
 * `resolvedBy` and `reviewReason` are not independent: a field is resolved
 * by Sonnet or a human only because it was escalated in the first place, so
 * a non-null `resolvedBy` requires the `reviewReason` that caused it — an
 * invalid `{ resolvedBy: "sonnet", reviewReason: null }` state cannot be
 * constructed. The unresolved branch keeps `reviewReason` optional-null:
 * a field can carry a reason while waiting on resolution, or carry none at
 * all when it never needed escalation. Always the second branch from this
 * ticket — LH-014's resolver does not exist yet.
 */
export type FieldResultRow = {
  field: RouterFieldKey;
  verdict: FieldVerdict;
  /** What the extractor read. `null` when absent or rejected by an override. */
  labelValue: string | null;
  /** What the applicant filed. */
  applicationValue: string | number;
  /** Verbatim label text the extractor copied. */
  evidence: string;
  /** The extractor's confidence, after the §4.4 overrides. */
  confidence: number;
  /** One line of UI English (PRD §3.3, TH-R20) — never a bare confidence percentage. */
  reason: string;
} & (
  | { resolvedBy: "sonnet" | "human"; reviewReason: ReviewReason }
  | { resolvedBy: null; reviewReason: ReviewReason | null }
);

/** The router's full output for one label. */
export interface LabelRouterResult {
  labelVerdict: LabelVerdict;
  /** The single highest-ranked reason across the whole label (CP-1 §5.2), or
   * `null` for a clean PASS. */
  headlineReason: ReviewReason | null;
  fields: FieldResultRow[];
}
