/**
 * Tests for the per-candidate wording-compare primitive (LH-020 / TRO-468,
 * CP-2 §3.3, §5.5). Written before `wording-compare.ts` — TDD, PRD §6.
 *
 * `evaluateCandidate` is CP-2 §3.3's algorithm for ONE candidate: raw ->
 * normalizeTransport -> checkCapitalPositions -> foldCase -> distance vs
 * the folded canonical -> classification. The distances below are measured
 * against this ticket's own implementation (not copied from the design
 * doc) — confirmed to match CP-2 §5.4's own table (case-10: 38, case-11:
 * 24) and §5.6's worked examples (missing comma / singular "defect": 1).
 */
import { describe, expect, it } from "vitest";
import { CANONICAL_WARNING_TEXT } from "./canonical";
import { evaluateCandidate, isExactMatch, NEAR_MISS_MAX_DISTANCE } from "./wording-compare";

describe("evaluateCandidate — the canonical text itself", () => {
  it("is an EXACT_MATCH with distance 0 and all caps positions OK", () => {
    const result = evaluateCandidate(CANONICAL_WARNING_TEXT);
    expect(result.wording).toBe("EXACT_MATCH");
    expect(result.distance).toBe(0);
    expect(result.caps).toEqual({ government: "OK", warning: "OK", surgeon: "OK", general: "OK" });
    expect(isExactMatch(result)).toBe(true);
  });
});

describe("evaluateCandidate — CP-2 §5.6 worked examples that normalize to canonical", () => {
  it("a label that wraps across several lines is an EXACT_MATCH", () => {
    const raw =
      "GOVERNMENT WARNING: (1)\nAccording to the\nSurgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    const result = evaluateCandidate(raw);
    expect(isExactMatch(result)).toBe(true);
  });

  it("a label hyphenated at a line wrap is an EXACT_MATCH", () => {
    const raw =
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic bever-\nages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    expect(isExactMatch(evaluateCandidate(raw))).toBe(true);
  });
});

describe("evaluateCandidate — case-08/case-09 shape: title case (golden set, TH-R9's named catch)", () => {
  it("words match canonical (wording EXACT_MATCH) but caps fails — not an overall exact match", () => {
    const raw =
      "Government Warning: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    const result = evaluateCandidate(raw);
    expect(result.wording).toBe("EXACT_MATCH"); // the WORDS are right — CP-2 §5.4's own point
    expect(result.distance).toBe(0);
    expect(result.caps.government).toBe("WRONG_CASE");
    expect(result.caps.warning).toBe("WRONG_CASE");
    expect(isExactMatch(result)).toBe(false); // but not a real match — caps fails it
  });
});

describe("evaluateCandidate — 'surgeon general' lower case (CP-2 §2.6's named TTB mistake)", () => {
  it("words match, caps fails at surgeon/general specifically", () => {
    const raw =
      "GOVERNMENT WARNING: (1) According to the surgeon general, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    const result = evaluateCandidate(raw);
    expect(result.wording).toBe("EXACT_MATCH");
    expect(result.caps.surgeon).toBe("WRONG_CASE");
    expect(result.caps.general).toBe("WRONG_CASE");
    expect(isExactMatch(result)).toBe(false);
  });
});

describe("evaluateCandidate — the near-miss band (CP-2 §5.5, distance 1-2)", () => {
  it("a missing comma after General is a NEAR_MISS at distance 1 (CP-2 §2.6's boot-camp example)", () => {
    const raw =
      "GOVERNMENT WARNING: (1) According to the Surgeon General women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    const result = evaluateCandidate(raw);
    expect(result.distance).toBe(1);
    expect(result.wording).toBe("NEAR_MISS");
    expect(capsPassesFor(result)).toBe(true);
  });

  it("'birth defect' (singular) is a NEAR_MISS at distance 1 — CP-2 §5.6's own worked example", () => {
    const raw =
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defect. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    const result = evaluateCandidate(raw);
    expect(result.distance).toBe(1);
    expect(result.wording).toBe("NEAR_MISS");
  });

  it("NEAR_MISS_MAX_DISTANCE is 2, per CP-2 §5.5's proposed band, adopted per open question 2", () => {
    expect(NEAR_MISS_MAX_DISTANCE).toBe(2);
  });

  it("distance exactly at the band's edge (2) is still NEAR_MISS", () => {
    // Measured against this ticket's own implementation: appending "xx"
    // to "defects" is a 2-character insertion, distance 2.
    const raw = CANONICAL_WARNING_TEXT.replace("birth defects", "birth defectsxx");
    expect(evaluateCandidate(raw).distance).toBe(2);
    expect(evaluateCandidate(raw).wording).toBe("NEAR_MISS");
  });

  it("distance one past the band's edge (3) is a MISMATCH, not a near miss", () => {
    // Measured: appending "xxx" is a 3-character insertion, distance 3.
    const raw = CANONICAL_WARNING_TEXT.replace("birth defects", "birth defectsxxx");
    expect(evaluateCandidate(raw).distance).toBe(3);
    expect(evaluateCandidate(raw).wording).toBe("MISMATCH");
  });
});

describe("evaluateCandidate — genuine rewordings (golden-set case-10, case-11) are MISMATCH, far outside the band", () => {
  it("case-10 shape: clause (1) reworded, distance 38", () => {
    const raw =
      "GOVERNMENT WARNING: (1) According to the Surgeon General, pregnant women should not consume alcoholic beverages due to the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    const result = evaluateCandidate(raw);
    expect(result.distance).toBe(38);
    expect(result.wording).toBe("MISMATCH");
  });

  it("case-11 shape: clause (2) reworded, distance 24", () => {
    const raw =
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages may impair your ability to operate a vehicle or machinery, and can cause health problems.";
    const result = evaluateCandidate(raw);
    expect(result.distance).toBe(24);
    expect(result.wording).toBe("MISMATCH");
  });
});

describe("isExactMatch — CP-2 §5.5 guard: the band never turns a FAIL into a PASS", () => {
  it("a MISMATCH-distance candidate is never an exact match, however its caps read", () => {
    const raw =
      "GOVERNMENT WARNING: (1) Pregnant people should avoid alcohol due to birth defect risk. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    expect(isExactMatch(evaluateCandidate(raw))).toBe(false);
  });
});

/** Local helper — true when every position is OK. */
function capsPassesFor(result: ReturnType<typeof evaluateCandidate>): boolean {
  return (
    result.caps.government === "OK" &&
    result.caps.warning === "OK" &&
    result.caps.surgeon === "OK" &&
    result.caps.general === "OK"
  );
}
