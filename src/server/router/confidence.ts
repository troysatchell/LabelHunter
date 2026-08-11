/**
 * Confidence thresholds (CP-1 §4.2-§4.3). Two separate ideas live here:
 *
 * 1. A confidence BAND ("trusted" / "uncertain" / "unusable") — a label for
 *    how much to trust a number, used by `LOW_IMAGE_QUALITY` (CP-1 §5.3) and
 *    in the reason text a reviewer reads.
 * 2. The ASYMMETRY RULE (§4.3) — the actual escalation decision. It is not
 *    the same thing as "escalate whenever the band is not trusted": a
 *    low-confidence MATCH is corroborated by agreement and often does not
 *    escalate, while a low-confidence MISMATCH almost always does. Read
 *    `shouldEscalateField`'s doc comment before changing either function.
 *
 * Every function here assumes `confidence` already passed the CP-1 §4.4
 * overrides (`overrides.ts`) — a finite number in `[0, 1]`. That check runs
 * once, at the router's boundary with the extractor's untrusted output; it
 * is not repeated here.
 */
import type { FieldVerdict, RouterFieldKey } from "./types";

/**
 * True when `confidence` is a real, in-range number (CP-1 §4.4 rule 3).
 * `NaN`, `null` (cast through `unknown`), `1.5`, and `-0.2` are all invalid —
 * the router rejects a field with an invalid confidence, it never clamps
 * one into range (§4.4: clamping would move malformed output onto the
 * trusted path instead of flagging the extraction itself as broken).
 */
export function isValidConfidence(confidence: number): boolean {
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
}

/** The floor below which a value is unusable, for every field (CP-1 §4.2). */
export const UNUSABLE_CEILING = 0.6;

/** The trusted-band floor for every field except the warning transcription. */
export const TRUSTED_THRESHOLD_DEFAULT = 0.85;

/**
 * The trusted-band floor for `government_warning.transcription` only
 * (CP-1 §4.2's one override). The downstream comparison is exact, so a
 * one-character transcription slip becomes a false FAIL — the bar for
 * trusting the transcription outright is higher than for the other fields.
 */
export const TRUSTED_THRESHOLD_WARNING_TRANSCRIPTION = 0.9;

/**
 * The trusted-band floor for `field` (CP-1 §4.2). Every field uses
 * `TRUSTED_THRESHOLD_DEFAULT` except the government warning's transcription.
 */
export function getTrustedThreshold(field: RouterFieldKey): number {
  return field === "government_warning" ? TRUSTED_THRESHOLD_WARNING_TRANSCRIPTION : TRUSTED_THRESHOLD_DEFAULT;
}

export type ConfidenceBand = "trusted" | "uncertain" | "unusable";

/**
 * Classifies `confidence` into one of the three CP-1 §4.2 bands.
 * `trustedThreshold` is field-dependent — call `getTrustedThreshold` first.
 */
export function classifyConfidenceBand(confidence: number, trustedThreshold: number): ConfidenceBand {
  if (confidence < UNUSABLE_CEILING) return "unusable";
  if (confidence < trustedThreshold) return "uncertain";
  return "trusted";
}

/**
 * The MATCH-side escalation cutoff (CP-1 §4.3). Numerically the same as
 * `UNUSABLE_CEILING` — a matching read escalates exactly when its
 * confidence is Unusable — but named separately because the two constants
 * answer different questions (a band label vs. an escalation decision) and
 * §4.5 says they may be re-tuned independently once the golden set measures
 * them.
 */
export const MATCH_ESCALATION_CEILING = UNUSABLE_CEILING;

/**
 * The MISMATCH-side escalation cutoff (CP-1 §4.3). Numerically the same as
 * `TRUSTED_THRESHOLD_WARNING_TRANSCRIPTION`, but a different concept: this
 * one applies to every field's MISMATCH case, not only the warning
 * transcription's trusted band. Kept as its own named constant so a future
 * re-tune of one does not silently move the other.
 */
export const MISMATCH_ESCALATION_CEILING = 0.9;

/**
 * The asymmetry rule (CP-1 §4.3), implemented exactly as given — three
 * fixed numbers, the same across every field, independent of the per-field
 * trusted threshold in `getTrustedThreshold`:
 *
 * | Comparator says | Escalate when      |
 * |------------------|---------------------|
 * | MATCH            | confidence < 0.60   |
 * | MISMATCH         | confidence < 0.90   |
 * | NEEDS_REVIEW     | always              |
 *
 * Why MATCH and MISMATCH use different cutoffs: if a low-confidence read
 * nonetheless equals the application value, two independent things lined
 * up — the model had to misread, and the misread had to land exactly on the
 * applicant's value. That is corroborating evidence, and it partly
 * substitutes for confidence. A mismatch has no such corroboration; it is
 * exactly what a misread produces, so the router checks it more often.
 *
 * This function decides escalation only. It does not decide WHICH
 * `ReviewReason` applies — that is `reasons.ts`'s job, using this result
 * plus the field-specific checks CP-1 §5.3 names for each `AMBIGUOUS_*`
 * reason.
 */
export function shouldEscalateField(verdict: FieldVerdict, confidence: number): boolean {
  switch (verdict) {
    case "MATCH":
      return confidence < MATCH_ESCALATION_CEILING;
    case "MISMATCH":
      return confidence < MISMATCH_ESCALATION_CEILING;
    case "NEEDS_REVIEW":
      return true;
  }
}
