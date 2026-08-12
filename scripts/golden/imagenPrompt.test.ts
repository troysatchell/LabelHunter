import { describe, expect, it } from "vitest";
import { BLANK_LABEL_COLOR_HEX, PROMPT_VERSION, buildBackdropPrompt } from "./imagenPrompt";
import type { BottleScene } from "../../src/lib/golden-set/bottleReference";

const SCENE: BottleScene = {
  sceneId: "bar-counter",
  setting: "a rustic dark-wood bar counter",
  lighting: "Warm tungsten backlight, golden-hour glow.",
};

describe("buildBackdropPrompt", () => {
  it("interpolates the scene's setting and lighting", () => {
    const prompt = buildBackdropPrompt(SCENE, "steady");
    expect(prompt).toContain("Place the bottle on a rustic dark-wood bar counter.");
    expect(prompt).toContain("Warm tungsten backlight, golden-hour glow.");
  });

  it("includes the fixed blank-label compositing instruction and its exact color", () => {
    const prompt = buildBackdropPrompt(SCENE, "steady");
    expect(prompt).toContain(BLANK_LABEL_COLOR_HEX);
    expect(prompt).toContain("Do not generate any text, logos, illustrations, typography, seals");
    expect(prompt).toContain("suitable for later digital compositing");
  });

  it("gives each camera condition a distinct clause", () => {
    const steady = buildBackdropPrompt(SCENE, "steady");
    const motionBlur = buildBackdropPrompt(SCENE, "motion-blur");
    const cameraShake = buildBackdropPrompt(SCENE, "camera-shake");
    expect(steady).not.toEqual(motionBlur);
    expect(motionBlur).not.toEqual(cameraShake);
    expect(steady).toContain("Tripod-steady, 1/125s shutter speed");
    expect(motionBlur).toContain("1/15s");
    expect(cameraShake).toContain("camera shake");
  });

  it("never leaves an interpolation placeholder unresolved", () => {
    const prompt = buildBackdropPrompt(SCENE, "camera-shake");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toMatch(/\{.*\}/);
  });

  it("exposes a stable prompt version for generationMetadata", () => {
    expect(PROMPT_VERSION).toBe("v1");
  });
});
