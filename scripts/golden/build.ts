/**
 * Golden-set build orchestrator (TRO-497 / LH-004, design doc §2 `build.ts`).
 *
 * Renders every `rendered` / `rendered+degraded` case in the manifest to
 * its committed image path: a clean render (`render.ts`), then — for a
 * `rendered+degraded` case — every degradation recorded in that case's
 * `degradations` list (`degrade.ts`), applied in order. `ai-generated`
 * cases are LH-005's job; this script skips them and leaves their (still
 * absent) image files alone.
 *
 * Run: `pnpm golden:build`. Deterministic on one machine with one
 * toolchain: the same committed `golden-set/manifest.json` produces the
 * same output bytes every run. Every step is a pure function — of the
 * case spec (render.ts's HTML) or explicit recorded parameters
 * (degrade.ts) — with no randomness, no clock, no network call.
 * `render.ts`'s font stacks name system fonts, not files committed to
 * the repo. A different OS can substitute different fonts and produce
 * different pixels (see render.ts's KNOWN LIMITATION comment).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import { applyDegradation } from "./degrade";
import { createLabelRenderer, renderLabelImage, type LabelRenderer } from "./render";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const IMAGES_DIR = resolve(REPO_ROOT, "golden-set/images");

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

async function buildCase(
  caseSpec: GoldenSetCase,
  renderer: LabelRenderer,
): Promise<BuildResult> {
  let image = await renderLabelImage(caseSpec, renderer.page);

  for (const degradation of caseSpec.degradations ?? []) {
    image = await applyDegradation(image, degradation);
  }

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
  const renderable = manifest.cases.filter((c) => c.provenance !== "ai-generated");

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

  const skipped = manifest.cases.length - renderable.length;
  if (skipped > 0) {
    console.log(`Skipped ${skipped} ai-generated case(s) — LH-005's job.`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
