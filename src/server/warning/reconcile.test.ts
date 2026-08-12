/**
 * Tests for the dual/single-channel reconciliation (LH-020 / TRO-468, CP-2
 * §4.5, §6, §7.1, TH-R9). Written before `reconcile.ts` — TDD, PRD §6.
 *
 * CP-2 §9.2 finding 3: "no case exercises channel disagreement, and no
 * image can... LH-020 covers it with unit tests over synthetic candidate
 * pairs" — that is exactly what this file is. There is no golden-set image
 * for these; they are built directly from CP-2's own decision tables.
 */
import { describe, expect, it } from "vitest";
import { CANONICAL_WARNING_TEXT } from "./canonical";
import {
  OCR_CONFIDENCE_FLOOR,
  reconcileWarningChannels,
  SINGLE_CHANNEL_PASS_CONFIDENCE,
  type OcrChannelInput,
  type VlmWarningCandidate,
} from "./reconcile";
import type { WarningComparatorResult } from "../router/types";

/** `WarningComparatorResult` is a discriminated union — `.reviewReason`
 * only exists on the `NEEDS_REVIEW` branch (standing rule 19). This
 * narrows it for the rest of a test, the same way production code must. */
function assertNeedsReview(
  result: WarningComparatorResult,
): asserts result is Extract<WarningComparatorResult, { verdict: "NEEDS_REVIEW" }> {
  expect(result.verdict).toBe("NEEDS_REVIEW");
}

const TITLE_CASE_TEXT =
  "Government Warning: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

const LOWER_SURGEON_GENERAL_TEXT =
  "GOVERNMENT WARNING: (1) According to the surgeon general, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

const MISSING_COMMA_TEXT =
  "GOVERNMENT WARNING: (1) According to the Surgeon General women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

const REWORDED_TEXT =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, pregnant women should not consume alcoholic beverages due to the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

const GARBLED_TEXT = "GOVERNMENT WARNIN6: (1 Aceordng to Ihe Sur9eon Genera1...";

function vlm(transcription: string, overrides: Partial<VlmWarningCandidate> = {}): VlmWarningCandidate {
  return { transcription, prefixCasing: "ALL_CAPS", confidence: 0.95, ...overrides };
}

const OCR_UNAVAILABLE: OcrChannelInput = { available: false };
function ocr(text: string, confidence = 90): OcrChannelInput {
  return { available: true, text, confidence };
}

describe("reconcileWarningChannels — dual-channel, both channels agree (CP-2 §4.5's table)", () => {
  it("agree + exact match -> MATCH", () => {
    const result = reconcileWarningChannels(vlm(CANONICAL_WARNING_TEXT), ocr(CANONICAL_WARNING_TEXT));
    expect(result).toEqual({ verdict: "MATCH", note: "Government Warning matches the required text." });
  });

  it("agree + both title-case prefix -> MISMATCH, capitalization reason (golden-set case-08/09 shape)", () => {
    const result = reconcileWarningChannels(vlm(TITLE_CASE_TEXT, { prefixCasing: "TITLE_CASE" }), ocr(TITLE_CASE_TEXT));
    expect(result.verdict).toBe("MISMATCH");
    expect(result.note).toBe("Government Warning must print in capital letters.");
  });

  it("agree + both lower-case surgeon/general -> MISMATCH, Surgeon General reason (CP-2 §2.6's named mistake)", () => {
    const result = reconcileWarningChannels(vlm(LOWER_SURGEON_GENERAL_TEXT), ocr(LOWER_SURGEON_GENERAL_TEXT));
    expect(result.verdict).toBe("MISMATCH");
    expect(result.note).toBe("Surgeon General must print with capital letters.");
  });

  it("agree + near miss (both read the same missing comma) -> NEEDS_REVIEW WARNING_MISMATCH, not FAIL", () => {
    const result = reconcileWarningChannels(vlm(MISSING_COMMA_TEXT), ocr(MISSING_COMMA_TEXT));
    expect(result).toEqual({
      verdict: "NEEDS_REVIEW",
      reviewReason: "WARNING_MISMATCH",
      note: "Government Warning differs by a single character — needs a closer look.",
    });
  });

  it("agree + genuine rewording (both channels read the identical deviation) -> MISMATCH", () => {
    // CP-2 §4.5's own rationale for this row: "two independent readers
    // found the same deviation... does not happen twice, identically, in
    // two unrelated engines."
    const result = reconcileWarningChannels(vlm(REWORDED_TEXT), ocr(REWORDED_TEXT));
    expect(result.verdict).toBe("MISMATCH");
    expect(result.note).toBe("Government Warning wording differs from the required text.");
  });
});

describe("reconcileWarningChannels — dual-channel, channels disagree (CP-2 §4.5, §9.2 finding 3)", () => {
  it("disagree, exactly one equals canonical -> NEEDS_REVIEW, never a pass on the agreeing channel (CP-2 §10 Q4)", () => {
    const result = reconcileWarningChannels(vlm(CANONICAL_WARNING_TEXT), ocr(GARBLED_TEXT));
    expect(result).toEqual({
      verdict: "NEEDS_REVIEW",
      reviewReason: "WARNING_MISMATCH",
      note: "Government Warning could not be read consistently.",
    });
  });

  it("disagree, neither equals canonical -> NEEDS_REVIEW", () => {
    const result = reconcileWarningChannels(vlm(REWORDED_TEXT), ocr(GARBLED_TEXT));
    assertNeedsReview(result);
    expect(result.reviewReason).toBe("WARNING_MISMATCH");
  });

  it("disagree on capitalization alone (same words, different caps) -> NEEDS_REVIEW", () => {
    // CP-2 §4.5: agreement needs BOTH the words AND the caps verdict to
    // match — a body-only agreement test would wrongly call these two
    // "agreeing".
    const result = reconcileWarningChannels(vlm(CANONICAL_WARNING_TEXT), ocr(TITLE_CASE_TEXT));
    assertNeedsReview(result);
    expect(result.reviewReason).toBe("WARNING_MISMATCH");
  });
});

describe("reconcileWarningChannels — single channel: OCR unavailable (CP-2 §4.5's single-channel table)", () => {
  it("VLM exact match at confidence >= 0.90 -> MATCH", () => {
    const result = reconcileWarningChannels(vlm(CANONICAL_WARNING_TEXT, { confidence: 0.9 }), OCR_UNAVAILABLE);
    expect(result).toEqual({ verdict: "MATCH", note: "Government Warning matches the required text." });
  });

  it("VLM exact match below 0.90 confidence -> NEEDS_REVIEW LOW_IMAGE_QUALITY", () => {
    const result = reconcileWarningChannels(vlm(CANONICAL_WARNING_TEXT, { confidence: 0.89 }), OCR_UNAVAILABLE);
    expect(result).toEqual({
      verdict: "NEEDS_REVIEW",
      reviewReason: "LOW_IMAGE_QUALITY",
      note: "Government Warning is not clear enough in this image.",
    });
  });

  it("VLM near-miss (single channel) -> NEEDS_REVIEW, never FAIL — 'we never accuse on one channel'", () => {
    const result = reconcileWarningChannels(vlm(MISSING_COMMA_TEXT, { confidence: 0.99 }), OCR_UNAVAILABLE);
    assertNeedsReview(result);
    expect(result.reviewReason).toBe("WARNING_MISMATCH");
    // The near-miss note stays precise and distance-based even on one
    // channel — CP-2 §5.5's band describes what was found, not how many
    // readers found it.
    expect(result.note).toBe("Government Warning differs by a single character — needs a closer look.");
  });

  it("VLM caps failure (single channel, title case) -> NEEDS_REVIEW, NEVER a hard FAIL", () => {
    // CP-2 §7.1: "the agreement rule requires both channels to produce the
    // same capitalization verdict before either is trusted" — one channel
    // alone cannot make a caps violation a FAIL.
    const result = reconcileWarningChannels(vlm(TITLE_CASE_TEXT, { prefixCasing: "TITLE_CASE", confidence: 0.99 }), OCR_UNAVAILABLE);
    assertNeedsReview(result);
    expect(result.reviewReason).toBe("WARNING_MISMATCH");
    expect(result.note).toBe("Government Warning could not be confirmed from this image alone.");
  });

  it("VLM genuine mismatch (single channel) -> NEEDS_REVIEW, never FAIL", () => {
    const result = reconcileWarningChannels(vlm(REWORDED_TEXT, { confidence: 0.99 }), OCR_UNAVAILABLE);
    assertNeedsReview(result);
    expect(result.reviewReason).toBe("WARNING_MISMATCH");
    expect(result.note).toBe("Government Warning could not be confirmed from this image alone.");
  });

  it("never returns a MISMATCH verdict on a single channel, across every scenario above", () => {
    const scenarios: Array<[VlmWarningCandidate, OcrChannelInput]> = [
      [vlm(TITLE_CASE_TEXT, { prefixCasing: "TITLE_CASE", confidence: 0.99 }), OCR_UNAVAILABLE],
      [vlm(REWORDED_TEXT, { confidence: 0.99 }), OCR_UNAVAILABLE],
      [vlm(LOWER_SURGEON_GENERAL_TEXT, { confidence: 0.99 }), OCR_UNAVAILABLE],
      [vlm(MISSING_COMMA_TEXT, { confidence: 0.99 }), OCR_UNAVAILABLE],
    ];
    for (const [vlmCandidate, ocrInput] of scenarios) {
      expect(reconcileWarningChannels(vlmCandidate, ocrInput).verdict).not.toBe("MISMATCH");
    }
  });
});

describe("reconcileWarningChannels — OCR below the confidence floor is treated as unavailable", () => {
  it(`OCR confidence below ${OCR_CONFIDENCE_FLOOR} falls back to single-channel rules`, () => {
    // OCR reads something that would disagree if trusted — but it is
    // below the floor, so the VLM channel alone decides.
    const result = reconcileWarningChannels(
      vlm(CANONICAL_WARNING_TEXT, { confidence: 0.95 }),
      ocr(GARBLED_TEXT, OCR_CONFIDENCE_FLOOR - 1),
    );
    expect(result).toEqual({ verdict: "MATCH", note: "Government Warning matches the required text." });
  });

  it(`OCR confidence at or above ${OCR_CONFIDENCE_FLOOR} is trusted as a real second channel`, () => {
    const result = reconcileWarningChannels(
      vlm(CANONICAL_WARNING_TEXT, { confidence: 0.95 }),
      ocr(GARBLED_TEXT, OCR_CONFIDENCE_FLOOR),
    );
    expect(result.verdict).toBe("NEEDS_REVIEW"); // now a real disagreement
  });
});

describe("reconcileWarningChannels — CP-2 §7.1's prefix_casing cross-check", () => {
  it("derived ALL_CAPS but model reports TITLE_CASE -> downgrades a would-be MATCH to NEEDS_REVIEW", () => {
    const result = reconcileWarningChannels(
      vlm(CANONICAL_WARNING_TEXT, { prefixCasing: "TITLE_CASE" }),
      ocr(CANONICAL_WARNING_TEXT),
    );
    assertNeedsReview(result);
    expect(result.reviewReason).toBe("WARNING_MISMATCH");
    expect(result.note).toBe("Government Warning could not be read consistently.");
  });

  it("derived NOT all-caps but model reports ALL_CAPS -> downgrades a would-be FAIL to NEEDS_REVIEW", () => {
    const result = reconcileWarningChannels(vlm(TITLE_CASE_TEXT, { prefixCasing: "ALL_CAPS" }), ocr(TITLE_CASE_TEXT));
    assertNeedsReview(result);
    expect(result.reviewReason).toBe("WARNING_MISMATCH");
  });

  it("agreement between derived and reported casing changes nothing", () => {
    const result = reconcileWarningChannels(vlm(CANONICAL_WARNING_TEXT, { prefixCasing: "ALL_CAPS" }), ocr(CANONICAL_WARNING_TEXT));
    expect(result.verdict).toBe("MATCH");
  });

  it("NOT_VISIBLE is not a claim, so it cannot disagree with one — a would-be MATCH stays MATCH", () => {
    // CodeRabbit review round 1 (TRO-468): the first draft of this check
    // treated NOT_VISIBLE as an active "not ALL_CAPS" vote, so a correct,
    // confident derived read got flagged as inconsistent whenever the
    // model merely abstained from judging casing. NOT_VISIBLE means "I
    // could not tell," not "it is not all-caps" — it should never move
    // the verdict, in either direction (the next test covers the other
    // direction).
    const result = reconcileWarningChannels(
      vlm(CANONICAL_WARNING_TEXT, { prefixCasing: "NOT_VISIBLE" }),
      ocr(CANONICAL_WARNING_TEXT),
    );
    expect(result.verdict).toBe("MATCH");
  });

  it("NOT_VISIBLE also does not rescue a would-be FAIL into REVIEW", () => {
    const result = reconcileWarningChannels(vlm(TITLE_CASE_TEXT, { prefixCasing: "NOT_VISIBLE" }), ocr(TITLE_CASE_TEXT));
    expect(result.verdict).toBe("MISMATCH");
  });

  it("OTHER, unlike NOT_VISIBLE, is a real competing claim and still participates in the cross-check", () => {
    const result = reconcileWarningChannels(vlm(CANONICAL_WARNING_TEXT, { prefixCasing: "OTHER" }), ocr(CANONICAL_WARNING_TEXT));
    assertNeedsReview(result);
    expect(result.reviewReason).toBe("WARNING_MISMATCH");
  });
});

describe("reconcileWarningChannels — never produces a reason this comparator's type does not permit (CP-2 §6.2)", () => {
  it("never returns CONFLICTING_EXTRACTION or LOW_MODEL_CONFIDENCE as a reviewReason", () => {
    const scenarios: Array<[VlmWarningCandidate, OcrChannelInput]> = [
      [vlm(CANONICAL_WARNING_TEXT), OCR_UNAVAILABLE],
      [vlm(TITLE_CASE_TEXT, { prefixCasing: "TITLE_CASE" }), ocr(TITLE_CASE_TEXT)],
      [vlm(REWORDED_TEXT), ocr(REWORDED_TEXT)],
      [vlm(MISSING_COMMA_TEXT), ocr(MISSING_COMMA_TEXT)],
      [vlm(CANONICAL_WARNING_TEXT), ocr(GARBLED_TEXT)],
      [vlm(REWORDED_TEXT, { confidence: 0.99 }), OCR_UNAVAILABLE],
    ];
    for (const [vlmCandidate, ocrInput] of scenarios) {
      const result = reconcileWarningChannels(vlmCandidate, ocrInput);
      if (result.verdict === "NEEDS_REVIEW") {
        expect(result.reviewReason).not.toBe("CONFLICTING_EXTRACTION");
        expect(result.reviewReason).not.toBe("LOW_MODEL_CONFIDENCE");
        expect(result.reviewReason).not.toBe("MISSING_REQUIRED_FIELD"); // absence is the router's job, not this one's
      }
    }
  });
});

describe("SINGLE_CHANNEL_PASS_CONFIDENCE — CP-1 §4.2's warning-transcription trusted threshold", () => {
  it("is 0.90", () => {
    expect(SINGLE_CHANNEL_PASS_CONFIDENCE).toBe(0.9);
  });
});
