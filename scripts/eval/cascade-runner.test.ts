/**
 * Tests for `mergeResolutionIntoActualVerdict` (TRO-538 / LH-033) — the pure
 * merge step that produces the cascade's END STATE verdict: the router's
 * own field rows, with any resolver-flagged field overridden by the
 * resolver's own disposition. `runOneCase` itself (real I/O, a real DB, a
 * real Anthropic call) is exercised by the eval harness's own `--live` run,
 * not by this file — same "pure logic gets a unit test, I/O orchestration
 * gets a live run" split every other file in this directory already uses
 * (`resolver-rollup.test.ts`, `flagged-fields.test.ts`).
 */
import { describe, expect, it } from "vitest";
import type {
  ApplicationRecord,
  ComparatorResult,
  FieldComparators,
  FieldResultRow,
  LabelRouterResult,
  LabelVerdict,
  ReviewReason,
  RouterFieldKey,
  WarningComparatorChannel,
} from "../../src/server/router/types";
import type { CorrectionFieldResolution, JudgedFieldResolution, ResolverResolution } from "../../src/server/resolver";
import { mergeResolutionIntoActualVerdict } from "./cascade-runner";

const APPLICATION: ApplicationRecord = {
  beverageType: "wine",
  brandName: "Willowbrook Winery",
  classType: "Mead",
  alcoholContentPercent: 12,
  netContentsValue: 750,
  netContentsUnit: "mL",
};

const CANONICAL_WARNING =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

/** Exact-string-equality fakes — the same "isolate the merge logic from
 * comparator internals" choice `resolver-rollup.test.ts` already makes for
 * the identical reason (its own module comment). */
function fakeComparator(): (extracted: { value: string | null }, applicationValue: unknown) => ComparatorResult {
  return (extracted, applicationValue) => {
    if (extracted.value === null) return { verdict: "MISMATCH" };
    return extracted.value === String(applicationValue) ? { verdict: "MATCH" } : { verdict: "MISMATCH" };
  };
}

const FAKE_COMPARATORS: FieldComparators = {
  brand_name: fakeComparator() as FieldComparators["brand_name"],
  class_type: fakeComparator() as FieldComparators["class_type"],
  alcohol_content: fakeComparator() as FieldComparators["alcohol_content"],
  net_contents: fakeComparator() as FieldComparators["net_contents"],
};

function matchRow(field: RouterFieldKey, value: string): FieldResultRow {
  return { field, verdict: "MATCH", labelValue: value, applicationValue: value, evidence: value, confidence: 0.95, reason: "matches", resolvedBy: null, reviewReason: null };
}

function mismatchRow(field: RouterFieldKey, value: string): FieldResultRow {
  return { field, verdict: "MISMATCH", labelValue: value, applicationValue: "(different)", evidence: value, confidence: 0.95, reason: "differs", resolvedBy: null, reviewReason: null };
}

function needsReviewRow(field: RouterFieldKey, reviewReason: ReviewReason | null): FieldResultRow {
  return { field, verdict: "NEEDS_REVIEW", labelValue: null, applicationValue: "x", evidence: "x", confidence: 0.5, reason: "needs a human look", resolvedBy: null, reviewReason };
}

function router(fields: FieldResultRow[], labelVerdict: LabelVerdict = "REVIEW", headlineReason: ReviewReason | null = "AMBIGUOUS_BRAND"): LabelRouterResult {
  return { labelVerdict, headlineReason, fields };
}

/** A clean-PASS row set — every test starts here and overrides only the
 * field(s) it cares about, so an unrelated field never accidentally decides
 * a test's outcome. */
function cleanRows(): FieldResultRow[] {
  return [
    matchRow("brand_name", "Willowbrook Winery"),
    matchRow("class_type", "Mead"),
    matchRow("alcohol_content", "12"),
    matchRow("net_contents", "750 mL"),
    matchRow("government_warning", CANONICAL_WARNING),
  ];
}

function judged(field: "brand_name" | "class_type", disposition: JudgedFieldResolution["disposition"]): JudgedFieldResolution {
  return { kind: "judged", field, disposition, correctedValue: disposition === "NEEDS_HUMAN" ? null : "x", evidence: "x", reason: "x", confidence: 0.9 };
}

function correction(
  field: "alcohol_content" | "net_contents" | "government_warning",
  overrides: Partial<CorrectionFieldResolution> = {},
): CorrectionFieldResolution {
  return { kind: "correction", field, needsHuman: false, correctedValue: "12", evidence: "x", reason: "x", confidence: 0.9, ...overrides };
}

describe("mergeResolutionIntoActualVerdict", () => {
  it("overrides the router's row with the resolver's disposition for a flagged field", () => {
    const routerResult = router([needsReviewRow("brand_name", "AMBIGUOUS_BRAND"), ...cleanRows().slice(1)]);
    const resolution: ResolverResolution = { outcome: "resolved", fields: [judged("brand_name", "RESOLVED_MISMATCH")] };

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    expect(merged.fields.find((f) => f.field === "brand_name")).toEqual({ field: "brand_name", verdict: "MISMATCH" });
  });

  it("a resolved MISMATCH on a judged field surfaces as label-level FAIL, even though the router itself said REVIEW (TH-R8 — the resolver's judgment IS the verdict)", () => {
    const routerResult = router([needsReviewRow("brand_name", "AMBIGUOUS_BRAND"), ...cleanRows().slice(1)]);
    const resolution: ResolverResolution = { outcome: "resolved", fields: [judged("brand_name", "RESOLVED_MISMATCH")] };

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    expect(merged.labelVerdict).toBe("FAIL");
  });

  it("carries an unflagged router row through unchanged", () => {
    const routerResult = router([needsReviewRow("brand_name", "AMBIGUOUS_BRAND"), ...cleanRows().slice(1)]);
    const resolution: ResolverResolution = { outcome: "resolved", fields: [judged("brand_name", "RESOLVED_MATCH")] };

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    expect(merged.fields.find((f) => f.field === "class_type")).toEqual({ field: "class_type", verdict: "MATCH" });
    expect(merged.labelVerdict).toBe("PASS");
  });

  it("carries an unflagged router MISMATCH row through unchanged — not just MATCH/NEEDS_REVIEW", () => {
    const routerResult = router([needsReviewRow("brand_name", "AMBIGUOUS_BRAND"), mismatchRow("class_type", "Rye Whiskey"), ...cleanRows().slice(2)]);
    const resolution: ResolverResolution = { outcome: "resolved", fields: [judged("brand_name", "RESOLVED_MATCH")] };

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    expect(merged.fields.find((f) => f.field === "class_type")).toEqual({ field: "class_type", verdict: "MISMATCH" });
    expect(merged.labelVerdict).toBe("FAIL");
  });

  it("carries an unflagged NEEDS_REVIEW row with a null reviewReason through unchanged (case-20's real shape: a label-level blocker already explains it)", () => {
    const routerResult = router(
      [needsReviewRow("brand_name", "AMBIGUOUS_BRAND"), needsReviewRow("class_type", null), ...cleanRows().slice(2)],
      "REVIEW",
      "LOW_IMAGE_QUALITY",
    );
    const resolution: ResolverResolution = { outcome: "resolved", fields: [judged("brand_name", "RESOLVED_MATCH")] };

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    expect(merged.fields.find((f) => f.field === "class_type")).toEqual({ field: "class_type", verdict: "NEEDS_REVIEW", reviewReason: null });
    expect(merged.labelVerdict).toBe("REVIEW");
  });

  it("a judged field's NEEDS_HUMAN rolls up to NEEDS_REVIEW / LOW_MODEL_CONFIDENCE", () => {
    const routerResult = router([needsReviewRow("brand_name", "AMBIGUOUS_BRAND"), ...cleanRows().slice(1)]);
    const resolution: ResolverResolution = { outcome: "needs-human", fields: [judged("brand_name", "NEEDS_HUMAN")] };

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    expect(merged.fields.find((f) => f.field === "brand_name")).toEqual({ field: "brand_name", verdict: "NEEDS_REVIEW", reviewReason: "LOW_MODEL_CONFIDENCE" });
    expect(merged.labelVerdict).toBe("REVIEW");
    expect(merged.headlineReason).toBe("LOW_MODEL_CONFIDENCE");
  });

  it("a correction field's corrected value re-runs the real deterministic comparator (CP-1 §6.5), not the resolver's own opinion", () => {
    const routerResult = router([needsReviewRow("alcohol_content", "AMBIGUOUS_ABV"), ...cleanRows().filter((r) => r.field !== "alcohol_content")]);
    const resolution: ResolverResolution = { outcome: "resolved", fields: [correction("alcohol_content", { correctedValue: "40" })] }; // disagrees with the 12% application

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    expect(merged.fields.find((f) => f.field === "alcohol_content")).toEqual({ field: "alcohol_content", verdict: "MISMATCH" });
    expect(merged.labelVerdict).toBe("FAIL");
  });

  it("open design decision (TRO-538, flagged in the PR body): the label-level blocker does not survive the merge once the resolver confirms every field", () => {
    // A label-level blocker (CONFLICTING_EXTRACTION) forced the router itself
    // to REVIEW even though every field independently read clean — no field
    // carries its own reviewReason, so buildFlaggedFieldsForEscalatedLabel
    // flags all five (flagged-fields.ts's own doc comment). The resolver
    // confirms every one of them.
    const routerResult = router(cleanRows(), "REVIEW", "CONFLICTING_EXTRACTION");
    const resolution: ResolverResolution = {
      outcome: "resolved",
      fields: [
        judged("brand_name", "RESOLVED_MATCH"),
        judged("class_type", "RESOLVED_MATCH"),
        correction("alcohol_content", { correctedValue: "12" }),
        correction("net_contents", { correctedValue: "750 mL" }),
        correction("government_warning", { correctedValue: CANONICAL_WARNING }),
      ],
    };

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    expect(merged.labelVerdict).toBe("PASS");
    expect(merged.headlineReason).toBeNull();
  });

  it("honest limit: a resolved government_warning can only reach NEEDS_REVIEW, never MISMATCH — this rollup has no OCR channel to corroborate a deviation (mirrors resolver-rollup.ts's rollUpGovernmentWarning)", () => {
    const routerResult = router(cleanRows(), "REVIEW", "CONFLICTING_EXTRACTION");
    const resolution: ResolverResolution = {
      outcome: "resolved",
      fields: [
        judged("brand_name", "RESOLVED_MATCH"),
        judged("class_type", "RESOLVED_MATCH"),
        correction("alcohol_content", { correctedValue: "12" }),
        correction("net_contents", { correctedValue: "750 mL" }),
        correction("government_warning", { correctedValue: CANONICAL_WARNING.replace("women should not drink", "women must never consume") }),
      ],
    };

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    const warning = merged.fields.find((f) => f.field === "government_warning");
    expect(warning?.verdict).toBe("NEEDS_REVIEW");
    expect(merged.labelVerdict).toBe("REVIEW");
    expect(merged.headlineReason).toBe("WARNING_MISMATCH");
  });

  it("throws when the router result has no row for a field the merge needs — a harness invariant, not a normal input", () => {
    const routerResult = router(cleanRows().filter((r) => r.field !== "government_warning"));
    const resolution: ResolverResolution = { outcome: "resolved", fields: [judged("brand_name", "RESOLVED_MATCH")] };

    expect(() => mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null)).toThrow(/no row for field "government_warning"/);
  });

  it("rolls up to REVIEW, not PASS, when a resolved field returns MATCH but a different, unflagged field is still NEEDS_REVIEW", () => {
    const routerResult = router([
      needsReviewRow("brand_name", "AMBIGUOUS_BRAND"),
      needsReviewRow("class_type", "AMBIGUOUS_BRAND"),
      ...cleanRows().slice(2),
    ]);
    // Only brand_name was flagged and resolved; class_type's own REVIEW never got a Sonnet look.
    const resolution: ResolverResolution = { outcome: "resolved", fields: [judged("brand_name", "RESOLVED_MATCH")] };

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    expect(merged.fields.find((f) => f.field === "class_type")).toEqual({ field: "class_type", verdict: "NEEDS_REVIEW", reviewReason: "AMBIGUOUS_BRAND" });
    expect(merged.labelVerdict).toBe("REVIEW");
  });

  // TRO-535 / TRO-538 merge-integration fix: `warningChannel` provenance
  // must survive the merge for a government_warning field that passed
  // through unresolved, and must NOT survive it for one the resolver
  // itself judged (the resolver has no channel of its own — see the
  // function's own second honest limit).
  it("carries the router's warningChannel through when government_warning was NOT itself resolved", () => {
    const routerResult = router([needsReviewRow("brand_name", "AMBIGUOUS_BRAND"), ...cleanRows().slice(1)]);
    const resolution: ResolverResolution = { outcome: "resolved", fields: [judged("brand_name", "RESOLVED_MATCH")] };
    const routerWarningChannel: WarningComparatorChannel = "dual";

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, routerWarningChannel);

    expect(merged.warningChannel).toBe("dual");
  });

  it("reports warningChannel as null when government_warning itself was resolved by Sonnet, even though the router had a known channel", () => {
    const routerResult = router(cleanRows(), "REVIEW", "CONFLICTING_EXTRACTION");
    const resolution: ResolverResolution = {
      outcome: "resolved",
      fields: [
        judged("brand_name", "RESOLVED_MATCH"),
        judged("class_type", "RESOLVED_MATCH"),
        correction("alcohol_content", { correctedValue: "12" }),
        correction("net_contents", { correctedValue: "750 mL" }),
        correction("government_warning", { correctedValue: CANONICAL_WARNING }),
      ],
    };
    const routerWarningChannel: WarningComparatorChannel = "single";

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, routerWarningChannel);

    expect(merged.warningChannel).toBeNull();
  });

  it("reports warningChannel as null when the router itself had none to give (e.g. the warning field never reached the comparator)", () => {
    const routerResult = router([needsReviewRow("brand_name", "AMBIGUOUS_BRAND"), ...cleanRows().slice(1)]);
    const resolution: ResolverResolution = { outcome: "resolved", fields: [judged("brand_name", "RESOLVED_MATCH")] };

    const merged = mergeResolutionIntoActualVerdict(routerResult, resolution, APPLICATION, FAKE_COMPARATORS, null);

    expect(merged.warningChannel).toBeNull();
  });
});
