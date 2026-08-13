import { describe, expect, it } from "vitest";
import type { VerdictCaseScore, VerdictFieldScore } from "./types";
import { segmentWarningCheckOutcomes } from "./warning-segmentation";

/** A minimal `VerdictCaseScore` carrying only what `segmentWarningCheckOutcomes`
 * reads: the `government_warning` field's actual verdict and, when it is
 * `NEEDS_REVIEW`, its actual reviewReason — plus, since TRO-535 / LH-030b,
 * the case-level `warningChannel` `singleChannelPass` also reads. The other
 * four router fields are filled with an unrelated, always-correct MATCH row
 * so a case looks like a real `VerdictCaseScore` (`scoreVerdict`'s own
 * contract: one entry per `RouterFieldKey`) without this file having to
 * restate every field's shape for every test. */
function caseWithWarningOutcome(
  caseId: string,
  warningField: Pick<VerdictFieldScore, "actualVerdict" | "actualReviewReason">,
  warningChannel: VerdictCaseScore["warningChannel"] = null,
): VerdictCaseScore {
  const otherField: VerdictFieldScore = {
    field: "brand_name",
    expectedVerdict: "MATCH",
    actualVerdict: "MATCH",
    correct: true,
    confidence: 0.9,
    actualReviewReason: null,
  };
  return {
    caseId,
    category: "clean-match",
    expectedLabelVerdict: "PASS",
    actualLabelVerdict: "PASS",
    labelVerdictCorrect: true,
    expectedReviewReason: null,
    actualReviewReason: null,
    reviewReasonCorrect: true,
    warningChannel,
    lowImageQualityTrigger: null,
    fields: [
      otherField,
      {
        field: "government_warning",
        expectedVerdict: "MATCH",
        actualVerdict: warningField.actualVerdict,
        correct: true,
        confidence: 0.9,
        actualReviewReason: warningField.actualReviewReason,
      },
    ],
  };
}

function clean(caseId: string, warningChannel: VerdictCaseScore["warningChannel"] = null): VerdictCaseScore {
  return caseWithWarningOutcome(caseId, { actualVerdict: "MATCH", actualReviewReason: null }, warningChannel);
}

function trueMismatch(caseId: string): VerdictCaseScore {
  return caseWithWarningOutcome(caseId, { actualVerdict: "MISMATCH", actualReviewReason: null });
}

function resolutionSuspect(
  caseId: string,
  reviewReason: VerdictFieldScore["actualReviewReason"],
  warningChannel: VerdictCaseScore["warningChannel"] = null,
): VerdictCaseScore {
  return caseWithWarningOutcome(caseId, { actualVerdict: "NEEDS_REVIEW", actualReviewReason: reviewReason }, warningChannel);
}

function notFound(caseId: string): VerdictCaseScore {
  return caseWithWarningOutcome(caseId, { actualVerdict: "NEEDS_REVIEW", actualReviewReason: "MISSING_REQUIRED_FIELD" });
}

describe("segmentWarningCheckOutcomes", () => {
  it("classifies a MATCH verdict as clean", () => {
    const result = segmentWarningCheckOutcomes([clean("a")]);
    expect(result.clean).toEqual({ count: 1, rate: 1 });
    expect(result.trueMismatch).toEqual({ count: 0, rate: 0 });
    expect(result.resolutionSuspect).toEqual({ count: 0, rate: 0 });
    expect(result.notFound).toEqual({ count: 0, rate: 0 });
    expect(result.total).toBe(1);
  });

  it("classifies a MISMATCH verdict as true mismatch — CP-2 §8.4: 'NOT an upgrade signal, no matter how frequent'", () => {
    const result = segmentWarningCheckOutcomes([trueMismatch("a"), trueMismatch("b")]);
    expect(result.trueMismatch).toEqual({ count: 2, rate: 1 });
    expect(result.resolutionSuspect).toEqual({ count: 0, rate: 0 });
  });

  it("classifies NEEDS_REVIEW/LOW_IMAGE_QUALITY as resolution-suspect — CP-2 §8.4's own named row", () => {
    const result = segmentWarningCheckOutcomes([resolutionSuspect("a", "LOW_IMAGE_QUALITY")]);
    expect(result.resolutionSuspect).toEqual({ count: 1, rate: 1 });
  });

  it("classifies NEEDS_REVIEW/WARNING_MISMATCH as resolution-suspect — CP-2 §8.4's 'channels disagree; near-miss band' row", () => {
    const result = segmentWarningCheckOutcomes([resolutionSuspect("a", "WARNING_MISMATCH")]);
    expect(result.resolutionSuspect).toEqual({ count: 1, rate: 1 });
  });

  it("classifies NEEDS_REVIEW/CONFLICTING_EXTRACTION as resolution-suspect — resolveGovernmentWarningField's overrideRejected branch, outside WarningComparatorResult's own union (CP-2 §6.2)", () => {
    const result = segmentWarningCheckOutcomes([resolutionSuspect("a", "CONFLICTING_EXTRACTION")]);
    expect(result.resolutionSuspect).toEqual({ count: 1, rate: 1 });
  });

  it("classifies NEEDS_REVIEW/LOW_MODEL_CONFIDENCE as resolution-suspect — resolveGovernmentWarningField's defensive no-comparator-result fallback", () => {
    const result = segmentWarningCheckOutcomes([resolutionSuspect("a", "LOW_MODEL_CONFIDENCE")]);
    expect(result.resolutionSuspect).toEqual({ count: 1, rate: 1 });
  });

  it("classifies NEEDS_REVIEW/MISSING_REQUIRED_FIELD as not-found, never resolution-suspect — CP-2 §8.4: 'no model upgrade finds a warning that is not in the photograph'", () => {
    const result = segmentWarningCheckOutcomes([notFound("a")]);
    expect(result.notFound).toEqual({ count: 1, rate: 1 });
    expect(result.resolutionSuspect).toEqual({ count: 0, rate: 0 });
  });

  it("throws on a NEEDS_REVIEW outcome with a reviewReason this field never carries (a wiring bug, not a real outcome)", () => {
    const bogus = segmentWarningCheckOutcomes.bind(null, [resolutionSuspect("a", "AMBIGUOUS_BRAND")]);
    expect(bogus).toThrow(/AMBIGUOUS_BRAND/);
  });

  it("classifies a NEEDS_REVIEW outcome with a NULL reviewReason as resolution-suspect, never a throw — a real, observed case (case-20's --live --full run), not a hypothetical", () => {
    // resolveGovernmentWarningField's own carve-out (CP-1 §5.3): an absent,
    // required warning on a label that ALREADY carries a LOW_IMAGE_QUALITY
    // blocker resolves to NEEDS_REVIEW with reviewReason: null, to avoid a
    // redundant MISSING_REQUIRED_FIELD alongside the label-level reason.
    // That state is definitionally tied to LOW_IMAGE_QUALITY, so it belongs
    // in the SAME class LOW_IMAGE_QUALITY itself lands in.
    const result = segmentWarningCheckOutcomes([resolutionSuspect("a", null)]);
    expect(result.resolutionSuspect).toEqual({ count: 1, rate: 1 });
    expect(result.notFound).toEqual({ count: 0, rate: 0 });
  });

  it("computes every rate against the SAME denominator (CP-2 §8.4's written formula: resolution-suspect / (clean + true-mismatch + resolution-suspect + not-found))", () => {
    const result = segmentWarningCheckOutcomes([
      clean("a"),
      clean("b"),
      trueMismatch("c"),
      resolutionSuspect("d", "LOW_IMAGE_QUALITY"),
      notFound("e"),
    ]);
    expect(result.total).toBe(5);
    expect(result.clean).toEqual({ count: 2, rate: 0.4 });
    expect(result.trueMismatch).toEqual({ count: 1, rate: 0.2 });
    expect(result.resolutionSuspect).toEqual({ count: 1, rate: 0.2 });
    expect(result.notFound).toEqual({ count: 1, rate: 0.2 });
  });

  it("the four classes are mutually exclusive and exhaustive: their counts always sum to total (CP-2 §8.4's own summing assertion, 'LH-030 asserts that sum')", () => {
    const cases = [
      clean("a"),
      clean("b"),
      clean("c"),
      trueMismatch("d"),
      resolutionSuspect("e", "LOW_IMAGE_QUALITY"),
      resolutionSuspect("f", "WARNING_MISMATCH"),
      notFound("g"),
    ];
    const result = segmentWarningCheckOutcomes(cases);
    const sum = result.clean.count + result.trueMismatch.count + result.resolutionSuspect.count + result.notFound.count;
    expect(sum).toBe(result.total);
    expect(result.total).toBe(cases.length);
  });

  it("returns an all-zero, rate-0 summary on an empty run, never NaN", () => {
    const result = segmentWarningCheckOutcomes([]);
    expect(result.total).toBe(0);
    expect(result.clean).toEqual({ count: 0, rate: 0 });
    expect(result.trueMismatch).toEqual({ count: 0, rate: 0 });
    expect(result.resolutionSuspect).toEqual({ count: 0, rate: 0 });
    expect(result.notFound).toEqual({ count: 0, rate: 0 });
    expect(result.singleChannelPass).toEqual({ count: 0, rate: 0 });
  });

  it("throws a clear error naming the case when a case has no government_warning field score at all", () => {
    const malformed: VerdictCaseScore = { ...clean("a"), fields: [] };
    expect(() => segmentWarningCheckOutcomes([malformed])).toThrow(/"a".*government_warning/);
  });
});

describe("segmentWarningCheckOutcomes — singleChannelPass (TRO-535 / LH-030b, CP-2 §8.4's residual false-PASS exposure)", () => {
  it("counts a clean pass whose warningChannel is 'single' — the exact shape CP-2 §10 Q7 names: one confident VLM reading, no OCR to disagree with it", () => {
    const result = segmentWarningCheckOutcomes([clean("a", "single")]);
    expect(result.clean).toEqual({ count: 1, rate: 1 });
    expect(result.singleChannelPass).toEqual({ count: 1, rate: 1 });
  });

  it("does not count a dual-channel clean pass — two channels agreeing is not the residual-exposure shape", () => {
    const result = segmentWarningCheckOutcomes([clean("a", "dual")]);
    expect(result.clean).toEqual({ count: 1, rate: 1 });
    expect(result.singleChannelPass).toEqual({ count: 0, rate: 0 });
  });

  it("does not count a single-channel outcome that is not a clean pass — only a CLEAN verdict on a single channel counts, per CP-2 §8.4: 'counted as clean passes and also reported as their own rate'", () => {
    const result = segmentWarningCheckOutcomes([resolutionSuspect("a", "WARNING_MISMATCH", "single")]);
    expect(result.resolutionSuspect).toEqual({ count: 1, rate: 1 });
    expect(result.singleChannelPass).toEqual({ count: 0, rate: 0 });
  });

  it("shares the SAME denominator (total) as the four partition classes, stated explicitly because CP-2 §8.4 states one for the suspect rate only", () => {
    const result = segmentWarningCheckOutcomes([
      clean("a", "single"),
      clean("b", "dual"),
      trueMismatch("c"),
      notFound("d"),
    ]);
    expect(result.total).toBe(4);
    expect(result.singleChannelPass).toEqual({ count: 1, rate: 0.25 });
  });

  it("is NOT part of the four-class mutually-exclusive sum — it overlaps 'clean' by construction, not a fifth partition member", () => {
    const cases = [clean("a", "single"), clean("b", "single"), trueMismatch("c")];
    const result = segmentWarningCheckOutcomes(cases);
    const fourClassSum = result.clean.count + result.trueMismatch.count + result.resolutionSuspect.count + result.notFound.count;
    expect(fourClassSum).toBe(result.total); // the real partition still sums to total...
    expect(result.singleChannelPass.count).toBe(2); // ...while singleChannelPass counts inside `clean`, not beside it
  });
});
