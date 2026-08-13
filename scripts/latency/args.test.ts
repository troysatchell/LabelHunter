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

  // TRO-539: --url (real HTTP mode) and --out (redirect the report path so
  // a --url run never silently overwrites the committed in-process
  // evidence file). Every existing case above keeps passing unmodified —
  // url/outPath are `undefined` when absent, and vitest's `toEqual`
  // ignores `undefined` properties, so those assertions need no edit.

  it("url and outPath default to undefined", () => {
    const result = parseArgs([]);
    expect(result.url).toBeUndefined();
    expect(result.outPath).toBeUndefined();
  });

  it("parses --url=<origin>", () => {
    expect(parseArgs(["--url=http://localhost:3874"])).toEqual({
      runs: DEFAULT_RUNS,
      caseId: DEFAULT_CASE_ID,
      url: "http://localhost:3874",
    });
  });

  it("parses --out=<path>", () => {
    expect(parseArgs(["--out=scripts/latency/results/foo.json"])).toEqual({
      runs: DEFAULT_RUNS,
      caseId: DEFAULT_CASE_ID,
      outPath: "scripts/latency/results/foo.json",
    });
  });

  it("parses --url, --out, --runs, and --case together, in any order", () => {
    expect(
      parseArgs(["--out=out.json", "--runs=3", "--url=http://localhost:3874", "--case=case-02-clean-match-beer-no-abv"]),
    ).toEqual({
      runs: 3,
      caseId: "case-02-clean-match-beer-no-abv",
      url: "http://localhost:3874",
      outPath: "out.json",
    });
  });

  it("rejects a malformed --url", () => {
    expect(() => parseArgs(["--url=not-a-url"])).toThrow(/not a valid absolute URL/);
  });

  it("rejects an empty --url", () => {
    expect(() => parseArgs(["--url="])).toThrow(/unrecognized argument/);
  });

  it("accepts a --url with a path and trailing slash — measure.ts decides how to append /api/verify, this layer only validates absoluteness", () => {
    expect(() => parseArgs(["--url=https://labelhunter-web.onrender.com/"])).not.toThrow();
  });

  it("accepts http: and https: --url values", () => {
    expect(() => parseArgs(["--url=http://localhost:3874"])).not.toThrow();
    expect(() => parseArgs(["--url=https://labelhunter-web.onrender.com"])).not.toThrow();
  });

  it("rejects a non-http(s) --url scheme (CodeRabbit local review round 1, minor)", () => {
    expect(() => parseArgs(["--url=file:///etc/passwd"])).toThrow(/must be http: or https:/);
    expect(() => parseArgs(["--url=ftp://example.com"])).toThrow(/must be http: or https:/);
  });

  it("parses --note=<text>, including embedded spaces (one argv token)", () => {
    expect(parseArgs(["--note=fake-model validation, not a TH-R2 number"])).toEqual({
      runs: DEFAULT_RUNS,
      caseId: DEFAULT_CASE_ID,
      note: "fake-model validation, not a TH-R2 number",
    });
  });

  it("note defaults to undefined", () => {
    expect(parseArgs([]).note).toBeUndefined();
  });
});
