import { describe, expect, it } from "vitest";
import { displayDimensions, orientationSwapsDimensions } from "./exif";

describe("orientationSwapsDimensions", () => {
  it("reports no swap for orientations 1-4 (upright or mirrored, no rotation)", () => {
    expect(orientationSwapsDimensions(1)).toBe(false);
    expect(orientationSwapsDimensions(2)).toBe(false);
    expect(orientationSwapsDimensions(3)).toBe(false);
    expect(orientationSwapsDimensions(4)).toBe(false);
  });

  it("reports a swap for orientations 5-8 (90deg or 270deg rotation)", () => {
    expect(orientationSwapsDimensions(5)).toBe(true);
    expect(orientationSwapsDimensions(6)).toBe(true);
    expect(orientationSwapsDimensions(7)).toBe(true);
    expect(orientationSwapsDimensions(8)).toBe(true);
  });
});

describe("displayDimensions", () => {
  it("returns the stored dimensions unchanged when orientation is undefined", () => {
    expect(displayDimensions({ width: 100, height: 60 }, undefined)).toEqual({
      width: 100,
      height: 60,
    });
  });

  it("returns the stored dimensions unchanged for orientation 1 (upright)", () => {
    expect(displayDimensions({ width: 100, height: 60 }, 1)).toEqual({
      width: 100,
      height: 60,
    });
  });

  it("swaps width and height for orientation 6 (rotate 90 CW)", () => {
    // Matches a live sharp measurement: a 100x60 source tagged
    // orientation 6 decodes, after .rotate(), to 60x100.
    expect(displayDimensions({ width: 100, height: 60 }, 6)).toEqual({
      width: 60,
      height: 100,
    });
  });

  it("swaps width and height for orientation 8 (rotate 90 CCW)", () => {
    expect(displayDimensions({ width: 100, height: 60 }, 8)).toEqual({
      width: 60,
      height: 100,
    });
  });

  it("does not swap for orientation 3 (rotate 180)", () => {
    expect(displayDimensions({ width: 100, height: 60 }, 3)).toEqual({
      width: 100,
      height: 60,
    });
  });
});
