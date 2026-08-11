/**
 * Types for the Sonnet resolver (LH-014 / TRO-464, PRD §3.1/§3.3, CP-1 §6).
 *
 * The resolver answers a narrower question than the extractor or the
 * router: given the fields the router could not decide, and only those
 * fields, what should the verdict be? CP-1 §6.5 draws one line through the
 * whole design, and these types encode it structurally rather than as a
 * comment someone has to remember to honor:
 *
 *   - `brand_name` / `class_type` — TH-R8's judgment. The resolver's
 *     disposition (RESOLVED_MATCH / RESOLVED_MISMATCH / NEEDS_HUMAN) is
 *     authoritative. `JudgedFieldResolution` carries it.
 *   - `alcohol_content` / `net_contents` / `government_warning` — the
 *     resolver re-reads; it never judges. `CorrectionFieldResolution` has
 *     no `disposition` property at all — there is no field in this type a
 *     caller could read to learn the model's MATCH/MISMATCH opinion, because
 *     that opinion is discarded before it leaves this module (`response.ts`).
 *     What IS preserved is `needsHuman`: "I cannot read this" is a real,
 *     legitimate signal (CP-1 §6.2 rule 7) distinct from the judgment this
 *     type refuses to carry.
 *
 * `ResolvedFieldResult`'s two branches are not merely similar-shaped
 * interfaces — `field` is narrowed per branch (`ResolverJudgedField` vs.
 * `ResolverCorrectionField`), so `{ kind: "judged", field: "alcohol_content" }`
 * is a compile error, not a runtime check (see `types.test.ts`).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { HaikuExtractionResult } from "../extractor/types";
import type { PreprocessedLabelImage } from "../extractor/types";
import type { ApplicationRecord, LabelRouterResult, ReviewReason, RouterFieldKey } from "../router/types";

export type { ApplicationRecord, LabelRouterResult, ReviewReason, RouterFieldKey };
export type { PreprocessedLabelImage };

/**
 * The two fields TH-R8 asks for judgment on (CP-1 §6.5's table, "who makes
 * the final call: the resolver"). The resolver's disposition for these
 * fields IS the verdict.
 */
export type ResolverJudgedField = "brand_name" | "class_type";

/**
 * The three fields CP-1 §6.5 marks "who makes the final call: code". The
 * resolver only re-reads; the corrected reading goes back through the same
 * deterministic comparator the router already used (the pipeline's job,
 * LH-015/LH-016 — this module never re-implements the router's comparators).
 */
export type ResolverCorrectionField = "alcohol_content" | "net_contents" | "government_warning";

/**
 * Every field value the resolver's output schema (`schema.ts`) may name.
 * `beverage_type` is schema-legal (CP-1 §6.4's `field` enum includes it) but
 * open question 12 in CP-1 notes it is never actually flagged by the router
 * (CONFLICTING_EXTRACTION is a label-level reason, not a per-field one) — it
 * is carried here for completeness with the approved schema, not because a
 * caller can reach it today.
 */
export type ResolverField = ResolverJudgedField | ResolverCorrectionField | "beverage_type";

/** The resolver's three possible answers for one field (CP-1 §6.2 "YOUR THREE ANSWERS"). */
export type ResolverDisposition = "RESOLVED_MATCH" | "RESOLVED_MISMATCH" | "NEEDS_HUMAN";

/**
 * One field the router escalated, and what the pipeline wants the resolver
 * to look at. Caller-supplied (the pipeline, LH-015/LH-016) rather than
 * derived inside this module: which fields to ask about is a routing
 * decision — for a field-specific `ReviewReason` it is that field alone,
 * but for a label-level blocker (`LOW_IMAGE_QUALITY`, `CONFLICTING_EXTRACTION`)
 * it may be every required field, and only the caller holding the full
 * router result can make that call. This module answers only for what it is
 * told to (CP-1 §6.1: "It answers only for these").
 */
export interface FlaggedField {
  field: RouterFieldKey;
  reviewReason: ReviewReason;
  /** One line describing why this field was flagged (CP-1 §6.3's "Trigger:"
   * text) — typically the router's own `FieldResultRow.reason` for this
   * field, so the model is shown the same sentence a human reviewer would
   * see, not a second hand-written description that can drift from it. */
  trigger: string;
}

/**
 * Everything one resolver call needs (CP-1 §6.1's input table), plus the
 * `verificationId` the review-queue insertion is keyed to.
 */
export interface ResolverInput {
  /** `verifications.id` this resolution is for. */
  verificationId: number;
  /** The sonnetVariant from preprocessing (≤2576px long edge) — full
   * resolution relative to what the extractor saw (CP-1 §3.5). */
  image: PreprocessedLabelImage;
  /** The Haiku extractor's full reading. Untrusted input (CP-1 §6.3) — an
   * applicant-influenced label produced every string in it. */
  extraction: HaikuExtractionResult;
  /** The application record. Untrusted input (CP-1 §6.3) — an applicant
   * filled it out, same as the image. */
  application: ApplicationRecord;
  /** The router's full output for this label — supplies the "WHAT THE CODE
   * DECIDED" table (CP-1 §6.3) and the guard that this label actually
   * escalated (`labelVerdict === "REVIEW"`). */
  router: LabelRouterResult;
  /** Exactly the fields this call should answer for. Must be non-empty. */
  flaggedFields: FlaggedField[];
}

/** The resolver's disposition on a `brand_name`/`class_type` field — the
 * ONE place (TH-R8) the model's judgment is the final answer. */
export interface JudgedFieldResolution {
  kind: "judged";
  field: ResolverJudgedField;
  disposition: ResolverDisposition;
  /** The resolver's corrected reading, when it gave one. `null` when the
   * disposition is NEEDS_HUMAN and no reading was offered. */
  correctedValue: string | null;
  /** Verbatim text the resolver says it saw, character for character. */
  evidence: string;
  /** One line of UI English (CP-1 §6.2 rule 3) — never a bare confidence number. */
  reason: string;
  confidence: number;
}

/** The resolver's re-read of a field code re-decides. No `disposition`
 * property exists on this type — see the module doc comment above; this is
 * the structural enforcement of CP-1 §6.5, not a runtime check. */
export interface CorrectionFieldResolution {
  kind: "correction";
  field: ResolverCorrectionField;
  /** True when the resolver's raw disposition was NEEDS_HUMAN — "I cannot
   * read this well enough" is real signal (CP-1 §6.2 rule 7), preserved
   * even though a RESOLVED_MATCH/RESOLVED_MISMATCH opinion on the same
   * field is not. */
  needsHuman: boolean;
  correctedValue: string | null;
  evidence: string;
  reason: string;
  confidence: number;
}

/** One field's resolution — a discriminated union on `kind`, `field`
 * narrowed per branch (see module doc comment). */
export type ResolvedFieldResult = JudgedFieldResolution | CorrectionFieldResolution;

/** Whether a human still needs to look at this label after the resolver ran
 * (CP-1 §6.4: recomputed from the per-field results, never trusted from the
 * raw API response's own `overall`). */
export type ResolverOutcome = "resolved" | "needs-human";

/** What one resolver call produced, before review-queue insertion. */
export interface ResolverResolution {
  outcome: ResolverOutcome;
  fields: ResolvedFieldResult[];
}

/** What `resolveEscalatedLabel` returns — the resolution plus where it was filed. */
export interface ResolverResult extends ResolverResolution {
  /** `review_queue.id` of the row this call inserted. */
  reviewQueueId: number;
}

/** The raw shape one `fields[]` entry takes in the API response, before the
 * judged/correction split (CP-1 §6.4). Every field carries every property —
 * the schema is not split by field (CP-1 open question 12 flags this as a
 * real gap and recommends splitting it; not adopted here, since CP-1 is
 * approved as drafted — see `response.ts` for how this module enforces the
 * judges-only-brand/class rule anyway, at the parsing boundary). */
export interface RawResolverField {
  field: ResolverField;
  disposition: ResolverDisposition;
  corrected_value: string | null;
  evidence: string;
  reason: string;
  confidence: number;
}

/** The raw, schema-shaped API response (CP-1 §6.4), before recomputing `overall`. */
export interface RawResolverResponse {
  overall: "RESOLVED" | "NEEDS_HUMAN";
  fields: RawResolverField[];
}

/** Re-exported so callers building `ResolverInput` do not need a second
 * import from the SDK just for the message type `parseResolverResponse` takes. */
export type AnthropicMessage = Anthropic.Message;
