/**
 * The two label-level blockers (CP-1 §5.3): `LOW_IMAGE_QUALITY` (rank 1)
 * and `CONFLICTING_EXTRACTION` (rank 2). Both describe the whole read, not
 * one field — `LOW_IMAGE_QUALITY` says the image itself cannot be trusted;
 * `CONFLICTING_EXTRACTION` says the router does not trust its own reading,
 * even though the label may be perfect (§5.1). Either one makes every
 * field-level finding secondary — see `rollup.ts`.
 */
import type { ExtractedImageQuality } from "../extractor/types";
import { UNUSABLE_CEILING } from "./confidence";
import type { FieldState } from "./field-state";
import { isFieldAbsent } from "./field-state";
import type { PreprocessingSignal } from "./types";

/**
 * `LOW_IMAGE_QUALITY` (CP-1 §5.3). `requiredFieldStates` must be only the
 * fields required for this label's beverage type — an optional field's low
 * confidence does not speak to whether the IMAGE is readable.
 */
export function isLowImageQuality(
  imageQuality: ExtractedImageQuality,
  preprocessing: PreprocessingSignal,
  requiredFieldStates: FieldState[],
): boolean {
  if (imageQuality.legible === "no") return true;

  if (imageQuality.legible === "partial") {
    // Skip an override-rejected field here: `overrides.ts` zeroes a field's
    // confidence to 0 when the rejection cause is an invalid confidence
    // number (so the router never shows a garbage figure), and that
    // synthetic 0 is not evidence the IMAGE was hard to read — it is
    // evidence the extraction itself was broken, already counted toward
    // `CONFLICTING_EXTRACTION`. Counting it again here would misattribute a
    // broken-extraction problem to image quality.
    const anyRequiredFieldUnusable = requiredFieldStates.some(
      (state) => !state.overrideRejected && state.confidence < UNUSABLE_CEILING,
    );
    if (anyRequiredFieldUnusable) return true;
  }

  if (preprocessing.rejected || preprocessing.longEdgePx < 640) return true;

  if (requiredFieldStates.length > 0) {
    const absentCount = requiredFieldStates.filter(isFieldAbsent).length;
    // "At least half" without floating-point division: absentCount / total
    // >= 1/2 iff absentCount * 2 >= total.
    if (absentCount * 2 >= requiredFieldStates.length) return true;
  }

  return false;
}

/** Inputs `isConflictingExtraction` needs, gathered once by the caller
 * (`index.ts`) so this function stays a plain boolean combination. */
export interface ConflictingExtractionInputs {
  /** One entry per field the §4.4 overrides ran on — the five
   * value/evidence/confidence fields plus `government_warning`. */
  fieldOverrideRejections: boolean[];
  imageQualityConfidenceInvalid: boolean;
  warningPresentTranscriptionDisagree: boolean;
  /** `beverage_type.value` disagrees with the application's declared
   * beverage type, at `>= 0.85` confidence (CP-1 §5.3's free cross-check).
   * Computed by the caller from the RAW extraction — this is a self-
   * consistency check, independent of the §4.4 overrides. */
  beverageTypeDisagreesWithApplication: boolean;
}

/** `CONFLICTING_EXTRACTION` (CP-1 §5.3). */
export function isConflictingExtraction(inputs: ConflictingExtractionInputs): boolean {
  return (
    inputs.fieldOverrideRejections.some(Boolean) ||
    inputs.imageQualityConfidenceInvalid ||
    inputs.warningPresentTranscriptionDisagree ||
    inputs.beverageTypeDisagreesWithApplication
  );
}

/** `government_warning.present` and `.transcription` disagree with each
 * other (CP-1 §5.3): `present === false` with non-empty `transcription`, or
 * the reverse. Operates on the RAW extracted values, not the sanitized
 * ones — this checks the extractor's own self-consistency, independent of
 * whether the evidence separately supports the transcription. */
export function warningPresentTranscriptionDisagree(present: boolean, transcription: string | null): boolean {
  const transcriptionNonEmpty = transcription !== null && transcription.length > 0;
  if (present === false && transcriptionNonEmpty) return true;
  if (present === true && !transcriptionNonEmpty) return true;
  return false;
}
