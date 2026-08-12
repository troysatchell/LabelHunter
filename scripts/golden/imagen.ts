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
import sharp from "sharp";
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

/**
 * Filename-safe slug: letters, digits, hyphen, underscore only. `bottleId`
 * and `scene.sceneId` come from a bottle reference JSON
 * (`src/lib/golden-set/bottleReference.ts`'s `validateBottleReference` only
 * requires a non-empty string, not a filename-safe one) and flow directly
 * into `targetCaseId`, which becomes a filename in `generateOne`. A value
 * like `"x/../../../outside"` would satisfy that schema and reach
 * `path.join` unvalidated. Rejecting anything but this safe set closes that
 * off before the value is ever used in a path, regardless of severity —
 * this repo fronts a real API key on a public URL.
 */
const SAFE_SLUG = /^[A-Za-z0-9_-]+$/;

function assertSafeSlug(value: string, what: string): void {
  if (!SAFE_SLUG.test(value)) {
    throw new RangeError(
      `imagen: ${what} "${value}" is not a safe filename slug — only letters, digits, "-", and "_" are allowed`,
    );
  }
}

/**
 * Every `(scene, cameraCondition)` combination across every bottle reference
 * JSON in `referencesDir`. Throws before generating anything (and before any
 * Gemini API call — `main` calls this to build the full target list first)
 * when two targets would produce the same `targetCaseId`: two reference
 * files sharing a `bottleId`, or one reference repeating a `sceneId` or
 * `cameraCondition`. Left undetected, the later target's `generateOne` call
 * would silently overwrite the earlier one's backdrop and sidecar on disk
 * after already paying for a real Gemini image-generation call.
 */
export function enumerateTargets(referencesDir: string = REFERENCES_DIR): GenerationTarget[] {
  let files: string[];
  try {
    files = readdirSync(referencesDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const targets: GenerationTarget[] = [];
  const seenCaseIds = new Map<string, string>(); // caseId -> source file, for a readable error
  for (const file of files) {
    const bottle = loadBottleReference(path.join(referencesDir, file));
    assertSafeSlug(bottle.bottleId, `bottleId in ${file}`);
    for (const scene of bottle.scenes) {
      assertSafeSlug(scene.sceneId, `scene.sceneId in ${file}`);
      for (const cameraCondition of bottle.cameraConditions) {
        const target: GenerationTarget = {
          bottleId: bottle.bottleId,
          referencePhotoPath: path.resolve(REPO_ROOT, bottle.referencePhoto),
          scene,
          cameraCondition,
        };
        const caseId = targetCaseId(target);
        const firstSeenIn = seenCaseIds.get(caseId);
        if (firstSeenIn) {
          throw new RangeError(
            `imagen: duplicate generation target "${caseId}" — bottleId "${bottle.bottleId}", ` +
              `scene "${scene.sceneId}", cameraCondition "${cameraCondition}" (from ${file}) ` +
              `produces the same case ID as an earlier target from ${firstSeenIn}. Two reference ` +
              `files may share a bottleId, or one reference file may repeat a scene or camera ` +
              `condition — fix the reference JSON before generating anything.`,
          );
        }
        seenCaseIds.set(caseId, file);
        targets.push(target);
      }
    }
  }
  return targets;
}

export function targetCaseId(target: GenerationTarget): string {
  return `case-ai-backdrop-${target.bottleId}-${target.scene.sceneId}-${target.cameraCondition}`;
}

/** The reference-photo and generated-response image formats Gemini's `inlineData` accepts/returns that this pipeline knows how to handle. */
const SHARP_FORMAT_TO_MIME_TYPE: Readonly<Record<string, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Derives an image's real MIME type from its actual content (sharp reads
 * the file's own signature, not its extension) instead of assuming one.
 * `referencePhoto` in a bottle reference JSON is only required to be a
 * non-empty string path — nothing guarantees the file at that path is
 * actually a JPEG, and Gemini rejects a request whose declared `mimeType`
 * does not match the bytes sent.
 */
export async function detectImageMimeType(bytes: Buffer, what: string): Promise<string> {
  // sharp itself throws for bytes it cannot identify as any image format at
  // all (e.g. plain text), rather than returning a metadata object with an
  // empty `format` — caught here so every "not a format we handle" path
  // (unrecognizable bytes, or a recognized-but-unsupported format like GIF
  // or TIFF) raises the same, clearly-worded error instead of leaking
  // sharp's own low-level message on only one of the two paths.
  let format: string | undefined;
  try {
    format = (await sharp(bytes).metadata()).format;
  } catch {
    format = undefined;
  }
  const mimeType = format ? SHARP_FORMAT_TO_MIME_TYPE[format] : undefined;
  if (!mimeType) {
    throw new Error(
      `imagen: ${what} has an unsupported or undetectable image format (${JSON.stringify(format)}) — expected jpeg, png, or webp`,
    );
  }
  return mimeType;
}

/**
 * `generateOne` always writes the backdrop as `<caseId>.png` (see below).
 * Gemini's documented output MIME types include `image/jpeg` as well as
 * `image/png` (design doc §9's citation), so bytes returned with a
 * non-PNG `mimeType` are transcoded here — the one place that knows both
 * the claimed and the actual format — rather than trusting the assumption
 * baked into every other file's `.png` extension.
 */
export async function ensurePngBytes(bytes: Buffer, mimeType: string | undefined): Promise<Buffer> {
  if (mimeType === "image/png") {
    return bytes;
  }
  return sharp(bytes).png().toBuffer();
}

/**
 * Injected so `generateOne`'s orchestration is testable without a real
 * network call. Must resolve to PNG-encoded image bytes — `generateOne`
 * writes the result directly as `<caseId>.png`.
 */
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
    const referenceMimeType = await detectImageMimeType(
      referenceBytes,
      `reference photo "${referencePhotoPath}"`,
    );
    const response = await client.models.generateContent({
      model: MODEL,
      contents: [
        { text: prompt },
        { inlineData: { mimeType: referenceMimeType, data: referenceBytes.toString("base64") } },
      ],
      config: { responseModalities: ["IMAGE"] },
    });
    const imagePart = response.candidates?.[0]?.content?.parts?.find(
      (p: { inlineData?: { data?: string } }) => p.inlineData?.data,
    );
    if (!imagePart?.inlineData?.data) {
      throw new Error(`imagen: no image returned for prompt: ${prompt.slice(0, 80)}...`);
    }
    const responseBytes = Buffer.from(imagePart.inlineData.data, "base64");
    return ensurePngBytes(responseBytes, imagePart.inlineData.mimeType);
  };
}

export interface GenerationResult {
  readonly caseId: string;
  readonly backdropPath: string;
  readonly metaPath: string;
  readonly detectedQuad: DetectedQuad | null;
}

/**
 * Joins `filename` onto `dir` and confirms the result still resolves inside
 * `dir`. `caseId` (built from `assertSafeSlug`-checked components — see
 * above) should already rule out a `filename` that escapes `dir`; this is a
 * second, independent layer of the same defense-in-depth pattern
 * `scripts/golden/build.ts`'s `resolveImagePath` already uses for
 * `imagePath`, applied here regardless of how `filename` was produced.
 */
function resolveWithinDir(dir: string, filename: string, what: string): string {
  const resolvedDir = path.resolve(dir);
  const resolved = path.resolve(resolvedDir, filename);
  const rel = path.relative(resolvedDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
    throw new RangeError(`imagen: ${what} "${filename}" resolves outside ${resolvedDir} — refusing to write`);
  }
  return resolved;
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
  const backdropPath = resolveWithinDir(outDir, `${caseId}.png`, "backdrop path");
  const metaPath = resolveWithinDir(outDir, `${caseId}.meta.json`, "meta path");
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
