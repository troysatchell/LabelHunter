import { describe, expect, it } from "vitest";
import type { ExtractedImageQuality } from "../extractor/types";
import type { FieldState } from "./field-state";
import { isConflictingExtraction, isLowImageQuality, warningPresentTranscriptionDisagree } from "./label-blockers";
import type { PreprocessingSignal } from "./types";

function imageQuality(overrides: Partial<ExtractedImageQuality> = {}): ExtractedImageQuality {
  return { legible: "yes", issues: ["none"], confidence: 0.95, ...overrides };
}

function preprocessing(overrides: Partial<PreprocessingSignal> = {}): PreprocessingSignal {
  return { rejected: false, longEdgePx: 1568, ...overrides };
}

function requiredField(overrides: Partial<FieldState> = {}): FieldState {
  return {
    field: "brand_name",
    requirement: "required",
    required: true,
    value: "Old Tom",
    present: null,
    evidence: "OLD TOM",
    confidence: 0.9,
    overrideRejected: false,
    ...overrides,
  };
}

describe("isLowImageQuality — CP-1 §5.3", () => {
  it("fires when legible is 'no', regardless of everything else", () => {
    const fired = isLowImageQuality(imageQuality({ legible: "no" }), preprocessing(), [requiredField()]);
    expect(fired).toBe(true);
  });

  it("fires when legible is 'partial' and a required field is Unusable (< 0.60)", () => {
    const fields = [requiredField({ confidence: 0.5 })];
    expect(isLowImageQuality(imageQuality({ legible: "partial" }), preprocessing(), fields)).toBe(true);
  });

  it("does not fire for 'partial' alone, when every required field is at least Unusable's floor", () => {
    const fields = [requiredField({ confidence: 0.65 })];
    expect(isLowImageQuality(imageQuality({ legible: "partial" }), preprocessing(), fields)).toBe(false);
  });

  it("fires when preprocessing rejected the image", () => {
    expect(isLowImageQuality(imageQuality(), preprocessing({ rejected: true }), [requiredField()])).toBe(true);
  });

  it("fires when the image's long edge is under 640px", () => {
    expect(isLowImageQuality(imageQuality(), preprocessing({ longEdgePx: 480 }), [requiredField()])).toBe(true);
  });

  it("does not fire at exactly 640px", () => {
    expect(isLowImageQuality(imageQuality(), preprocessing({ longEdgePx: 640 }), [requiredField()])).toBe(false);
  });

  it("fires when at least half of the required fields are absent after overrides", () => {
    const fields = [
      requiredField({ field: "brand_name", value: null }),
      requiredField({ field: "class_type", value: "Bourbon" }),
    ];
    expect(isLowImageQuality(imageQuality(), preprocessing(), fields)).toBe(true);
  });

  it("does not fire when fewer than half of the required fields are absent", () => {
    const fields = [
      requiredField({ field: "brand_name", value: null }),
      requiredField({ field: "class_type", value: "Bourbon" }),
      requiredField({ field: "net_contents", value: "750 mL" }),
    ];
    expect(isLowImageQuality(imageQuality(), preprocessing(), fields)).toBe(false);
  });

  it("is false when nothing above applies", () => {
    expect(isLowImageQuality(imageQuality(), preprocessing(), [requiredField()])).toBe(false);
  });
});

describe("warningPresentTranscriptionDisagree", () => {
  it("agrees: present true with a non-empty transcription", () => {
    expect(warningPresentTranscriptionDisagree(true, "GOVERNMENT WARNING: text")).toBe(false);
  });

  it("agrees: present false with a null transcription", () => {
    expect(warningPresentTranscriptionDisagree(false, null)).toBe(false);
  });

  it("disagrees: present false with a non-empty transcription", () => {
    expect(warningPresentTranscriptionDisagree(false, "GOVERNMENT WARNING: text")).toBe(true);
  });

  it("disagrees: present true with no transcription", () => {
    expect(warningPresentTranscriptionDisagree(true, null)).toBe(true);
    expect(warningPresentTranscriptionDisagree(true, "")).toBe(true);
  });
});

describe("isConflictingExtraction — CP-1 §5.3", () => {
  const cleanInputs = {
    fieldOverrideRejections: [false, false, false, false, false, false],
    imageQualityConfidenceInvalid: false,
    warningPresentTranscriptionDisagree: false,
    beverageTypeDisagreesWithApplication: false,
  };

  it("is false when nothing conflicts", () => {
    expect(isConflictingExtraction(cleanInputs)).toBe(false);
  });

  it("fires when any field's §4.4 overrides rejected it", () => {
    expect(
      isConflictingExtraction({ ...cleanInputs, fieldOverrideRejections: [false, true, false, false, false, false] }),
    ).toBe(true);
  });

  it("fires when image_quality's own confidence is invalid", () => {
    expect(isConflictingExtraction({ ...cleanInputs, imageQualityConfidenceInvalid: true })).toBe(true);
  });

  it("fires when the warning's present/transcription disagree", () => {
    expect(isConflictingExtraction({ ...cleanInputs, warningPresentTranscriptionDisagree: true })).toBe(true);
  });

  it("fires when beverage_type confidently disagrees with the application", () => {
    expect(isConflictingExtraction({ ...cleanInputs, beverageTypeDisagreesWithApplication: true })).toBe(true);
  });
});
