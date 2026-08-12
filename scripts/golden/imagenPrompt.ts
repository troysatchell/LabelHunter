/**
 * Prompt compiler for the realistic-corpus track (design doc §3,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md). The
 * single place that turns a bottle reference's data (scene, camera
 * condition) into the narrative prose Gemini actually reads. A bottle
 * JSON never carries its own prompt phrasing — this file is the only
 * place that changes what gets sent (§3's "keep the compiler boring"
 * guardrail): no LLM-generated prompt layer, no dynamic rewriting, no
 * per-bottle customization.
 */
import type { CameraCondition } from "../../src/lib/golden-set/types";
import type { BottleScene } from "../../src/lib/golden-set/bottleReference";

/**
 * Bumped whenever this file's prompt text changes. Stamped into a
 * generated case's `generationMetadata.promptVersion` (design doc §6) —
 * forensic record-keeping, not a reproducibility claim (generation is not
 * deterministic regardless of prompt version).
 */
export const PROMPT_VERSION = "v1";

/**
 * The one color the prompt asks Gemini to paint the blank label area.
 * `blankRegionDetector.ts` (Task 4) scans generated photos for this exact
 * color — defined once, here, so the prompt text and the detector's target
 * can never drift apart.
 */
export const BLANK_LABEL_COLOR_RGB = { r: 240, g: 233, b: 220 } as const;
export const BLANK_LABEL_COLOR_HEX = "#F0E9DC";

const CAMERA_CONDITION_CLAUSES: Record<CameraCondition, string> = {
  steady: "Tripod-steady, 1/125s shutter speed, tack-sharp image with minimal motion blur.",
  "motion-blur":
    "Handheld at approximately 1/15s, with gentle directional motion blur while the bottle silhouette and label area remain clearly recognizable.",
  "camera-shake":
    "Handheld low-light phone photograph with visible multi-directional camera shake and imperfect sharpness, while the bottle remains recognizable.",
};

/**
 * Builds the full Gemini prompt for one `(scene, cameraCondition)`
 * combination. The reference photo (passed separately as an image input,
 * not here) carries the bottle's identity — this text only ever describes
 * environment, camera artifact, and the compositing requirement (design
 * doc §3's explicit hierarchy).
 */
export function buildBackdropPrompt(scene: BottleScene, cameraCondition: CameraCondition): string {
  return `Create a photorealistic photograph of the bottle shown in the provided reference image. Preserve the bottle's silhouette, proportions, glass color, closure, and overall geometry. Place the bottle on ${scene.setting}. ${scene.lighting} ${CAMERA_CONDITION_CLAUSES[cameraCondition]}

Keep the bottle's label area in its existing position and perspective, but make the label surface completely blank and uniform matte cream (${BLANK_LABEL_COLOR_HEX}). Do not generate any text, logos, illustrations, typography, seals, or other graphics. The blank label must remain suitable for later digital compositing.

Realistic materials, reflections, shadows, depth of field, and physically plausible lighting.`;
}
