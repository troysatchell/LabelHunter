import { describe, expect, it } from "vitest";
import { formatDuration } from "./format";

describe("formatDuration", () => {
  it("renders sub-second durations in milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(125)).toBe("125ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("renders durations under a minute in seconds", () => {
    expect(formatDuration(1000)).toBe("1.00s");
    expect(formatDuration(4999)).toBe("5.00s");
    expect(formatDuration(12000)).toBe("12.0s");
  });

  it("renders durations of a minute or more as minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("rejects negative or non-finite input", () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(Number.NaN)).toThrow(RangeError);
    expect(() => formatDuration(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
