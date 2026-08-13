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
import type { ExtractedField, ImageQualityIssue } from "../extractor/types";

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
 * The four rules `isLowImageQuality` (`label-blockers.ts`) can fire on
 * (CP-1 §5.3, TRO-542). Two are deterministic on their own
 * (`PREPROCESSING`, `FIELDS_ABSENT`); two pair a self-report with another
 * self-report (`ILLEGIBLE`, `FIELD_CONFIDENCE`) — CP-1 §4.1 calls that
 * pairing out by name as the one still-open promise this ticket measures,
 * not one it closes. Naming the trigger, instead of returning a bare
 * boolean, is what lets a run state WHICH rule decided, not only that the
 * label-level blocker fired.
 */
export type LowImageQualityTrigger = "ILLEGIBLE" | "FIELD_CONFIDENCE" | "PREPROCESSING" | "FIELDS_ABSENT";

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
 * Which reconciliation table decided a `WarningComparatorResult` (TRO-535 /
 * LH-030b, CP-2 §4.5's amendment). `"dual"`: the OCR channel cleared
 * `OCR_CONFIDENCE_FLOOR` (`../warning/reconcile.ts`), so both the VLM and
 * OCR readings were compared against each other. `"single"`: OCR was
 * unavailable (no crop found, or the OCR call itself produced nothing) OR
 * its confidence sat below the floor, so the VLM reading alone decided —
 * CP-2 §10 Q7's residual false-PASS path, and the reason a single-channel
 * PASS on this field is worth counting on its own (see
 * `scripts/eval/warning-segmentation.ts`'s `singleChannelPass`).
 */
export type WarningComparatorChannel = "dual" | "single";

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
 *
 * `channel` is OPTIONAL, not required on every branch, for one honest
 * reason: `compareGovernmentWarningFromImage`'s own defensive branch
 * (`../warning/index.ts`, "a real caller filters this case out before
 * reaching here") returns a bare `MISSING_REQUIRED_FIELD` result without
 * ever running `reconcileWarningChannels` — there is no reconciliation
 * table behind that result to name. Every result `reconcileWarningChannels`
 * itself returns always sets `channel` (TRO-535 / LH-030b).
 */
export type WarningComparatorResult =
  | { verdict: "MATCH" | "MISMATCH"; channel?: WarningComparatorChannel; note?: string }
  | {
      verdict: "NEEDS_REVIEW";
      channel?: WarningComparatorChannel;
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
  /**
   * TRO-542: which CP-1 §5.3 rule made `isLowImageQuality` fire, or `null`
   * when it did not fire. `LOW_IMAGE_QUALITY` outranks every other
   * `ReviewReason` (`precedence.ts`'s rank 0), so this is non-null exactly
   * when `headlineReason` is `LOW_IMAGE_QUALITY`. No artifact recorded
   * this before this ticket — `scripts/eval/results/eval-report.json` had
   * no `confidence`/trigger field at all.
   */
  lowImageQualityTrigger: LowImageQualityTrigger | null;
  /**
   * TRO-542: Haiku's own self-reported `image_quality.issues`
   * (`../extractor/types.ts`'s `ExtractedImageQuality`), carried through
   * verbatim. Evidence only — no branch in `label-blockers.ts` or
   * `index.ts` tests `.issues`, so CP-1 §4.1 still holds: a self-report
   * never decides anything alone. Reading it here answers this ticket's
   * step 4 ("the router reads it, or the schema drops it") without
   * claiming the read closes CP-1's pairing gap — it does not.
   */
  imageQualityIssues: readonly ImageQualityIssue[];
}
