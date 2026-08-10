import { describe, expect, it } from "vitest";
import { computeResizeDimensions } from "./resize";

describe("computeResizeDimensions", () => {
  it("leaves a landscape image unchanged when it is already under the cap", () => {
    expect(computeResizeDimensions({ width: 800, height: 600 }, 1568)).toEqual(
      { width: 800, height: 600 },
    );
  });

  it("leaves an image unchanged when its long edge exactly equals the cap", () => {
    expect(computeResizeDimensions({ width: 1568, height: 1000 }, 1568)).toEqual(
      { width: 1568, height: 1000 },
    );
  });

  it("downscales a landscape image so the long edge matches the cap", () => {
    // 3200x2400, cap 1568 -> scale 0.49 -> 1568 x 1176
    expect(
      computeResizeDimensions({ width: 3200, height: 2400 }, 1568),
    ).toEqual({ width: 1568, height: 1176 });
  });

  it("downscales a portrait image so the long edge (height) matches the cap", () => {
    // 2400x3200, cap 1568 -> scale 0.49 -> 1176 x 1568
    expect(
      computeResizeDimensions({ width: 2400, height: 3200 }, 1568),
    ).toEqual({ width: 1176, height: 1568 });
  });

  it("downscales a square image so both edges match the cap", () => {
    expect(computeResizeDimensions({ width: 2000, height: 2000 }, 1568)).toEqual(
      { width: 1568, height: 1568 },
    );
  });

  it("uses the Sonnet cap to produce a larger variant than the Haiku cap for the same source", () => {
    const haiku = computeResizeDimensions({ width: 3200, height: 2400 }, 1568);
    const sonnet = computeResizeDimensions({ width: 3200, height: 2400 }, 2576);
    expect(sonnet.width).toBeGreaterThan(haiku.width);
    expect(sonnet.height).toBeGreaterThan(haiku.height);
  });

  it("never produces a zero-pixel dimension for an extreme aspect ratio", () => {
    // Regression: a very thin source (e.g. a cropped strip) scaled down
    // must not round a dimension to 0 — sharp rejects a 0-size resize.
    const result = computeResizeDimensions({ width: 10000, height: 1 }, 1568);
    expect(result.width).toBe(1568);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it("rejects a non-positive or non-finite source width", () => {
    expect(() => computeResizeDimensions({ width: 0, height: 100 }, 1568)).toThrow(
      RangeError,
    );
    expect(() =>
      computeResizeDimensions({ width: Number.NaN, height: 100 }, 1568),
    ).toThrow(RangeError);
  });

  it("rejects a non-positive or non-finite source height", () => {
    expect(() => computeResizeDimensions({ width: 100, height: 0 }, 1568)).toThrow(
      RangeError,
    );
  });

  it("rejects a non-positive maxLongEdgePx", () => {
    expect(() => computeResizeDimensions({ width: 100, height: 100 }, 0)).toThrow(
      RangeError,
    );
    expect(() =>
      computeResizeDimensions({ width: 100, height: 100 }, -10),
    ).toThrow(RangeError);
  });
});
