/**
 * Types for the verification Detail view's server-side data (TRO-466, PRD
 * §5, TH-R3, TH-R20). Pure types and one pure constant only — no `pg` or any
 * other server-only import belongs in this file, the same discipline
 * `src/app/api/verify/types.ts` documents for its own shapes.
 */
import type { FieldVerdict, LabelVerdict, RouterFieldKey } from "../router";
import type { BoldSignal } from "../warning";

/**
 * Human-readable label for one of the router's five fields. A short,
 * intentional duplicate of `src/app/api/verify/types.ts`'s own
 * `FIELD_LABELS`: that copy serves the app/api layer, this one serves
 * `server/verification-detail`, and no file under `src/server/` imports
 * from `src/app/` anywhere in this codebase — this module keeps that
 * one-directional layering rather than being the first exception for five
 * short strings. Keep both in sync by hand if a field is ever renamed.
 */
export const FIELD_LABELS: Record<RouterFieldKey, string> = {
  brand_name: "Brand name",
  class_type: "Class/type",
  alcohol_content: "Alcohol content",
  net_contents: "Net contents",
  government_warning: "Government warning",
};

/**
 * One field's full comparison, for the Detail view (PRD §5: "extracted vs
 * application values per field, match badges").
 */
export interface VerificationFieldDetail {
  field: RouterFieldKey;
  fieldLabel: string;
  verdict: FieldVerdict;
  /** What the extractor read on the label, cleaned. `null` when absent. */
  labelValue: string | null;
  /** Verbatim label text supporting `labelValue`. Empty string when absent. */
  evidence: string;
  /**
   * What the applicant filed, formatted for display. For `government_
   * warning`, there is no per-application value to show — every label is
   * checked against the same statutory text, not an application-specific
   * one (see `src/lib/db/schema.ts`'s comment on the `applications` table).
   * This field holds a plain description of that legal standard instead,
   * never the canonical text itself: sourcing and verifying that text
   * against ttb.gov is LH-020's own CP-2-gated decision (PRD §3.4, §10),
   * not something this ticket invents ahead of that checkpoint.
   */
  applicationValue: string;
  /** One line of UI English (TH-R20) — never a bare confidence percentage. */
  reason: string;
}

/**
 * The label image the Detail view shows side-by-side with the comparison
 * (PRD §5). `url` points at the image-bytes route
 * (`src/app/api/label-images/[labelImageId]/route.ts`). `width`/`height`
 * are the EXIF-corrected pixel dimensions `preprocessImage` recorded at
 * upload time, so the page can reserve layout space before the image
 * itself loads.
 */
export interface VerificationImageDetail {
  url: string;
  width: number;
  height: number;
  originalFilename: string;
}

/** The Detail view's full data for one verification (PRD §5). */
export interface VerificationDetail {
  verificationId: number;
  applicationId: number;
  labelVerdict: LabelVerdict;
  /**
   * The same "Needs review — {reason}" sentence
   * `src/app/api/verify/route.ts` builds for a live REVIEW verdict, built
   * here from the persisted `review_queue.reason` with the router's own
   * `buildFieldReasonText` — not a new, second copy of that wording.
   * `null` for PASS/FAIL, and for a REVIEW row with no `review_queue` row
   * (should not happen; `route.ts`'s own invariant check says every REVIEW
   * verdict gets one — see this ticket's report).
   */
  headlineMessage: string | null;
  /**
   * True when the Sonnet resolver produced this verdict (PRD §5's "Resolved
   * by Sonnet" annotation) — `verifications.resolution_path ===
   * "EXTRACTOR_RESOLVER"` (`src/lib/db/enums.ts`). Label-level only:
   * `field_results` carries no per-field resolver column yet, so a
   * per-field annotation would be inventing a fact the schema does not
   * carry — see this ticket's report for the flagged gap.
   */
  resolvedBySonnet: boolean;
  /**
   * The Sonnet resolver's own free-text note, when `review_queue.
   * resolver_output` is an object with a string `note` property. `null`
   * otherwise. `resolver_output` is an untyped `jsonb` column — no
   * resolver (LH-014) has shipped yet, so there is no fixed contract to
   * trust (standing rule 13: validate at the boundary).
   */
  resolverNote: string | null;
  labelImage: VerificationImageDetail;
  fields: VerificationFieldDetail[];
  /**
   * LH-025/LH-026 (TRO-532/TRO-533), CP-2 §7.2/§7.3, TH-R9. The pixel-
   * measured bold advisory signal for this verification's government
   * warning — `null` when it was never measured (no warning-region crop
   * existed for this label; `schema.ts`'s own `verifications.boldSignal`
   * comment names this the same distinct state). ADVISORY ONLY: this
   * value plays no part in `labelVerdict` or any `VerificationFieldDetail`
   * above — `getVerificationDetail` reads it straight off the persisted
   * row, after `routeLabel` already decided the verdict.
   */
  boldSignal: VerificationBoldSignalDetail | null;
}

/**
 * The Detail view's own narrow read of `BoldSignalResult`
 * (`src/server/warning/bold-detect.ts`) — `signal` and `reason` only.
 * `ratio`/`splitFraction`/`prefixStrokeWidthPx`/`bodyStrokeWidthPx` stay
 * out of this UI-facing type on purpose: standing rule 12 says the UI
 * shows a reason, never a bare number, and `reason` (ASD-STE100 prose,
 * `bold-detect.ts`'s own header comment) already carries what those
 * numbers would only restate less clearly.
 */
export interface VerificationBoldSignalDetail {
  signal: BoldSignal;
  reason: string;
}

/** `getVerificationDetail`'s result: a discriminated union, not a nullable
 * return, so a caller cannot read `.detail` without first checking `found`. */
export type GetVerificationDetailResult =
  | { found: true; detail: VerificationDetail }
  | { found: false };
