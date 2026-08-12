/**
 * Tests for the §7.1 capitalization check (LH-020 / TRO-468, CP-2 §5.4,
 * §7.1, TH-R9). Written before `caps.ts` — TDD, PRD §6.
 *
 * Runs on the transport-normalized, CASE-PRESERVING candidate — never on a
 * case-folded string (CP-2 §3.3 point 1). Checks exactly four positions:
 * `GOVERNMENT` and `WARNING` must be fully capitalized (27 CFR
 * 16.22(a)(2)); `Surgeon` and `General` need only their initial letter
 * capitalized (TTB's own checklist, CP-2 §2.6). Case is folded everywhere
 * else — this module checks nothing beyond these four positions.
 */
import { describe, expect, it } from "vitest";
import {
  capsCheckPasses,
  capsResultsEqual,
  checkCapitalPositions,
  hasAnyCapsFailure,
  isPrefixAllCaps,
} from "./caps";
import { normalizeTransport } from "./normalize";
import { CANONICAL_WARNING_TEXT } from "./canonical";

describe("checkCapitalPositions — the canonical text passes all four positions", () => {
  it("GOVERNMENT, WARNING, Surgeon, and General are all OK", () => {
    const result = checkCapitalPositions(normalizeTransport(CANONICAL_WARNING_TEXT));
    expect(result).toEqual({ government: "OK", warning: "OK", surgeon: "OK", general: "OK" });
  });

  it("capsCheckPasses is true and hasAnyCapsFailure is false for the canonical text", () => {
    const result = checkCapitalPositions(normalizeTransport(CANONICAL_WARNING_TEXT));
    expect(capsCheckPasses(result)).toBe(true);
    expect(hasAnyCapsFailure(result)).toBe(false);
  });
});

describe("checkCapitalPositions — case-08: title-case PREFIX only (golden set, TH-R9's named catch)", () => {
  it("flags GOVERNMENT and WARNING as WRONG_CASE; Surgeon/General still OK", () => {
    const raw =
      "Government Warning: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    const result = checkCapitalPositions(normalizeTransport(raw));
    expect(result.government).toBe("WRONG_CASE");
    expect(result.warning).toBe("WRONG_CASE");
    expect(result.surgeon).toBe("OK");
    expect(result.general).toBe("OK");
    expect(hasAnyCapsFailure(result)).toBe(true);
  });
});

describe("checkCapitalPositions — case-09: the WHOLE statement in title case (golden set)", () => {
  it("flags GOVERNMENT and WARNING as WRONG_CASE; Surgeon/General PASS — title case still capitalizes their initial letter", () => {
    // CP-2 §9.2 finding 2, quoted: "Its title-case body does capitalize
    // Surgeon and General, so those two positions pass."
    const raw =
      "Government Warning: (1) According To The Surgeon General, Women Should Not Drink Alcoholic Beverages During Pregnancy Because Of The Risk Of Birth Defects. (2) Consumption Of Alcoholic Beverages Impairs Your Ability To Drive A Car Or Operate Machinery, And May Cause Health Problems.";
    const result = checkCapitalPositions(normalizeTransport(raw));
    expect(result.government).toBe("WRONG_CASE");
    expect(result.warning).toBe("WRONG_CASE");
    expect(result.surgeon).toBe("OK");
    expect(result.general).toBe("OK");
  });
});

describe("checkCapitalPositions — 'surgeon general' printed lower-case (TTB boot camp's named common mistake, CP-2 §2.6)", () => {
  it("flags surgeon and general as WRONG_CASE; GOVERNMENT/WARNING unaffected", () => {
    const raw =
      "GOVERNMENT WARNING: (1) According to the surgeon general, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    const result = checkCapitalPositions(normalizeTransport(raw));
    expect(result.government).toBe("OK");
    expect(result.warning).toBe("OK");
    expect(result.surgeon).toBe("WRONG_CASE");
    expect(result.general).toBe("WRONG_CASE");
    expect(hasAnyCapsFailure(result)).toBe(true);
  });
});

describe("checkCapitalPositions — the third §7.1 row: word absent/reworded is WRONG_WORD, not a caps complaint", () => {
  it("a completely different first word is WRONG_WORD, not WRONG_CASE", () => {
    const result = checkCapitalPositions(normalizeTransport("IMPORTANT NOTICE: this is not the statute"));
    expect(result.government).toBe("WRONG_WORD");
    expect(result.warning).toBe("WRONG_WORD");
  });

  it("Surgeon and General absent from a reworded clause are WRONG_WORD, not WRONG_CASE", () => {
    // Golden-set case-10 shape: clause (1) reworded, "Surgeon General" gone.
    const raw =
      "GOVERNMENT WARNING: (1) Pregnant people should avoid alcohol due to birth defect risk. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    const result = checkCapitalPositions(normalizeTransport(raw));
    expect(result.government).toBe("OK");
    expect(result.warning).toBe("OK");
    expect(result.surgeon).toBe("WRONG_WORD");
    expect(result.general).toBe("WRONG_WORD");
    // Word-absent is not itself a hard caps failure — the wording/distance
    // check is what flags a reworded clause (CP-2 §7.1's third row).
    expect(hasAnyCapsFailure(result)).toBe(false);
  });

  it("strips a trailing colon from word 2 before comparing it", () => {
    const result = checkCapitalPositions(normalizeTransport("GOVERNMENT WARNING (no colon here) rest of text"));
    expect(result.warning).toBe("OK");
  });

  it("finds 'General,' with its trailing comma and still checks its initial capital", () => {
    const result = checkCapitalPositions(normalizeTransport("GOVERNMENT WARNING: according to the Surgeon general, text"));
    expect(result.general).toBe("WRONG_CASE");
  });
});

describe("capsResultsEqual — CP-2 §4.5's dual-channel agreement rule needs this, not just word equality", () => {
  it("two identical results are equal", () => {
    const a = checkCapitalPositions(normalizeTransport(CANONICAL_WARNING_TEXT));
    const b = checkCapitalPositions(normalizeTransport(CANONICAL_WARNING_TEXT));
    expect(capsResultsEqual(a, b)).toBe(true);
  });

  it("an all-caps read and a title-case read of the prefix are NOT equal", () => {
    const allCaps = checkCapitalPositions(normalizeTransport(CANONICAL_WARNING_TEXT));
    const titleCase = checkCapitalPositions(
      normalizeTransport("Government Warning: (1) According to the Surgeon General, women should not drink."),
    );
    expect(capsResultsEqual(allCaps, titleCase)).toBe(false);
  });
});

describe("isPrefixAllCaps — CP-2 §7.1's cross-check against the model's own prefix_casing report", () => {
  it("true when GOVERNMENT and WARNING are both OK", () => {
    const result = checkCapitalPositions(normalizeTransport(CANONICAL_WARNING_TEXT));
    expect(isPrefixAllCaps(result)).toBe(true);
  });

  it("false when either position is not OK", () => {
    const result = checkCapitalPositions(normalizeTransport("Government WARNING: rest of text"));
    expect(isPrefixAllCaps(result)).toBe(false);
  });
});
