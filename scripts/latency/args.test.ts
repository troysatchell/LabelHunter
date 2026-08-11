/**
 * Tests for the latency harness's CLI argument parsing (TRO-471 / LH-031).
 * Pure function, no live call, no real money — `args.ts`'s own module
 * comment explains why this is a separate file from `measure.ts`.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CASE_ID, DEFAULT_RUNS, MAX_RUNS, parseArgs } from "./args";

describe("parseArgs", () => {
  it("defaults to DEFAULT_RUNS and DEFAULT_CASE_ID with no arguments", () => {
    expect(parseArgs([])).toEqual({ runs: DEFAULT_RUNS, caseId: DEFAULT_CASE_ID });
  });

  it("parses --runs=<n>", () => {
    expect(parseArgs(["--runs=5"])).toEqual({ runs: 5, caseId: DEFAULT_CASE_ID });
  });

  it("parses --case=<caseId>", () => {
    expect(parseArgs(["--case=case-07-abv-proof-mismatch-internal"])).toEqual({
      runs: DEFAULT_RUNS,
      caseId: "case-07-abv-proof-mismatch-internal",
    });
  });

  it("parses both flags together, in either order", () => {
    expect(parseArgs(["--runs=3", "--case=case-02-clean-match-beer-no-abv"])).toEqual({
      runs: 3,
      caseId: "case-02-clean-match-beer-no-abv",
    });
    expect(parseArgs(["--case=case-02-clean-match-beer-no-abv", "--runs=3"])).toEqual({
      runs: 3,
      caseId: "case-02-clean-match-beer-no-abv",
    });
  });

  it("skips a literal '--' token — pnpm forwards it, npm does not", () => {
    expect(parseArgs(["--", "--runs=5"])).toEqual({ runs: 5, caseId: DEFAULT_CASE_ID });
  });

  it("rejects an unrecognized argument", () => {
    expect(() => parseArgs(["--bogus=1"])).toThrow(/unrecognized argument/);
  });

  it("rejects a non-integer --runs", () => {
    expect(() => parseArgs(["--runs=abc"])).toThrow(/unrecognized argument/);
  });

  it("rejects --runs=0", () => {
    expect(() => parseArgs(["--runs=0"])).toThrow(/positive integer/);
  });

  it("accepts --runs at exactly MAX_RUNS", () => {
    expect(parseArgs([`--runs=${MAX_RUNS}`])).toEqual({ runs: MAX_RUNS, caseId: DEFAULT_CASE_ID });
  });

  it("rejects --runs above MAX_RUNS — a typo must not silently spend real API money", () => {
    expect(() => parseArgs([`--runs=${MAX_RUNS + 1}`])).toThrow(
      new RegExp(`exceeds the ${MAX_RUNS}-run safety cap`),
    );
  });

  it("names the received value in the safety-cap error", () => {
    expect(() => parseArgs(["--runs=2000"])).toThrow(/--runs=2000/);
  });
});
