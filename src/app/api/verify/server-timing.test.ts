/**
 * Tests for the `Server-Timing` encode/decode pair (TRO-539, PRD §3.8).
 * Pure functions, no I/O, no live call, no database — see this file's
 * sibling module comment for why the header exists.
 */
import { describe, expect, it } from "vitest";
import { buildServerTimingHeader, parseServerTimingHeader, SERVER_TIMING_STAGES, type StageTimingsMs } from "./server-timing";

const SAMPLE: StageTimingsMs = {
  preprocess: 312.4,
  ocr: 480,
  haiku: 2503.7,
  router: 0.3,
  db: 18.9,
};

describe("SERVER_TIMING_STAGES", () => {
  it("names exactly PRD §3.8's five budgeted stages, in the table's order", () => {
    expect(SERVER_TIMING_STAGES).toEqual(["preprocess", "ocr", "haiku", "router", "db"]);
  });
});

describe("buildServerTimingHeader", () => {
  it("writes one name;dur=<ms> entry per stage, comma-separated, in stage order", () => {
    expect(buildServerTimingHeader(SAMPLE)).toBe(
      "preprocess;dur=312.4, ocr;dur=480.0, haiku;dur=2503.7, router;dur=0.3, db;dur=18.9",
    );
  });

  it("rounds each duration to one decimal place", () => {
    const header = buildServerTimingHeader({ ...SAMPLE, haiku: 2500.449 });
    expect(header).toContain("haiku;dur=2500.4");
  });

  it("writes a 0ms stage as 0.0, not an empty or missing entry", () => {
    const header = buildServerTimingHeader({ ...SAMPLE, router: 0 });
    expect(header).toContain("router;dur=0.0");
  });
});

describe("parseServerTimingHeader", () => {
  it("round-trips every stage buildServerTimingHeader wrote", () => {
    const header = buildServerTimingHeader(SAMPLE);
    const parsed = parseServerTimingHeader(header);
    for (const stage of SERVER_TIMING_STAGES) {
      expect(parsed[stage]).toBeCloseTo(SAMPLE[stage], 1);
    }
  });

  it("returns an empty object for an empty header", () => {
    expect(parseServerTimingHeader("")).toEqual({});
  });

  it("ignores an entry naming a stage outside SERVER_TIMING_STAGES", () => {
    const parsed = parseServerTimingHeader("cache;dur=1.0, haiku;dur=2500.0");
    expect(parsed).toEqual({ haiku: 2500 });
  });

  it("ignores an entry with no dur= component", () => {
    const parsed = parseServerTimingHeader("haiku, router;dur=0.5");
    expect(parsed).toEqual({ router: 0.5 });
  });

  it("ignores a negative duration", () => {
    // Not representable by this function's own regex (it has no "-" branch),
    // but confirmed explicitly: a malformed upstream value must never
    // resurrect as a fabricated negative latency sample.
    expect(parseServerTimingHeader("db;dur=-5.0")).toEqual({});
  });

  it("ignores a non-numeric dur= value", () => {
    expect(parseServerTimingHeader("haiku;dur=NaN, router;dur=0.4")).toEqual({ router: 0.4 });
  });

  it("tolerates extra whitespace around entries", () => {
    expect(parseServerTimingHeader("  haiku;dur=2500.0 ,  router;dur=0.4  ")).toEqual({
      haiku: 2500,
      router: 0.4,
    });
  });

  it("never throws on garbage input", () => {
    expect(() => parseServerTimingHeader("not a server-timing header at all; ??")).not.toThrow();
    expect(parseServerTimingHeader("not a server-timing header at all; ??")).toEqual({});
  });

  // CodeRabbit local review round 1 (major): a naive comma-split cuts a
  // quoted desc param's own comma as if it were a new entry.
  it("does not mis-split a quoted desc param containing a comma", () => {
    expect(parseServerTimingHeader('haiku;desc="crop, v2";dur=2500.0')).toEqual({ haiku: 2500 });
  });

  it("handles a quoted-comma entry alongside plain entries on either side", () => {
    const header = 'preprocess;dur=40.0, haiku;desc="crop, v2";dur=2500.0, router;dur=0.3';
    expect(parseServerTimingHeader(header)).toEqual({ preprocess: 40, haiku: 2500, router: 0.3 });
  });

  it("takes the FIRST dur param when an entry has more than one", () => {
    expect(parseServerTimingHeader("haiku;dur=100.0;dur=200.0")).toEqual({ haiku: 100 });
  });

  it("accepts a quoted numeric dur value", () => {
    expect(parseServerTimingHeader('haiku;dur="2500.0"')).toEqual({ haiku: 2500 });
  });
});
