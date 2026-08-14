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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 * Resolves a bottle reference's `referencePhoto` (repo-root-relative, e.g.
 * `"assets/golden/references/amber-whiskey-01.jpg"` — the same convention
 * the golden manifest's own `imagePath` uses) and confirms it stays inside
 * `REFERENCES_DIR`. `bottleReference.ts`'s `validateBottleReference` only
 * requires a non-empty string, so an absolute path or a `../../.env.local`
 * traversal would otherwise reach `readFileSync` in `generateWithGemini`
 * completely unvalidated and read an arbitrary file off disk into a real
 * Gemini API request — a read-side counterpart to the write-side
 * containment `resolveWithinDir` (below) already applies to output paths.
 */
function resolveReferencePhotoPath(referencePhoto: string, what: string): string {
  const resolved = path.resolve(REPO_ROOT, referencePhoto);
  const rel = path.relative(REFERENCES_DIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
    throw new RangeError(
      `imagen: ${what} referencePhoto "${referencePhoto}" resolves outside ${REFERENCES_DIR} — refusing to read`,
    );
  }
  return resolved;
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
    const referencePhotoPath = resolveReferencePhotoPath(bottle.referencePhoto, `bottle reference in ${file}`);
    for (const scene of bottle.scenes) {
      assertSafeSlug(scene.sceneId, `scene.sceneId in ${file}`);
      for (const cameraCondition of bottle.cameraConditions) {
        const target: GenerationTarget = {
          bottleId: bottle.bottleId,
          referencePhotoPath,
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
 * Detects the format from the response's actual bytes (`detectImageMimeType`
 * — the same content-not-assumption check the reference photo already gets)
 * rather than trusting whatever `mimeType` label the response claims. A
 * producer's self-reported type is exactly the kind of claim this repo does
 * not trust until it is checked against real content — the response's own
 * `inlineData.mimeType` is no more reliable a priori than the hardcoded
 * `"image/jpeg"` finding 6 already removed on the request side. Gemini's
 * documented output MIME types include `image/jpeg` as well as `image/png`
 * (design doc §9's citation), so non-PNG bytes are transcoded here.
 */
export async function ensurePngBytes(bytes: Buffer): Promise<Buffer> {
  const actualMimeType = await detectImageMimeType(bytes, "generated response");
  if (actualMimeType === "image/png") {
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
    return ensurePngBytes(responseBytes);
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
 * Builds the sidecar JSON text for one target and its detected quad.
 * Shared by `generateOne` (a fresh Gemini call) and
 * `rebuildSidecarFromExistingBackdrop` (no new call, an already-written
 * backdrop) so the two write exactly the same shape.
 */
function sidecarJson(caseId: string, target: GenerationTarget, quad: DetectedQuad | null): string {
  return JSON.stringify(
    {
      caseId,
      referenceBottle: target.bottleId,
      scene: target.scene.sceneId,
      cameraCondition: target.cameraCondition,
      // Only the 4 corners here, matching the manifest schema's own
      // LabelPlacementQuad shape exactly (src/lib/golden-set/types.ts) —
      // a human copies this field straight into a manifest entry
      // (golden-set/README.md's fold-in recipe, step 4). Detector
      // bookkeeping (pixelCount, imageWidth, imageHeight) is not part of
      // that schema and does not belong accreting into manifest.json; it
      // lives under the sibling "detection" key below instead, for
      // debugging this sidecar on its own.
      labelPlacement: quad
        ? {
            topLeft: quad.topLeft,
            topRight: quad.topRight,
            bottomLeft: quad.bottomLeft,
            bottomRight: quad.bottomRight,
          }
        : null,
      detection: quad
        ? { pixelCount: quad.pixelCount, imageWidth: quad.imageWidth, imageHeight: quad.imageHeight }
        : null,
      generationMetadata: {
        model: MODEL,
        resolution: RESOLUTION,
        promptVersion: PROMPT_VERSION,
        generatedAt: new Date().toISOString(),
      },
    },
    null,
    2,
  );
}

/**
 * Generates and detects one target's backdrop, writing the raw PNG and a
 * `.meta.json` sidecar to `outDir`. Never writes to
 * `golden-set/manifest.json` — see this file's module comment.
 *
 * Writes the backdrop PNG immediately after `generate` returns, before
 * detection or the sidecar write (TRO-510 review). `generate` is the paid
 * call; everything after it (blank-region detection, the sidecar
 * `writeFileSync`) can still fail on its own — a bad image, a full disk.
 * Persisting the PNG first means a later failure still leaves a real,
 * already-paid-for backdrop on disk: `rebuildSidecarFromExistingBackdrop`
 * (below) recovers it on a later run without a second Gemini call.
 */
export async function generateOne(
  target: GenerationTarget,
  generate: ImageGenerator,
  outDir: string = BACKDROPS_DIR,
): Promise<GenerationResult> {
  // Path safety first, before the network call: an unsafe target should
  // never cost a real Gemini spend before it is rejected. enumerateTargets
  // already validates every target it builds (assertSafeSlug,
  // resolveReferencePhotoPath), so this only matters for a target built by
  // hand — generateOne is exported on its own and takes a GenerationTarget,
  // not raw reference JSON — but the ordering is free to get right either way.
  const caseId = targetCaseId(target);
  mkdirSync(outDir, { recursive: true });
  const backdropPath = resolveWithinDir(outDir, `${caseId}.png`, "backdrop path");
  const metaPath = resolveWithinDir(outDir, `${caseId}.meta.json`, "meta path");

  const prompt = buildBackdropPrompt(target.scene, target.cameraCondition);
  const image = await generate(prompt, target.referencePhotoPath);
  writeFileSync(backdropPath, image);

  const quad = await detectBlankRegionQuad(image, BLANK_LABEL_COLOR_RGB, DETECTION_TOLERANCE);
  writeFileSync(metaPath, sidecarJson(caseId, target, quad));
  return { caseId, backdropPath, metaPath, detectedQuad: quad };
}

/**
 * Rebuilds a target's sidecar from its already-written backdrop PNG,
 * without calling `generate` again. Recovers a target whose backdrop
 * `generateOne` wrote (a real, already-paid-for Gemini call) but whose run
 * ended before the sidecar write — a detection failure or a disk error
 * right after that PNG write, above.
 */
async function rebuildSidecarFromExistingBackdrop(
  target: GenerationTarget,
  outDir: string,
): Promise<GenerationResult> {
  const caseId = targetCaseId(target);
  const backdropPath = resolveWithinDir(outDir, `${caseId}.png`, "backdrop path");
  const metaPath = resolveWithinDir(outDir, `${caseId}.meta.json`, "meta path");
  const image = readFileSync(backdropPath);
  const quad = await detectBlankRegionQuad(image, BLANK_LABEL_COLOR_RGB, DETECTION_TOLERANCE);
  writeFileSync(metaPath, sidecarJson(caseId, target, quad));
  return { caseId, backdropPath, metaPath, detectedQuad: quad };
}

interface ExistingArtifacts {
  readonly hasBackdrop: boolean;
  readonly hasSidecar: boolean;
}

/**
 * What already exists on disk for a target's caseId. `runGenerationBatch`
 * branches on this before ever calling `generate` — regenerating an
 * already-complete target would spend real money for no reason, and a
 * backdrop with no sidecar (a prior run's paid call that never finished)
 * is recoverable without a new call at all.
 */
function existingArtifacts(caseId: string, outDir: string): ExistingArtifacts {
  const backdropPath = resolveWithinDir(outDir, `${caseId}.png`, "backdrop path");
  const metaPath = resolveWithinDir(outDir, `${caseId}.meta.json`, "meta path");
  return { hasBackdrop: existsSync(backdropPath), hasSidecar: existsSync(metaPath) };
}

export interface GenerationBatchSummary {
  readonly generated: readonly string[];
  readonly skipped: readonly string[];
  readonly recovered: readonly string[];
  readonly failed: readonly string[];
  readonly detectionFailures: readonly string[];
  readonly spentUsd: number;
}

/**
 * Runs every target in order. Three outcomes per target: skip one already
 * complete on disk (no re-spend); recover one with a backdrop but no
 * sidecar, rebuilding the sidecar with no new call (also no re-spend);
 * otherwise generate it fresh. One target's failure is logged and does not
 * stop the rest of the batch — a single transient error must not abort a
 * paid run that already succeeded on every target before it. `log`
 * defaults to `console.log`; tests inject a no-op or a spy instead.
 */
export async function runGenerationBatch(
  targets: readonly GenerationTarget[],
  generate: ImageGenerator,
  outDir: string = BACKDROPS_DIR,
  log: (line: string) => void = console.log,
): Promise<GenerationBatchSummary> {
  const generated: string[] = [];
  const skipped: string[] = [];
  const recovered: string[] = [];
  const failed: string[] = [];
  const detectionFailures: string[] = [];
  let spentUsd = 0;

  for (const target of targets) {
    const caseId = targetCaseId(target);
    const artifacts = existingArtifacts(caseId, outDir);

    if (artifacts.hasBackdrop && artifacts.hasSidecar) {
      skipped.push(caseId);
      log(`${caseId}: SKIPPED — backdrop and sidecar already exist on disk (no re-spend).`);
      continue;
    }

    if (artifacts.hasBackdrop && !artifacts.hasSidecar) {
      try {
        const result = await rebuildSidecarFromExistingBackdrop(target, outDir);
        recovered.push(result.caseId);
        if (result.detectedQuad === null) {
          detectionFailures.push(result.caseId);
          log(`${result.caseId}: RECOVERED (no new spend) — DETECTION FAILED, needs manual placement.`);
        } else {
          log(`${result.caseId}: RECOVERED — sidecar rebuilt from an existing backdrop (no new spend).`);
        }
      } catch (err) {
        failed.push(caseId);
        const message = err instanceof Error ? err.message : String(err);
        log(`${caseId}: FAILED to recover the sidecar from an existing backdrop — ${message}.`);
      }
      continue;
    }

    try {
      const result = await generateOne(target, generate, outDir);
      spentUsd += ESTIMATED_COST_PER_IMAGE_USD;
      generated.push(result.caseId);
      if (result.detectedQuad === null) {
        detectionFailures.push(result.caseId);
        log(`${result.caseId}: DETECTION FAILED — needs manual placement. (est. spend so far: $${spentUsd.toFixed(2)})`);
      } else {
        log(`${result.caseId}: OK. (est. spend so far: $${spentUsd.toFixed(2)})`);
      }
    } catch (err) {
      failed.push(caseId);
      // generateOne writes the backdrop PNG immediately after a
      // successful (paid) generate() call, before detection or the
      // sidecar write (see generateOne's own comment). A PNG now on disk
      // for this caseId proves the paid call already happened, even
      // though generateOne threw afterward — count it so "est. spend so
      // far" never undercounts a real charge.
      if (existingArtifacts(caseId, outDir).hasBackdrop) {
        spentUsd += ESTIMATED_COST_PER_IMAGE_USD;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(
        `${caseId}: FAILED — ${message}. Continuing with the remaining targets ` +
          `(est. spend so far: $${spentUsd.toFixed(2)}).`,
      );
    }
  }

  return { generated, skipped, recovered, failed, detectionFailures, spentUsd };
}

export async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    // tsx does not load .env.local on its own (confirmed: a bare tsx run
    // with only a .env.local present leaves process.env unset) — pointing
    // at it here would be advice that does not work. Name the two things
    // that do: source .factory-env, or export the variable directly.
    throw new Error(
      "imagen: GOOGLE_API_KEY is not set. Source .factory-env in a factory worktree, or export " +
        "GOOGLE_API_KEY before running pnpm golden:imagen.",
    );
  }
  const targets = enumerateTargets();
  if (targets.length === 0) {
    console.log("imagen: no bottle references found in assets/golden/references/ — nothing to generate.");
    return;
  }

  const generate = await generateWithGemini(apiKey);
  const summary = await runGenerationBatch(targets, generate);

  console.log(
    `\nDone. ${targets.length} target(s): ${summary.generated.length} generated, ` +
      `${summary.skipped.length} skipped (already on disk), ${summary.recovered.length} recovered ` +
      `(sidecar rebuilt, no new spend), ${summary.failed.length} failed, ` +
      `${summary.detectionFailures.length} need manual placement, ~$${summary.spentUsd.toFixed(2)} estimated spend.`,
  );
  if (summary.failed.length > 0) {
    console.log(
      `Failed target(s): ${summary.failed.join(", ")}. Rerun pnpm golden:imagen — the skip-existing ` +
        `check above means an already-generated target will not be paid for again.`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
