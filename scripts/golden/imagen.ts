/**
 * Generates realistic-corpus backdrop photos via Gemini 3.1 Flash Image
 * (design doc §4/§5,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md).
 * For every `(bottle reference, scene, cameraCondition)` combination,
 * builds a prompt (imagenPrompt.ts), calls Gemini with the bottle's real
 * photo as a reference image, detects the blank label region
 * (blankRegionDetector.ts), and writes a raw backdrop PNG plus a
 * `.meta.json` sidecar to golden-set/backdrops/. Never touches
 * golden-set/manifest.json directly — a human folds a sidecar's content
 * into a rendered+ai-backdrop case entry, the same human-in-the-loop step
 * ai-generated cases already use (golden-set/README.md). Network, costs
 * money — run manually with `pnpm golden:imagen`, never from CI (design
 * doc §8's "CI never calls an image API").
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { loadBottleReference, type BottleScene } from "../../src/lib/golden-set/bottleReference";
import type { CameraCondition } from "../../src/lib/golden-set/types";
import { BLANK_LABEL_COLOR_RGB, PROMPT_VERSION, buildBackdropPrompt } from "./imagenPrompt";
import { detectBlankRegionQuad, type DetectedQuad } from "./blankRegionDetector";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REFERENCES_DIR = path.resolve(REPO_ROOT, "assets/golden/references");
const BACKDROPS_DIR = path.resolve(REPO_ROOT, "golden-set/backdrops");

const MODEL = "gemini-3.1-flash-image";
const RESOLUTION = "1K";
const DETECTION_TOLERANCE = 20;

/**
 * Standard-tier cost per image at 1K resolution, confirmed against
 * ai.google.dev/gemini-api/docs/pricing on 2026-08-11 (design doc §9).
 * An estimate for the running-total log only — prices change; verify
 * against the live billing console before trusting this for a real
 * invoice.
 */
const ESTIMATED_COST_PER_IMAGE_USD = 0.067;

export interface GenerationTarget {
  readonly bottleId: string;
  readonly referencePhotoPath: string;
  readonly scene: BottleScene;
  readonly cameraCondition: CameraCondition;
}

/** Every `(scene, cameraCondition)` combination across every bottle reference JSON in `referencesDir`. */
export function enumerateTargets(referencesDir: string = REFERENCES_DIR): GenerationTarget[] {
  let files: string[];
  try {
    files = readdirSync(referencesDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const targets: GenerationTarget[] = [];
  for (const file of files) {
    const bottle = loadBottleReference(path.join(referencesDir, file));
    for (const scene of bottle.scenes) {
      for (const cameraCondition of bottle.cameraConditions) {
        targets.push({
          bottleId: bottle.bottleId,
          referencePhotoPath: path.resolve(REPO_ROOT, bottle.referencePhoto),
          scene,
          cameraCondition,
        });
      }
    }
  }
  return targets;
}

export function targetCaseId(target: GenerationTarget): string {
  return `case-ai-backdrop-${target.bottleId}-${target.scene.sceneId}-${target.cameraCondition}`;
}

/** Injected so `generateOne`'s orchestration is testable without a real network call. */
export type ImageGenerator = (prompt: string, referencePhotoPath: string) => Promise<Buffer>;

/**
 * Builds a real `ImageGenerator` backed by the Gemini API. See this file's
 * module comment and this task's "verify before wiring" note: the exact
 * `@google/genai` call shape below is best-effort from documentation
 * research, not a live-tested call — confirm the method name and
 * request/response shape against the installed SDK's own types before
 * trusting it for a real run.
 */
export async function generateWithGemini(apiKey: string): Promise<ImageGenerator> {
  const client = new GoogleGenAI({ apiKey });
  return async (prompt: string, referencePhotoPath: string): Promise<Buffer> => {
    const referenceBytes = readFileSync(referencePhotoPath);
    const response = await client.models.generateContent({
      model: MODEL,
      contents: [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: referenceBytes.toString("base64") } },
      ],
      config: { responseModalities: ["IMAGE"] },
    });
    const imagePart = response.candidates?.[0]?.content?.parts?.find(
      (p: { inlineData?: { data?: string } }) => p.inlineData?.data,
    );
    if (!imagePart?.inlineData?.data) {
      throw new Error(`imagen: no image returned for prompt: ${prompt.slice(0, 80)}...`);
    }
    return Buffer.from(imagePart.inlineData.data, "base64");
  };
}

export interface GenerationResult {
  readonly caseId: string;
  readonly backdropPath: string;
  readonly metaPath: string;
  readonly detectedQuad: DetectedQuad | null;
}

/**
 * Generates and detects one target's backdrop, writing the raw PNG and a
 * `.meta.json` sidecar to `outDir`. Never writes to
 * `golden-set/manifest.json` — see this file's module comment.
 */
export async function generateOne(
  target: GenerationTarget,
  generate: ImageGenerator,
  outDir: string = BACKDROPS_DIR,
): Promise<GenerationResult> {
  const prompt = buildBackdropPrompt(target.scene, target.cameraCondition);
  const image = await generate(prompt, target.referencePhotoPath);
  const quad = await detectBlankRegionQuad(image, BLANK_LABEL_COLOR_RGB, DETECTION_TOLERANCE);

  const caseId = targetCaseId(target);
  mkdirSync(outDir, { recursive: true });
  const backdropPath = path.join(outDir, `${caseId}.png`);
  const metaPath = path.join(outDir, `${caseId}.meta.json`);
  writeFileSync(backdropPath, image);
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        caseId,
        referenceBottle: target.bottleId,
        scene: target.scene.sceneId,
        cameraCondition: target.cameraCondition,
        labelPlacement: quad,
        generationMetadata: {
          model: MODEL,
          resolution: RESOLUTION,
          promptVersion: PROMPT_VERSION,
          generatedAt: new Date().toISOString(),
        },
      },
      null,
      2,
    ),
  );
  return { caseId, backdropPath, metaPath, detectedQuad: quad };
}

export async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("imagen: GOOGLE_API_KEY is not set (see .env.local.example)");
  }
  const targets = enumerateTargets();
  if (targets.length === 0) {
    console.log("imagen: no bottle references found in assets/golden/references/ — nothing to generate.");
    return;
  }

  const generate = await generateWithGemini(apiKey);
  let spentUsd = 0;
  let detectionFailures = 0;

  for (const target of targets) {
    const result = await generateOne(target, generate);
    spentUsd += ESTIMATED_COST_PER_IMAGE_USD;
    if (result.detectedQuad === null) {
      detectionFailures++;
      console.log(`${result.caseId}: DETECTION FAILED — needs manual placement. (est. spend so far: $${spentUsd.toFixed(2)})`);
    } else {
      console.log(`${result.caseId}: OK. (est. spend so far: $${spentUsd.toFixed(2)})`);
    }
  }

  console.log(
    `\nDone. ${targets.length} generated, ${detectionFailures} need manual placement, ~$${spentUsd.toFixed(2)} estimated spend.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
