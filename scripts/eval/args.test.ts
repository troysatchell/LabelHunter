import { describe, expect, it } from "vitest";
import { DEFAULT_SAMPLE_CASE_IDS, MAX_CASES, parseEvalArgs, resolveCaseIds, validateCheckArgs } from "./args";

describe("parseEvalArgs", () => {
  it("defaults to cheap mode: live=false, full=false, no case, no baseline update", () => {
    expect(parseEvalArgs([])).toEqual({ live: false, full: false, caseId: null, updateBaseline: false });
  });

  it("parses --live alone", () => {
    expect(parseEvalArgs(["--live"])).toEqual({ live: true, full: false, caseId: null, updateBaseline: false });
  });

  it("parses --live --full", () => {
    expect(parseEvalArgs(["--live", "--full"])).toEqual({
      live: true,
      full: true,
      caseId: null,
      updateBaseline: false,
    });
  });

  it("parses --live --case=<id>", () => {
    expect(parseEvalArgs(["--live", "--case=case-01-clean-match-spirits"])).toEqual({
      live: true,
      full: false,
      caseId: "case-01-clean-match-spirits",
      updateBaseline: false,
    });
  });

  it("parses --live --update-baseline", () => {
    expect(parseEvalArgs(["--live", "--update-baseline"])).toEqual({
      live: true,
      full: false,
      caseId: null,
      updateBaseline: true,
    });
  });

  it("skips a literal -- token (pnpm's argv-forwarding quirk)", () => {
    expect(parseEvalArgs(["--", "--live"])).toEqual({ live: true, full: false, caseId: null, updateBaseline: false });
  });

  it("throws on an unrecognized argument", () => {
    expect(() => parseEvalArgs(["--bogus"])).toThrow(/unrecognized argument "--bogus"/);
  });

  it("throws when --full and --case=<id> are combined", () => {
    expect(() => parseEvalArgs(["--live", "--full", "--case=case-01-clean-match-spirits"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("does NOT itself require --live to accompany --full/--case/--update-baseline (that is check.ts's own rule — see validateCheckArgs below)", () => {
    expect(parseEvalArgs(["--full"])).toEqual({ live: false, full: true, caseId: null, updateBaseline: false });
    expect(parseEvalArgs(["--update-baseline"])).toEqual({ live: false, full: false, caseId: null, updateBaseline: true });
  });
});

describe("validateCheckArgs", () => {
  it("passes for cheap mode (no flags)", () => {
    expect(() => validateCheckArgs(parseEvalArgs([]))).not.toThrow();
  });

  it("passes for a valid --live run", () => {
    expect(() => validateCheckArgs(parseEvalArgs(["--live", "--full"]))).not.toThrow();
  });

  it("throws when --update-baseline is passed without --live", () => {
    expect(() => validateCheckArgs(parseEvalArgs(["--update-baseline"]))).toThrow(/--update-baseline requires --live/);
  });

  it("throws when --full is passed without --live", () => {
    expect(() => validateCheckArgs(parseEvalArgs(["--full"]))).toThrow(/only affect a --live run/);
  });

  it("throws when --case=<id> is passed without --live", () => {
    expect(() => validateCheckArgs(parseEvalArgs(["--case=case-01-clean-match-spirits"]))).toThrow(/only affect a --live run/);
  });
});

describe("resolveCaseIds", () => {
  const manifestIds = ["case-01-clean-match-spirits", "case-02-clean-match-beer-no-abv", "case-03-clean-match-wine"];

  it("returns the default sample when neither --full nor --case is set, regardless of the manifest passed in", () => {
    const args = parseEvalArgs(["--live"]);
    // Deliberately passing manifestIds (which shares none of DEFAULT_SAMPLE_CASE_IDS)
    // rather than DEFAULT_SAMPLE_CASE_IDS itself — the default-sample branch
    // does not filter against the manifest at all, and asserting that
    // against a genuinely different list proves it, rather than a
    // tautological self-comparison.
    expect(resolveCaseIds(args, manifestIds)).toEqual([...DEFAULT_SAMPLE_CASE_IDS]);
  });

  it("returns every manifest case ID when --full is set", () => {
    const args = parseEvalArgs(["--live", "--full"]);
    expect(resolveCaseIds(args, manifestIds)).toEqual(manifestIds);
  });

  it("returns exactly the named case when --case=<id> is set", () => {
    const args = parseEvalArgs(["--live", "--case=case-02-clean-match-beer-no-abv"]);
    expect(resolveCaseIds(args, manifestIds)).toEqual(["case-02-clean-match-beer-no-abv"]);
  });

  it("throws when --case=<id> names a case the manifest does not have", () => {
    const args = parseEvalArgs(["--live", "--case=case-99-does-not-exist"]);
    expect(() => resolveCaseIds(args, manifestIds)).toThrow(/not a golden-set case ID/);
  });

  it("throws when the resolved sample exceeds MAX_CASES", () => {
    const tooMany = Array.from({ length: MAX_CASES + 1 }, (_, i) => `case-${i}`);
    const args = parseEvalArgs(["--live", "--full"]);
    expect(() => resolveCaseIds(args, tooMany)).toThrow(/exceeds the \d+-case safety cap/);
  });
});
