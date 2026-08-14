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
import {
  WILD_LABEL_PROMPT_VERSION,
  WILD_LABEL_REQUESTS,
  buildWildLabelPrompt,
  type WildLabelRequest,
} from "./wildLabelPrompt";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REFERENCES_DIR = path.resolve(REPO_ROOT, "assets/golden/references");
const BACKDROPS_DIR = path.resolve(REPO_ROOT, "golden-set/backdrops");
/**
 * Staging area for the wild-label track (LH-027 / TRO-530). NOT
 * `golden-set/images/` — a wild-label case is not folded into
 * `golden-set/manifest.json` until a human confirms its transcription and
 * sets `verified: true` (the loader's own tested rule — see
 * `golden-set/wild-labels/README.md`). Committing straight to
 * `golden-set/images/` before that would leave the image as an orphan no
 * manifest case points to (`scripts/golden/verify.ts` check 3). This
 * mirrors job 1's own `BACKDROPS_DIR` staging convention above.
 */
const WILD_LABELS_DIR = path.resolve(REPO_ROOT, "golden-set/wild-labels");

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

// ---------------------------------------------------------------------------
// Wild labels (LH-027 / TRO-530, design doc §5, job 2). Job 1 above
// composites a renderer's exact-text label onto a Gemini-generated photo.
// Job 2 has Gemini draw the whole label -- brand, class/type, ABV, net
// contents, and the government warning -- as one flat piece of artwork, no
// bottle, no backdrop, no compositing, no warp (the ticket's own words).
// `wildLabelPrompt.ts` owns the prompt text; this section owns the API
// call, the real per-call cost, and the sidecar writer, reusing job 1's
// `ensurePngBytes`, `assertSafeSlug`, and `resolveWithinDir` exactly as the
// ticket asks ("job 1's code already carries the API client, the cost log,
// and the sidecar writer").
// ---------------------------------------------------------------------------

const WILD_LABEL_MODEL = "gemini-3.1-flash-image";
const WILD_LABEL_RESOLUTION = "1K";

/**
 * gemini-3.1-flash-image standard-tier pricing per 1M tokens, confirmed
 * LIVE against ai.google.dev/gemini-api/docs/pricing on 2026-08-13 (the
 * same page job 1's `ESTIMATED_COST_PER_IMAGE_USD` cites, two days
 * earlier -- unchanged): $0.50 (text/image) input, $3.00 (text and
 * thinking) output, $60.00 (images) output. The page also confirms 1K
 * resolution costs exactly 1120 image-output tokens -- the real value a
 * live test call's own `usageMetadata.candidatesTokensDetails` reported
 * (1120 tokens, IMAGE modality), cross-checked against the documented
 * count rather than assumed.
 */
const WILD_LABEL_INPUT_USD_PER_1M_TOKENS = 0.5;
const WILD_LABEL_TEXT_OUTPUT_USD_PER_1M_TOKENS = 3;
const WILD_LABEL_IMAGE_OUTPUT_USD_PER_1M_TOKENS = 60;

/** Real, per-call token usage this generation actually consumed -- never an estimate. */
export interface WildLabelUsage {
  readonly promptTokenCount: number;
  readonly imageOutputTokenCount: number;
  /** Every non-IMAGE output token (text, thinking, or any other modality Gemini reports), billed at the text/thinking output rate. */
  readonly otherOutputTokenCount: number;
}

/** The subset of Gemini's real `GenerateContentResponse.usageMetadata` this file reads. */
interface RawWildLabelUsageMetadata {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly candidatesTokensDetails?: ReadonlyArray<{ readonly modality?: string; readonly tokenCount?: number }>;
  /** The SDK's own `GenerateContentResponseUsageMetadata` type documents
   * `totalTokenCount` as the sum of `promptTokenCount`, `candidatesTokenCount`,
   * `toolUsePromptTokenCount`, AND `thoughtsTokenCount` — this field is
   * genuinely separate from `candidatesTokenCount`, not a subset of it. A
   * reasoning-capable model can report a nonzero value here on some calls;
   * billed at the same "text and thinking" output rate `otherOutputTokenCount`
   * already uses. Optional ("if applicable" per the SDK's own doc comment)
   * — absent reads as 0, not an error. */
  readonly thoughtsTokenCount?: number;
}

/** Real Gemini token counts are always non-negative integers — a
 * fractional or negative count is itself a signal of bad data (CodeRabbit
 * finding, round 2), not a value worth silently feeding into a cost
 * calculation. One shared check, so every call site (`promptTokenCount`,
 * `candidatesTokenCount`, each IMAGE detail's `tokenCount`,
 * `thoughtsTokenCount`) applies the exact same rule. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Derives `WildLabelUsage` from a real API response's `usageMetadata`.
 * Throws — never silently defaults to 0 — when `promptTokenCount`,
 * `candidatesTokenCount`, or a real IMAGE-modality token count is missing,
 * not a non-negative integer, or internally inconsistent (CodeRabbit
 * findings, rounds 1-2: a degraded real response must not silently read
 * as "spent $0", and a fractional or negative count is itself bad data,
 * not a value to feed into a cost calculation. CLAUDE.md's "never
 * fabricate a number" applies to a fabricated zero exactly as much as to
 * a fabricated positive one). Also folds in `thoughtsTokenCount` when
 * present (CodeRabbit finding, round 3 — see `RawWildLabelUsageMetadata`'s
 * own comment on why this is a real, separate cost component, not covered
 * by `candidatesTokenCount`). `generateWildLabelWithGemini`'s generator
 * does not catch any of this — a thrown error here aborts the whole call
 * before `generateWildLabelOne` ever writes an image or a sidecar with a
 * wrong cost.
 */
export function extractWildLabelUsage(usageMetadata: RawWildLabelUsageMetadata | undefined): WildLabelUsage {
  if (!usageMetadata) {
    throw new Error("imagen: wild-label response carried no usageMetadata -- cannot compute its real cost");
  }
  if (!isNonNegativeInteger(usageMetadata.promptTokenCount)) {
    throw new Error(
      `imagen: wild-label response usageMetadata's promptTokenCount must be a non-negative integer (got ${JSON.stringify(usageMetadata.promptTokenCount)}) -- cannot compute its real cost`,
    );
  }
  if (!isNonNegativeInteger(usageMetadata.candidatesTokenCount)) {
    throw new Error(
      `imagen: wild-label response usageMetadata's candidatesTokenCount must be a non-negative integer (got ${JSON.stringify(usageMetadata.candidatesTokenCount)}) -- cannot compute its real cost`,
    );
  }
  let thoughtsTokenCount = 0;
  if (usageMetadata.thoughtsTokenCount !== undefined) {
    if (!isNonNegativeInteger(usageMetadata.thoughtsTokenCount)) {
      throw new Error(
        `imagen: wild-label response usageMetadata's thoughtsTokenCount must be a non-negative integer when present (got ${JSON.stringify(usageMetadata.thoughtsTokenCount)}) -- cannot compute its real cost`,
      );
    }
    thoughtsTokenCount = usageMetadata.thoughtsTokenCount;
  }
  const imageDetails = (usageMetadata.candidatesTokensDetails ?? []).filter((detail) => detail.modality === "IMAGE");
  if (imageDetails.length === 0) {
    throw new Error(
      "imagen: wild-label response usageMetadata carries no IMAGE-modality entry in candidatesTokensDetails -- cannot compute its real image-output cost",
    );
  }
  let imageOutputTokenCount = 0;
  for (const detail of imageDetails) {
    if (!isNonNegativeInteger(detail.tokenCount)) {
      throw new Error(
        `imagen: wild-label response usageMetadata's IMAGE detail tokenCount must be a non-negative integer (got ${JSON.stringify(detail.tokenCount)}) -- cannot compute its real image-output cost`,
      );
    }
    imageOutputTokenCount += detail.tokenCount;
  }
  // Checked BEFORE folding in thoughtsTokenCount: a large thoughtsTokenCount
  // could otherwise push the final sum back to non-negative and mask a
  // genuine candidatesTokenCount/imageOutputTokenCount inconsistency —
  // thoughtsTokenCount is a real, separate cost component (this
  // function's own doc comment), never a fudge factor for a different
  // field's bad data.
  const otherFromCandidates = usageMetadata.candidatesTokenCount - imageOutputTokenCount;
  if (otherFromCandidates < 0) {
    throw new Error(
      `imagen: wild-label response usageMetadata is internally inconsistent -- candidatesTokenCount (${usageMetadata.candidatesTokenCount}) is less than its own IMAGE token count (${imageOutputTokenCount})`,
    );
  }
  return {
    promptTokenCount: usageMetadata.promptTokenCount,
    imageOutputTokenCount,
    otherOutputTokenCount: otherFromCandidates + thoughtsTokenCount,
  };
}

/**
 * Computes the exact real cost of one wild-label generation call from its
 * real token usage (`extractWildLabelUsage`) and the live-confirmed
 * pricing constants above. Never an estimate: every input is either a real
 * count the API reported for THIS call, or a price this file's own module
 * comment cites a live source for.
 */
export function computeWildLabelCostUsd(usage: WildLabelUsage): number {
  const inputCostUsd = (usage.promptTokenCount / 1_000_000) * WILD_LABEL_INPUT_USD_PER_1M_TOKENS;
  const imageOutputCostUsd = (usage.imageOutputTokenCount / 1_000_000) * WILD_LABEL_IMAGE_OUTPUT_USD_PER_1M_TOKENS;
  const otherOutputCostUsd = (usage.otherOutputTokenCount / 1_000_000) * WILD_LABEL_TEXT_OUTPUT_USD_PER_1M_TOKENS;
  return inputCostUsd + imageOutputCostUsd + otherOutputCostUsd;
}

/** One real generation call's result: the image bytes plus the real usage that produced `computeWildLabelCostUsd`'s input. */
export interface WildLabelGenerationOutput {
  readonly image: Buffer;
  readonly usage: WildLabelUsage;
}

/**
 * Injected so `generateWildLabelOne`'s orchestration is testable without a
 * real network call -- the wild-label counterpart to job 1's
 * `ImageGenerator`. Takes only a prompt: unlike a backdrop, a wild label
 * has no reference photo (design doc §5, ticket item "no bottle").
 */
export type WildLabelGenerator = (prompt: string) => Promise<WildLabelGenerationOutput>;

/**
 * Builds a real `WildLabelGenerator` backed by the Gemini API -- a
 * text-only counterpart to job 1's `generateWithGemini` above (no
 * `inlineData` reference image in the request). Live-tested against the
 * real API on 2026-08-13 (unlike job 1's own generator, which its own doc
 * comment flags as best-effort/untested): confirmed model name, confirmed
 * request/response shape, confirmed `usageMetadata` shape.
 */
export async function generateWildLabelWithGemini(apiKey: string): Promise<WildLabelGenerator> {
  const client = new GoogleGenAI({ apiKey });
  return async (prompt: string): Promise<WildLabelGenerationOutput> => {
    const response = await client.models.generateContent({
      model: WILD_LABEL_MODEL,
      contents: [{ text: prompt }],
      // imageConfig.imageSize makes the request match the sidecar's own
      // generationMetadata.resolution claim explicitly, rather than only
      // by coincidence with the SDK's documented default (CodeRabbit
      // finding, round 2). The SDK docs state "1K" is already the default
      // when this is omitted -- confirmed against 6 real calls this ticket
      // made, every one reporting exactly 1120 IMAGE tokens (the 1K tier,
      // per ai.google.dev/gemini-api/docs/pricing) -- so this is a
      // forensic-accuracy fix, not a behavior change.
      config: { responseModalities: ["IMAGE"], imageConfig: { imageSize: WILD_LABEL_RESOLUTION } },
    });
    const imagePart = response.candidates?.[0]?.content?.parts?.find(
      (p: { inlineData?: { data?: string } }) => p.inlineData?.data,
    );
    if (!imagePart?.inlineData?.data) {
      throw new Error(`imagen: no wild-label image returned for prompt: ${prompt.slice(0, 80)}...`);
    }
    // extractWildLabelUsage itself throws on a missing/incomplete/
    // inconsistent usageMetadata (its own doc comment) -- no separate
    // pre-check needed here; letting it validate is the single source of
    // truth for what counts as usable usage data.
    const responseBytes = Buffer.from(imagePart.inlineData.data, "base64");
    const image = await ensurePngBytes(responseBytes);
    const usage = extractWildLabelUsage(response.usageMetadata);
    return { image, usage };
  };
}

export interface WildLabelGenerationResult {
  readonly caseId: string;
  readonly imagePath: string;
  readonly metaPath: string;
  readonly costUsd: number;
}

/**
 * Generates one wild label and writes the raw PNG plus a `.meta.json`
 * forensic sidecar (prompt actually sent, real usage, real computed cost,
 * generation metadata) to `outDir`. Reuses `assertSafeSlug` and
 * `resolveWithinDir` from job 1 above unchanged -- the same path-safety
 * reasoning applies verbatim: `caseId` must stay a safe filename slug
 * before it ever reaches a real, paid Gemini call.
 *
 * The sidecar records what was generated; it does NOT record ground
 * truth. A human transcribes what actually rendered by looking at the
 * committed image and hand-authors the candidate case entry separately
 * (`golden-set/wild-labels/candidates.json`) -- see this file's module
 * comment and `golden-set/wild-labels/README.md`.
 */
export async function generateWildLabelOne(
  request: WildLabelRequest,
  generate: WildLabelGenerator,
  outDir: string = WILD_LABELS_DIR,
): Promise<WildLabelGenerationResult> {
  assertSafeSlug(request.caseId, "wild-label caseId");
  mkdirSync(outDir, { recursive: true });
  const imagePath = resolveWithinDir(outDir, `${request.caseId}.png`, "wild-label image path");
  const metaPath = resolveWithinDir(outDir, `${request.caseId}.meta.json`, "wild-label meta path");

  const prompt = buildWildLabelPrompt(request);
  const { image, usage } = await generate(prompt);
  const costUsd = computeWildLabelCostUsd(usage);

  writeFileSync(imagePath, image);
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        caseId: request.caseId,
        prompt,
        usage,
        costUsd,
        generationMetadata: {
          model: WILD_LABEL_MODEL,
          resolution: WILD_LABEL_RESOLUTION,
          promptVersion: WILD_LABEL_PROMPT_VERSION,
          generatedAt: new Date().toISOString(),
        },
      },
      null,
      2,
    ),
  );

  return { caseId: request.caseId, imagePath, metaPath, costUsd };
}

/** Generates every request in `requests` (default: the full `WILD_LABEL_REQUESTS` set), in order. */
export async function generateAllWildLabels(
  generate: WildLabelGenerator,
  outDir: string = WILD_LABELS_DIR,
  requests: readonly WildLabelRequest[] = WILD_LABEL_REQUESTS,
): Promise<WildLabelGenerationResult[]> {
  const results: WildLabelGenerationResult[] = [];
  for (const request of requests) {
    results.push(await generateWildLabelOne(request, generate, outDir));
  }
  return results;
}

/**
 * CLI entry point for the wild-label track: `pnpm golden:imagen -- --wild`.
 * Network, costs real money -- run manually, never from CI, same posture
 * `main` below documents for backdrops. Writes to `WILD_LABELS_DIR`, never
 * to `golden-set/manifest.json` (this file's own module comment on
 * `WILD_LABELS_DIR`).
 */
export async function mainWild(): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("imagen: GOOGLE_API_KEY is not set (see .env.local.example)");
  }
  const generate = await generateWildLabelWithGemini(apiKey);
  let spentUsd = 0;
  const results: WildLabelGenerationResult[] = [];
  try {
    for (const request of WILD_LABEL_REQUESTS) {
      const result = await generateWildLabelOne(request, generate);
      spentUsd += result.costUsd;
      results.push(result);
      console.log(`${result.caseId}: OK, $${result.costUsd.toFixed(4)} (running total $${spentUsd.toFixed(4)})`);
    }
  } finally {
    // Always prints the real accumulated spend, even when a later request
    // in the list throws (a transient API error, most likely) -- every
    // dollar already spent on the successful calls before the throw is
    // real money, and it must never go unreported just because a later
    // call in the same run failed (CodeRabbit finding, round 4; CLAUDE.md
    // "never fabricate a number" -- an unreported real cost is exactly as
    // dishonest as a fabricated one).
    console.log(
      `\n${results.length}/${WILD_LABEL_REQUESTS.length} wild label(s) generated, $${spentUsd.toFixed(4)} real spend so far ` +
        `(exact, from each call's real usageMetadata -- see each .meta.json for its own figure).`,
    );
  }
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
  const quad = await detectBlankRegionQuad(image, BLANK_LABEL_COLOR_RGB, DETECTION_TOLERANCE);

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
  const entryPoint = process.argv.includes("--wild") ? mainWild : main;
  entryPoint().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
