import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FIXTURE_DIR, DEFAULT_MAX_WAIT_MS, DEFAULT_POLL_INTERVAL_MS, MAX_TIMER_DELAY_MS, parseArgs } from "./args";

describe("parseArgs", () => {
  const originalAppPort = process.env.APP_PORT;
  const originalPort = process.env.PORT;

  beforeEach(() => {
    delete process.env.APP_PORT;
    delete process.env.PORT;
  });

  afterEach(() => {
    if (originalAppPort === undefined) delete process.env.APP_PORT;
    else process.env.APP_PORT = originalAppPort;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it("defaults to localhost:3000 and the documented defaults when nothing is set", () => {
    const args = parseArgs([]);
    expect(args.baseUrl).toBe("http://localhost:3000");
    expect(args.fixtureDir).toBe(DEFAULT_FIXTURE_DIR);
    expect(args.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(args.maxWaitMs).toBe(DEFAULT_MAX_WAIT_MS);
  });

  it("prefers APP_PORT over PORT for the default base URL, matching playwright.config.ts", () => {
    process.env.APP_PORT = "3405";
    process.env.PORT = "9999";
    expect(parseArgs([]).baseUrl).toBe("http://localhost:3405");
  });

  it("falls back to PORT when APP_PORT is unset", () => {
    process.env.PORT = "4100";
    expect(parseArgs([]).baseUrl).toBe("http://localhost:4100");
  });

  it("parses every recognized flag", () => {
    const args = parseArgs([
      "--base-url=http://localhost:3405",
      "--fixture-dir=/tmp/fixture",
      "--poll-interval-ms=500",
      "--max-wait-ms=60000",
    ]);
    expect(args).toEqual({
      baseUrl: "http://localhost:3405",
      fixtureDir: "/tmp/fixture",
      pollIntervalMs: 500,
      maxWaitMs: 60_000,
    });
  });

  it("skips a lone '--' token (pnpm forwards it into argv)", () => {
    const args = parseArgs(["--", "--poll-interval-ms=1000"]);
    expect(args.pollIntervalMs).toBe(1000);
  });

  it("throws on an unrecognized argument", () => {
    expect(() => parseArgs(["--bogus=1"])).toThrow(/unrecognized argument/);
  });

  it("throws when --poll-interval-ms is below the floor", () => {
    expect(() => parseArgs(["--poll-interval-ms=10"])).toThrow(/poll-interval-ms/);
  });

  it("throws when --max-wait-ms is smaller than --poll-interval-ms", () => {
    expect(() => parseArgs(["--poll-interval-ms=5000", "--max-wait-ms=1000"])).toThrow(/max-wait-ms/);
  });

  it("throws when --poll-interval-ms exceeds the 32-bit timer delay Node silently clamps (review finding)", () => {
    expect(() => parseArgs([`--poll-interval-ms=${MAX_TIMER_DELAY_MS + 1}`])).toThrow(/poll-interval-ms/);
  });

  it("throws when --max-wait-ms exceeds the 32-bit timer delay Node silently clamps", () => {
    expect(() => parseArgs([`--max-wait-ms=${MAX_TIMER_DELAY_MS + 1}`])).toThrow(/max-wait-ms/);
  });

  it("throws when --max-wait-ms is not a safe integer (e.g. larger than Number.MAX_SAFE_INTEGER)", () => {
    expect(() => parseArgs(["--max-wait-ms=99999999999999999999"])).toThrow(/max-wait-ms/);
  });

  it("accepts --max-wait-ms exactly at the timer delay ceiling", () => {
    const args = parseArgs([`--max-wait-ms=${MAX_TIMER_DELAY_MS}`]);
    expect(args.maxWaitMs).toBe(MAX_TIMER_DELAY_MS);
  });
});
