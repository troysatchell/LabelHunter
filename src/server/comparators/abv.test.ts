/**
 * Tests for the real ABV grammar and comparator (LH-013 / TRO-463, CP-1
 * §3.2's worked example, §5.3 `AMBIGUOUS_ABV`, TH-R11). Written before
 * `abv.ts`'s implementation — TDD, PRD §6.
 *
 * `27 CFR 5.1` defines proof as "twice the percentage of ethyl alcohol by
 * volume" — the arithmetic `parseAbv`/`proofMatchesPercent` implement below.
 */
import { describe, expect, it } from "vitest";
import type { ExtractedField } from "../extractor/types";
import { abvAsPercent, compareAbv, parseAbv, proofMatchesPercent } from "./abv";

function field(value: string | null, overrides: Partial<ExtractedField> = {}): ExtractedField {
  return { value, evidence: value ?? "", confidence: 0.95, alternates: [], ...overrides };
}
const CONTEXT = { beverageType: "spirits" as const };

describe("parseAbv — CP-1 §3.2's own worked example and format variants", () => {
  it("reads a percent and a proof out of the CP-1 example", () => {
    expect(parseAbv("45% Alc./Vol. (90 Proof)")).toEqual({ percent: 45, proof: 90 });
  });

  it("is order-independent — proof first, percent second still parses both (golden-set case-04)", () => {
    expect(parseAbv("90 Proof (45% Alc./Vol.)")).toEqual({ percent: 45, proof: 90 });
  });

  it("reads a percent with no proof stated", () => {
    expect(parseAbv("13.5% Alc./Vol.")).toEqual({ percent: 13.5, proof: null });
  });

  it("reads a proof with no percent stated", () => {
    expect(parseAbv("90 Proof")).toEqual({ percent: null, proof: 90 });
  });

  it("returns both null for text with neither pattern, and for an empty string", () => {
    expect(parseAbv("Straight Bourbon Whiskey")).toEqual({ percent: null, proof: null });
    expect(parseAbv("")).toEqual({ percent: null, proof: null });
  });

  it("reads the word 'percent' as well as the '%' symbol", () => {
    expect(parseAbv("45 percent alcohol by volume")).toEqual({ percent: 45, proof: null });
  });

  it("reads 'degrees proof' phrasing, not only the bare word 'proof'", () => {
    expect(parseAbv("90 degrees proof")).toEqual({ percent: null, proof: 90 });
  });

  it("does not mistake a bare number in unrelated text for a percent or a proof", () => {
    expect(parseAbv("Batch No. 145")).toEqual({ percent: null, proof: null });
  });

  it("reads the full number, not a substring of it (CP-1 §4.4 rule 2's own trap)", () => {
    // normalize("45") is a substring of normalize("145") — a plain string
    // search would find it; a real parse reads the whole digit run.
    expect(parseAbv("145% full of flavor")).toEqual({ percent: 145, proof: null });
  });
});

describe("abvAsPercent — canonical-percent conversion", () => {
  it("prefers the stated percent when both are present", () => {
    expect(abvAsPercent({ percent: 45, proof: 90 })).toBe(45);
  });

  it("derives percent from proof when only proof is stated — 27 CFR 5.1: proof is twice the percent", () => {
    expect(abvAsPercent({ percent: null, proof: 90 })).toBe(45);
  });

  it("is null when neither is stated", () => {
    expect(abvAsPercent({ percent: null, proof: null })).toBeNull();
  });
});

describe("proofMatchesPercent — CP-1 §5.3's self-contradiction check (27 CFR 5.1)", () => {
  it("agrees for a self-consistent reading", () => {
    expect(proofMatchesPercent(45, 90)).toBe(true);
  });

  it("disagrees for CP-1's own named self-contradiction example: 45% but 100 proof", () => {
    expect(proofMatchesPercent(45, 100)).toBe(false);
  });

  it("allows a small float-rounding slop, not a real second reading", () => {
    expect(proofMatchesPercent(45, 90.04)).toBe(true);
  });
});

describe("compareAbv — MATCH/MISMATCH against the application's declared percent", () => {
  it("MATCHes when the label states the same percent the application declares", () => {
    const result = compareAbv(field("45% Alc./Vol. (90 Proof)"), 45, CONTEXT);
    expect(result.verdict).toBe("MATCH");
  });

  it("MISMATCHes when the label states a lower percent (golden-set case-05)", () => {
    const result = compareAbv(field("40% Alc./Vol. (80 Proof)"), 45, CONTEXT);
    expect(result.verdict).toBe("MISMATCH");
  });

  it("MISMATCHes when the label states a higher percent (golden-set case-06)", () => {
    const result = compareAbv(field("47% Alc./Vol. (94 Proof)"), 40, CONTEXT);
    expect(result.verdict).toBe("MISMATCH");
  });

  it("MATCHes off a proof-only label read against the equivalent application percent", () => {
    const result = compareAbv(field("90 Proof"), 45, CONTEXT);
    expect(result.verdict).toBe("MATCH");
  });

  it("NEEDS_REVIEW when the label value does not parse", () => {
    const result = compareAbv(field("not a percent or proof"), 45, CONTEXT);
    expect(result.verdict).toBe("NEEDS_REVIEW");
  });

  it("NEEDS_REVIEW when there is no label value, or no application value to compare", () => {
    expect(compareAbv(field(null), 45, CONTEXT).verdict).toBe("NEEDS_REVIEW");
    expect(compareAbv(field("45% Alc./Vol."), "not a number" as unknown as number, CONTEXT).verdict).toBe(
      "NEEDS_REVIEW",
    );
  });
});
