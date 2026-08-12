/**
 * Golden-set-driven tests for the warning comparator (LH-020 / TRO-468).
 * The ticket brief names this explicitly: "the golden-set cases its §9.1
 * lists as warning-relevant (case-08, 09, 10, 11 especially — they prove
 * the caps check is structurally necessary, per §5.4's edit-distance
 * table)."
 *
 * Loads real cases from `golden-set/manifest.json` (via the same
 * `loadGoldenSetManifest` `../extractor/golden-case.test.ts` uses) and
 * compares `reconcileWarningChannels`'s verdict against each case's own
 * `expected.fields.governmentWarning.verdict` — so a manifest edit that
 * changes a case's ground truth is caught here, not masked by a
 * hand-copied string that happens to still match.
 *
 * Both channels (VLM and OCR) are simulated reading the SAME
 * `label.governmentWarningText` — not a testing shortcut, but the
 * necessary and correct simulation: CP-2 §4.5's dual-channel table only
 * reaches FAIL/MISMATCH in the "agree" branch (a single channel can never
 * FAIL, per this ticket's own load-bearing decision), and a real OCR
 * engine reading the same physical, legible label would in fact read the
 * same title-case or reworded text the VLM does — tesseract preserves
 * case literally, so a genuinely title-case label produces a title-case
 * OCR reading too. This is spelled out in `reconcile.test.ts`'s own
 * dual-channel-agree cases; this file applies it to the real manifest.
 */
import { describe, expect, it } from "vitest";
import { loadGoldenSetManifest } from "../../lib/golden-set/loader";
import type { WarningPrefixCasing } from "../extractor/types";
import { reconcileWarningChannels, type VlmWarningCandidate } from "./reconcile";
import { evaluateCandidate } from "./wording-compare";

const manifest = loadGoldenSetManifest();

function findCase(caseId: string) {
  const found = manifest.cases.find((c) => c.caseId === caseId);
  if (!found) throw new Error(`golden-set manifest is missing ${caseId}`);
  return found;
}

/** Builds a dual-channel-agreeing pair from one case's ground truth, and
 * returns the reconciled result — see this file's own header comment for
 * why "both channels read the ground truth" is the correct simulation. */
function reconcileCase(caseId: string, prefixCasing: WarningPrefixCasing, confidence = 0.97) {
  const goldenCase = findCase(caseId);
  const text = goldenCase.label.governmentWarningText;
  const vlm: VlmWarningCandidate = { transcription: text, prefixCasing, confidence };
  return { goldenCase, result: reconcileWarningChannels(vlm, { available: true, text, confidence: 92 }) };
}

describe("case-01-clean-match-spirits — exact warning, all-caps prefix", () => {
  it("MATCHes, matching the manifest's own expected verdict", () => {
    const { goldenCase, result } = reconcileCase("case-01-clean-match-spirits", "ALL_CAPS");
    expect(goldenCase.label.governmentWarningPrefixAllCaps).toBe(true); // precondition on the fixture
    expect(result.verdict).toBe(goldenCase.expected.fields.governmentWarning.verdict);
    expect(result.verdict).toBe("MATCH");
  });
});

describe("case-08-title-case-warning-prefix-only — Jenny's named catch, TH-R9's acceptance evidence", () => {
  it("MISMATCHes (the router's FAIL) — 'Government Warning' title-case prefix, not all-caps", () => {
    const { goldenCase, result } = reconcileCase("case-08-title-case-warning-prefix-only", "TITLE_CASE");
    expect(goldenCase.label.governmentWarningPrefixAllCaps).toBe(false); // precondition
    expect(result.verdict).toBe(goldenCase.expected.fields.governmentWarning.verdict);
    expect(result.verdict).toBe("MISMATCH");
  });
});

describe("case-09-title-case-warning-full-statement — the whole statement in title case", () => {
  it("MISMATCHes on capitalization, not wording — CP-2 §9.2 finding 2", () => {
    const { goldenCase, result } = reconcileCase("case-09-title-case-warning-full-statement", "TITLE_CASE");
    expect(result.verdict).toBe(goldenCase.expected.fields.governmentWarning.verdict);
    expect(result.verdict).toBe("MISMATCH");
    // CP-2 §9.2 finding 2: "Its title-case body does capitalize Surgeon
    // and General, so those two positions pass" — the failure is the
    // GOVERNMENT WARNING prefix, and the UI reason names capitalization,
    // not wording.
    expect(result.note).toBe("Government Warning must print in capital letters.");
  });
});

describe("case-10-reworded-warning-clause-one — genuine wording deviation, distance 38", () => {
  it("MISMATCHes on wording, far outside the near-miss band", () => {
    const { goldenCase, result } = reconcileCase("case-10-reworded-warning-clause-one", "ALL_CAPS");
    expect(goldenCase.label.governmentWarningPrefixAllCaps).toBe(true); // the prefix itself is fine here
    expect(result.verdict).toBe(goldenCase.expected.fields.governmentWarning.verdict);
    expect(result.verdict).toBe("MISMATCH");
    expect(result.note).toBe("Government Warning wording differs from the required text.");
  });
});

describe("case-11-reworded-warning-clause-two — genuine wording deviation, distance 24", () => {
  it("MISMATCHes on wording", () => {
    const { goldenCase, result } = reconcileCase("case-11-reworded-warning-clause-two", "ALL_CAPS");
    expect(result.verdict).toBe(goldenCase.expected.fields.governmentWarning.verdict);
    expect(result.verdict).toBe("MISMATCH");
  });
});

describe("the caps check is structurally necessary — CP-2 §5.4's own point", () => {
  it("case-08 and case-09 sit at wording distance 0 from canonical once case is folded; only the caps check catches them", () => {
    // Restates CP-2 §5.4's edit-distance table as a live assertion against
    // this implementation, not a copied number: with case folded, the
    // title-case cases are indistinguishable from a clean match on
    // wording alone — `evaluateCandidate` checks the wording axis, in
    // isolation from the caps axis it also computes but this test ignores.
    for (const caseId of ["case-08-title-case-warning-prefix-only", "case-09-title-case-warning-full-statement"]) {
      const text = findCase(caseId).label.governmentWarningText;
      expect(evaluateCandidate(text).wording).toBe("EXACT_MATCH");
    }
  });
});

describe("case-12/case-13 (missing warning) — out of this comparator's scope", () => {
  it("are handled by the router's own MISSING_REQUIRED_FIELD branch, before this comparator is ever consulted", () => {
    // CP-2 §6.1's last row: an absent warning is resolved by
    // `../router/field-resolution.ts`'s `resolveGovernmentWarningField`
    // (LH-012, already merged) before `reconcileWarningChannels` is
    // reachable at all — `../router/index.ts` only calls a warning
    // comparator when `!warningAbsent`. This test documents the boundary
    // rather than silently omitting these two manifest cases.
    for (const caseId of ["case-12-missing-warning-spirits", "case-13-missing-warning-wine"]) {
      const goldenCase = findCase(caseId);
      expect(goldenCase.label.governmentWarningPresent).toBe(false);
      expect(goldenCase.expected.fields.governmentWarning.verdict).toBe("NEEDS_REVIEW");
    }
  });
});
