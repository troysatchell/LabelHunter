/**
 * Golden-set build orchestrator (TRO-497 / LH-004, design doc §2 `build.ts`).
 *
 * Renders every `rendered` / `rendered+degraded` case in the manifest to
 * its committed image path: a clean render (`render.ts`), then — for a
 * `rendered+degraded` case — every degradation recorded in that case's
 * `degradations` list (`degrade.ts`), applied in order. `ai-generated`
 * cases are a future ticket's job; this script skips them and leaves their
 * (still absent) image files alone. `photographed` cases (TRO-529 / LH-024) are
 * skipped too, for a sharper reason than "no image yet": their image
 * already exists and is a real camera photograph — running it through this
 * renderer would silently overwrite that photograph with synthetic
 * `<html>`-drawn text at the same file path, destroying the one thing the
 * case exists to test. `resolveImagePath` below would also refuse the
 * write (a `photographed` case's `imagePath` lives under
 * `assets/golden/references/`, outside `golden-set/images/`), but skipping
 * up front means one `photographed` case in the manifest cannot abort the
 * whole build for every other case behind it.
 *
 * Run: `pnpm golden:build`. Deterministic on one machine with one
 * toolchain: the same committed `golden-set/manifest.json` produces the
 * same output bytes every run. Every step is a pure function — of the
 * case spec (render.ts's HTML) or explicit recorded parameters
 * (degrade.ts) — with no randomness, no clock, no network call.
 * `render.ts`'s fonts are embedded `@font-face` `data:` URIs read from
 * pinned npm packages (TRO-505), not system-font names. This build no
 * longer depends on which fonts the running machine has installed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import { compositeLabelOntoBackdrop } from "./compositeBackdrop";
import { applyDegradation } from "./degrade";
import { createLabelRenderer, renderLabelImage, type LabelRenderer } from "./render";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const IMAGES_DIR = resolve(REPO_ROOT, "golden-set/images");
const BACKDROPS_DIR = resolve(REPO_ROOT, "golden-set/backdrops");

/**
 * Resolves `imagePath` and confirms it lands inside `golden-set/images/`.
 * The loader already checks `imagePath` is a string starting with
 * `"golden-set/images/"` (`loader.ts`'s `checkCase`), but that is a string
 * prefix check — it would not catch a crafted value like
 * `"golden-set/images/../../etc/passwd"`, which also starts with that
 * prefix as plain text. This resolves the real path and checks it stays
 * inside the directory before any write. `golden-set/manifest.json` is a
 * committed, reviewed file, not runtime input, so this is defense in
 * depth, not a response to an active threat — cheap enough to add anyway.
 */
function resolveImagePath(imagePath: string): string {
  const resolved = resolve(REPO_ROOT, imagePath);
  const rel = relative(IMAGES_DIR, resolved);
  if (rel.startsWith("..") || rel === "") {
    throw new RangeError(
      `build: imagePath "${imagePath}" resolves outside golden-set/images/ — refusing to write`,
    );
  }
  return resolved;
}

/**
 * mozjpeg at this quality keeps every rendered label (large flat areas,
 * modest text) well under the ticket's ~500KB-per-image target — see
 * CHANGES.md for the measured total after a real build run.
 */
const JPEG_QUALITY = 82;

interface BuildResult {
  readonly caseId: string;
  readonly bytes: number;
  readonly path: string;
}

/** The original render-and-degrade path, unchanged — pulled into its own function only so `buildCase` can dispatch on provenance. */
async function buildRenderedCase(caseSpec: GoldenSetCase, renderer: LabelRenderer): Promise<Buffer> {
  let image = await renderLabelImage(caseSpec, renderer.page);
  for (const degradation of caseSpec.degradations ?? []) {
    image = await applyDegradation(image, degradation);
  }
  return image;
}

/**
 * Builds a `rendered+ai-backdrop` case: renders the label (same exact-text
 * guarantee as every other case), loads the case's committed backdrop
 * photo, and warps the label into the case's recorded `labelPlacement`
 * (design doc §5/§6). No network call — the backdrop was already
 * generated and committed by a prior, separate `pnpm golden:imagen` run;
 * this only re-runs the deterministic parts, matching `rendered+degraded`
 * cases' own determinism contract.
 */
export async function buildAiBackdropCase(
  caseSpec: GoldenSetCase,
  renderer: LabelRenderer,
  backdropsDir: string = BACKDROPS_DIR,
): Promise<Buffer> {
  if (!caseSpec.labelPlacement) {
    throw new RangeError(
      `build: case "${caseSpec.caseId}" has provenance "rendered+ai-backdrop" but no labelPlacement — ` +
        `run pnpm golden:imagen and fold its .meta.json output into the manifest entry first`,
    );
  }
  const labelImage = await renderLabelImage(caseSpec, renderer.page);
  const backdropPath = resolve(backdropsDir, `${caseSpec.caseId}.png`);
  let backdropImage: Buffer;
  try {
    backdropImage = readFileSync(backdropPath);
  } catch {
    // A bare ENOENT here names a file path, not a case. The most common
    // cause: a hand-authored manifest entry's caseId does not exactly
    // match the caseId pnpm golden:imagen generated for its backdrop and
    // sidecar (golden-set/README.md's fold-in recipe, step 4).
    throw new RangeError(
      `build: case "${caseSpec.caseId}" expects a backdrop photo at ${backdropPath}, but no file exists ` +
        `there. Confirm this case's "caseId" is exactly the sidecar's generated case ID ` +
        `(golden-set/README.md's fold-in recipe, step 4).`,
    );
  }
  return compositeLabelOntoBackdrop(backdropImage, labelImage, caseSpec.labelPlacement);
}

async function buildCase(
  caseSpec: GoldenSetCase,
  renderer: LabelRenderer,
  backdropsDir: string = BACKDROPS_DIR,
): Promise<BuildResult> {
  const image =
    caseSpec.provenance === "rendered+ai-backdrop"
      ? await buildAiBackdropCase(caseSpec, renderer, backdropsDir)
      : await buildRenderedCase(caseSpec, renderer);

  // Flattens any alpha onto white before the JPEG encode, matching
  // pipeline.ts's own reasoning for its `.flatten()` calls. sharp's JPEG
  // encoder composites alpha over black by default. Today every source
  // pixel is already opaque (render.ts paints an opaque white body;
  // applyRotate/applyPerspective fill new corners with white), so this is a
  // no-op — defense in depth against a future transform that introduces a
  // transparent pixel, not a response to a bug in the current pipeline.
  const jpeg = await sharp(image)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  const outPath = resolveImagePath(caseSpec.imagePath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, jpeg);

  return { caseId: caseSpec.caseId, bytes: jpeg.length, path: outPath };
}

async function main(): Promise<void> {
  const manifest = loadGoldenSetManifest();
  const renderable = manifest.cases.filter(
    (c) => c.provenance !== "ai-generated" && c.provenance !== "photographed",
  );

  const renderer = await createLabelRenderer();
  const results: BuildResult[] = [];
  try {
    for (const caseSpec of renderable) {
      results.push(await buildCase(caseSpec, renderer));
    }
  } finally {
    await renderer.close();
  }

  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  console.log(
    `Rendered ${results.length} image(s), ${totalBytes} bytes total (${(totalBytes / 1024).toFixed(1)} KB).`,
  );
  for (const r of results) {
    console.log(`  ${r.caseId}: ${r.bytes} bytes`);
  }

  const aiGeneratedSkipped = manifest.cases.filter((c) => c.provenance === "ai-generated").length;
  const photographedSkipped = manifest.cases.filter((c) => c.provenance === "photographed").length;
  if (aiGeneratedSkipped > 0) {
    console.log(`Skipped ${aiGeneratedSkipped} ai-generated case(s) — a future ticket's job.`);
  }
  if (photographedSkipped > 0) {
    console.log(
      `Skipped ${photographedSkipped} photographed case(s) — real photographs, never rendered (TRO-529 / LH-024).`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
