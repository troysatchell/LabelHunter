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

  it("accepts a --url with just a trailing slash — a bare origin, not a real path", () => {
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

  // CodeRabbit local review round 2 (minor): measure.ts's
  // `new URL("/api/verify", url)` replaces a real path on `url` entirely
  // (a leading slash is absolute), silently dropping it rather than
  // combining it — reject a real path at parse time instead.
  it("rejects a --url with a real path", () => {
    expect(() => parseArgs(["--url=http://localhost:3874/staging"])).toThrow(/must be a bare origin/);
  });

  it("rejects a --url with a query string", () => {
    expect(() => parseArgs(["--url=http://localhost:3874?debug=1"])).toThrow(/must be a bare origin/);
  });

  it("rejects a --url with a fragment", () => {
    expect(() => parseArgs(["--url=http://localhost:3874#section"])).toThrow(/must be a bare origin/);
  });

  // CodeRabbit local review round 2 (major): fetch already rejects a
  // request URL carrying credentials, but at parse time gives a clearer,
  // --url-specific error instead of a generic fetch TypeError mid-run.
  it("rejects a --url with an embedded username/password", () => {
    expect(() => parseArgs(["--url=http://user:pass@localhost:3874"])).toThrow(/must not include a username or password/);
    expect(() => parseArgs(["--url=http://user@localhost:3874"])).toThrow(/must not include a username or password/);
  });

  it("cleanupDb defaults to undefined (not passed)", () => {
    expect(parseArgs([]).cleanupDb).toBeUndefined();
    expect(parseArgs(["--url=http://localhost:3874"]).cleanupDb).toBeUndefined();
  });

  it("parses --cleanup-db as true", () => {
    expect(parseArgs(["--url=http://localhost:3874", "--cleanup-db"]).cleanupDb).toBe(true);
  });

  it("parses --cleanup-db alongside every other flag", () => {
    expect(
      parseArgs(["--url=http://localhost:3874", "--cleanup-db", "--runs=3", "--out=out.json"]),
    ).toEqual({
      runs: 3,
      caseId: DEFAULT_CASE_ID,
      url: "http://localhost:3874",
      outPath: "out.json",
      cleanupDb: true,
    });
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
