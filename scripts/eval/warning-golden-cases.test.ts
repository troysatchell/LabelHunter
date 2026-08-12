/**
 * Golden-set warning-variant coverage the eval harness relies on (TRO-469 /
 * LH-021, TH-R9, TH-R12, TH-R17).
 *
 * Two jobs, deliberately kept separate from `src/server/warning/golden-case.test.ts`
 * (LH-020/TRO-468's own comparator-level suite, out of this ticket's scope
 * to edit):
 *
 * 1. Prove the "Jenny title-case catch is a named case" (this ticket's own
 *    one-line brief) at the EVAL-HARNESS boundary specifically — the
 *    golden set is present, the default `--live` sample always includes
 *    it (`args.ts`), and the real comparator (imported, not reimplemented)
 *    agrees with the manifest's own ground truth.
 * 2. Prove the two new cases this ticket adds (case-30, case-31 — CP-2
 *    §9.2 findings 4 and 5, `docs/checkpoints/cp2-warning-subsystem.md`
 *    §9.2/§11 open question 9) are computationally correct, not just
 *    hand-asserted: the manifest's `expected` block must match what
 *    `reconcileWarningChannels` actually computes for the exact text each
 *    case carries. A manifest edit that drifts the ground truth fails
 *    here, the same property `src/server/warning/golden-case.test.ts`
 *    already gives case-08/09/10/11.
 *
 * "Both channels read the ground truth" is the correct simulation, not a
 * shortcut — see `src/server/warning/golden-case.test.ts`'s own header
 * comment for the full argument (CP-2 §4.5's dual-channel table only
 * reaches FAIL/MISMATCH in the "agree" branch; a real OCR engine reading
 * the same physical, legible label would in fact read the same text the
 * VLM does).
 */
import { describe, expect, it } from "vitest";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import type { WarningPrefixCasing } from "../../src/server/extractor/types";
import { evaluateCandidate, reconcileWarningChannels, type VlmWarningCandidate } from "../../src/server/warning";
import { DEFAULT_SAMPLE_CASE_IDS } from "./args";

const manifest = loadGoldenSetManifest();

function findCase(caseId: string) {
  const found = manifest.cases.find((c) => c.caseId === caseId);
  if (!found) throw new Error(`golden-set manifest is missing ${caseId}`);
  return found;
}

/** Builds a dual-channel-agreeing pair from one case's ground truth and
 * returns the reconciled result — same construction as
 * `src/server/warning/golden-case.test.ts`'s own `reconcileCase`. */
function reconcileCase(caseId: string, prefixCasing: WarningPrefixCasing, confidence = 0.97) {
  const goldenCase = findCase(caseId);
  const text = goldenCase.label.governmentWarningText;
  const vlm: VlmWarningCandidate = { transcription: text, prefixCasing, confidence };
  return { goldenCase, result: reconcileWarningChannels(vlm, { available: true, text, confidence: 92 }) };
}

describe("case-08-title-case-warning-prefix-only — Jenny's named catch (TH-R9)", () => {
  it("is present in the golden set, named as Jenny's catch, with the title-case-warning category", () => {
    const goldenCase = findCase("case-08-title-case-warning-prefix-only");
    expect(goldenCase.category).toBe("title-case-warning");
    expect(goldenCase.notes).toMatch(/Jenny/);
    expect(goldenCase.label.governmentWarningPrefixAllCaps).toBe(false);
  });

  it("is always exercised by the default --live sample, never opt-in only (args.ts)", () => {
    expect(DEFAULT_SAMPLE_CASE_IDS).toContain("case-08-title-case-warning-prefix-only");
  });

  it("MISMATCHes against the real comparator, matching the manifest's own expected verdict", () => {
    const { goldenCase, result } = reconcileCase("case-08-title-case-warning-prefix-only", "TITLE_CASE");
    expect(result.verdict).toBe(goldenCase.expected.fields.governmentWarning.verdict);
    expect(result.verdict).toBe("MISMATCH");
  });
});

describe("case-09-title-case-warning-full-statement — CP-2 §9.2 finding 2: a caps failure, not a wording one", () => {
  it("expected.fields.governmentWarning.reason names the capitalization rule, not the wording rule", () => {
    const goldenCase = findCase("case-09-title-case-warning-full-statement");
    const reason = goldenCase.expected.fields.governmentWarning.reason;
    expect(reason).toMatch(/capital/i);
    expect(reason).not.toMatch(/wording must match/i);
  });

  it("is a genuine EXACT_MATCH on wording once case is folded — only the caps check catches it (CP-2 §5.4)", () => {
    const text = findCase("case-09-title-case-warning-full-statement").label.governmentWarningText;
    expect(evaluateCandidate(text).wording).toBe("EXACT_MATCH");
  });
});

describe("case-23/case-24 (tiny warning text) — CP-2 §9.2 finding 1: LOW_IMAGE_QUALITY, not LOW_MODEL_CONFIDENCE", () => {
  it("both cases expect a reviewReason resolveGovernmentWarningField/WarningComparatorResult can actually produce", () => {
    for (const caseId of ["case-23-tiny-warning-text-standard-bottle", "case-24-tiny-warning-text-miniature-bottle"]) {
      const goldenCase = findCase(caseId);
      expect(goldenCase.expected.reviewReason, `${caseId} expected.reviewReason`).toBe("LOW_IMAGE_QUALITY");
    }
  });
});

describe("case-30 (new) — CP-2 §9.2 finding 5 / §11 open question 9: surgeon general in lower case", () => {
  it("is present, category title-case-warning, vector V2", () => {
    const goldenCase = findCase("case-30-title-case-warning-surgeon-general-lowercase");
    expect(goldenCase.category).toBe("title-case-warning");
    expect(goldenCase.vectors).toContain("V2");
  });

  it("isolates the defect to Surgeon/General ONLY — the GOVERNMENT WARNING prefix stays all-caps", () => {
    const goldenCase = findCase("case-30-title-case-warning-surgeon-general-lowercase");
    expect(goldenCase.label.governmentWarningPrefixAllCaps).toBe(true);
    expect(goldenCase.label.governmentWarningText).toContain("GOVERNMENT WARNING:");
    expect(goldenCase.label.governmentWarningText).toContain("surgeon general");
    expect(goldenCase.label.governmentWarningText).not.toContain("Surgeon General");
  });

  it("MISMATCHes on capitalization against the real comparator — 'Surgeon General must print with capital letters.'", () => {
    const { goldenCase, result } = reconcileCase("case-30-title-case-warning-surgeon-general-lowercase", "ALL_CAPS");
    expect(result.verdict).toBe(goldenCase.expected.fields.governmentWarning.verdict);
    expect(result.verdict).toBe("MISMATCH");
    expect(result.note).toBe("Surgeon General must print with capital letters.");
  });

  it("is otherwise a wording EXACT_MATCH — the caps check is the only thing that catches it (same shape as case-08/09)", () => {
    const text = findCase("case-30-title-case-warning-surgeon-general-lowercase").label.governmentWarningText;
    expect(evaluateCandidate(text).wording).toBe("EXACT_MATCH");
  });
});

describe("case-31 (new) — CP-2 §9.2 finding 4 / §11 open question 9: the near-miss band, comma after General removed", () => {
  it("is present, category reworded-warning", () => {
    const goldenCase = findCase("case-31-reworded-warning-near-miss-missing-comma");
    expect(goldenCase.category).toBe("reworded-warning");
  });

  it("is a genuine distance-1 near miss, not an exact match and not a plain mismatch", () => {
    const text = findCase("case-31-reworded-warning-near-miss-missing-comma").label.governmentWarningText;
    const evaluation = evaluateCandidate(text);
    expect(evaluation.distance).toBe(1);
    expect(evaluation.wording).toBe("NEAR_MISS");
  });

  it("routes to REVIEW/WARNING_MISMATCH against the real comparator, never a hard FAIL — CP-2 §5.5 guard: near-miss never turns into MISMATCH", () => {
    const { goldenCase, result } = reconcileCase("case-31-reworded-warning-near-miss-missing-comma", "ALL_CAPS");
    expect(goldenCase.expected.labelVerdict).toBe("REVIEW");
    expect(goldenCase.expected.reviewReason).toBe("WARNING_MISMATCH");
    expect(result.verdict).toBe(goldenCase.expected.fields.governmentWarning.verdict);
    expect(result.verdict).toBe("NEEDS_REVIEW");
    if (result.verdict === "NEEDS_REVIEW") {
      expect(result.reviewReason).toBe("WARNING_MISMATCH");
    }
    expect(result.note).toBe("Government Warning differs by a single character — needs a closer look.");
  });

  it("caps positions are all clean — the defect is wording distance alone, isolating the near-miss band", () => {
    const text = findCase("case-31-reworded-warning-near-miss-missing-comma").label.governmentWarningText;
    expect(evaluateCandidate(text).caps).toEqual({ government: "OK", warning: "OK", surgeon: "OK", general: "OK" });
  });
});

describe("the golden set covers all three of TH-R9's acceptance-evidence cases end to end", () => {
  it("exact warning -> PASS, title-case -> FAIL, reworded -> FAIL, each via the real comparator", () => {
    expect(reconcileCase("case-01-clean-match-spirits", "ALL_CAPS").result.verdict).toBe("MATCH");
    expect(reconcileCase("case-08-title-case-warning-prefix-only", "TITLE_CASE").result.verdict).toBe("MISMATCH");
    expect(reconcileCase("case-10-reworded-warning-clause-one", "ALL_CAPS").result.verdict).toBe("MISMATCH");
  });
});
