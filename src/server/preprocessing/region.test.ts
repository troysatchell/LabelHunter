import { describe, expect, it } from "vitest";
import { clampRegionToBounds } from "./region";

describe("clampRegionToBounds", () => {
  it("leaves a region unchanged when it is fully inside the image", () => {
    expect(
      clampRegionToBounds({ x: 10, y: 20, width: 100, height: 50 }, 1000, 800),
    ).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("clamps a region that extends past the right and bottom edges", () => {
    expect(
      clampRegionToBounds({ x: 900, y: 700, width: 200, height: 200 }, 1000, 800),
    ).toEqual({ x: 900, y: 700, width: 100, height: 100 });
  });

  it("clamps a negative x/y to 0 and shrinks width/height to compensate", () => {
    // A region anchored at (-20, -10) sized 100x50 against a 1000x800 image:
    // clamp x to 0 (shift right by 20), width shrinks to 80; clamp y to 0
    // (shift down by 10), height shrinks to 40.
    expect(
      clampRegionToBounds({ x: -20, y: -10, width: 100, height: 50 }, 1000, 800),
    ).toEqual({ x: 0, y: 0, width: 80, height: 40 });
  });

  it("never returns a zero-or-negative width or height", () => {
    // A region entirely to the right of the image still clamps to a
    // minimum 1x1 box at the image's edge, not a 0-size (invalid) extract.
    const result = clampRegionToBounds(
      { x: 5000, y: 5000, width: 10, height: 10 },
      1000,
      800,
    );
    expect(result.width).toBeGreaterThanOrEqual(1);
    expect(result.height).toBeGreaterThanOrEqual(1);
    expect(result.x + result.width).toBeLessThanOrEqual(1000);
    expect(result.y + result.height).toBeLessThanOrEqual(800);
  });

  it("clamps a region exactly at the image bounds unchanged", () => {
    expect(
      clampRegionToBounds({ x: 0, y: 0, width: 1000, height: 800 }, 1000, 800),
    ).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it("rounds a fractional region to whole pixels before clamping", () => {
    // A detector reporting a bounding box in floating-point coordinates
    // must not reach sharp's .extract(), which requires integers.
    expect(
      clampRegionToBounds(
        { x: 100.4, y: 50.6, width: 199.6, height: 79.5 },
        1000,
        800,
      ),
    ).toEqual({ x: 100, y: 51, width: 200, height: 80 });
  });

  it("rejects a non-finite region field (NaN or Infinity) instead of silently propagating it", () => {
    // Math.max/min with NaN return NaN, which would otherwise reach
    // sharp's .extract() as a silently invalid crop request.
    expect(() =>
      clampRegionToBounds({ x: Number.NaN, y: 0, width: 100, height: 100 }, 1000, 800),
    ).toThrow(RangeError);
    expect(() =>
      clampRegionToBounds({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 }, 1000, 800),
    ).toThrow(RangeError);
  });
});
