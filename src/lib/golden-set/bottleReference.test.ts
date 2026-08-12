import { describe, expect, it } from "vitest";
import { BottleReferenceValidationError, validateBottleReference } from "./bottleReference";

const VALID = {
  bottleId: "amber-whiskey-01",
  referencePhoto: "assets/golden/references/amber-whiskey-01.jpg",
  beverageType: "spirits",
  bottleDescription: "tall amber glass whiskey bottle, cork stopper, tapered shoulders",
  scenes: [
    { sceneId: "bar-counter", setting: "a rustic dark-wood bar counter", lighting: "warm tungsten backlight" },
  ],
  cameraConditions: ["steady", "motion-blur"],
};

describe("validateBottleReference", () => {
  it("accepts a well-formed reference", () => {
    expect(validateBottleReference(VALID)).toEqual(VALID);
  });

  it("rejects a missing bottleId", () => {
    const { bottleId: _drop, ...rest } = VALID;
    expect(() => validateBottleReference(rest)).toThrow(BottleReferenceValidationError);
  });

  it("rejects an unrecognized beverageType", () => {
    expect(() => validateBottleReference({ ...VALID, beverageType: "cider" })).toThrow(
      BottleReferenceValidationError,
    );
  });

  it("rejects an empty scenes array", () => {
    expect(() => validateBottleReference({ ...VALID, scenes: [] })).toThrow(
      BottleReferenceValidationError,
    );
  });

  it("rejects a scene missing lighting", () => {
    const { lighting: _drop, ...sceneRest } = VALID.scenes[0];
    expect(() => validateBottleReference({ ...VALID, scenes: [sceneRest] })).toThrow(
      BottleReferenceValidationError,
    );
  });

  it("rejects an unknown camera condition", () => {
    expect(() => validateBottleReference({ ...VALID, cameraConditions: ["underwater"] })).toThrow(
      BottleReferenceValidationError,
    );
  });

  it("collects every problem, not just the first", () => {
    try {
      validateBottleReference({ scenes: [], cameraConditions: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BottleReferenceValidationError);
      const problems = (err as BottleReferenceValidationError).problems;
      expect(problems.length).toBeGreaterThan(1);
    }
  });
});
