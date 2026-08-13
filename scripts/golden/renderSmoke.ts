/**
 * Golden-set render smoke check (LH-006 / TRO-499, design doc §7: "CI
 * smoke: render one label headlessly, then run verify.ts. No network.").
 *
 * Renders exactly one manifest case through the real render.ts pipeline and
 * confirms the result decodes at the fixed canvas size. `render.test.ts`
 * already exercises this pipeline far more thoroughly (determinism, font
 * embedding, per-case HTML, cross-browser identity) as part of the full
 * `pnpm test` run. This file is deliberately narrower: one case, one
 * assertion, fast — so CI shows a single, clearly labeled "headless
 * Chromium still renders here" signal, decoupled from the rest of the unit
 * suite. That matters because Chromium's system dependencies are the kind
 * of thing that silently differs between a developer's machine and a fresh
 * runner (see .github/workflows/ci.yml's "Install Playwright browsers"
 * step comment) — no network call here either way; Chromium and every font
 * this renderer uses are already local, committed dependencies.
 */
import sharp from "sharp";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import { CANVAS_HEIGHT, CANVAS_WIDTH, createLabelRenderer, renderLabelImage } from "./render";

export interface RenderSmokeResult {
  readonly caseId: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/**
 * Renders the first renderable (non-`ai-generated`, non-`photographed`)
 * case in manifest order and confirms it decodes to `CANVAS_WIDTH` x
 * `CANVAS_HEIGHT`. Picks the first case rather than a hardcoded case ID so
 * renaming or reordering cases never breaks this check for an unrelated
 * reason. Excludes `photographed` (TRO-529 / LH-024) for the same reason
 * `build.ts` does: a real camera photograph is not this renderer's output,
 * and drawing its placeholder application/label fields as HTML would smoke
 * the wrong pipeline for the wrong reason.
 */
export async function runRenderSmoke(manifestPath?: string): Promise<RenderSmokeResult> {
  const manifest = loadGoldenSetManifest(manifestPath);
  const renderable = manifest.cases.find(
    (c) => c.provenance !== "ai-generated" && c.provenance !== "photographed",
  );
  if (!renderable) {
    throw new Error(
      "golden-set render smoke: no renderable (rendered / rendered+degraded / rendered+ai-backdrop) case found in the manifest",
    );
  }

  const renderer = await createLabelRenderer();
  try {
    const image = await renderLabelImage(renderable, renderer.page);
    const metadata = await sharp(image).metadata();
    if (metadata.width !== CANVAS_WIDTH || metadata.height !== CANVAS_HEIGHT) {
      throw new Error(
        `golden-set render smoke: ${renderable.caseId} rendered at ${metadata.width}x${metadata.height}, ` +
          `expected ${CANVAS_WIDTH}x${CANVAS_HEIGHT}`,
      );
    }
    return { caseId: renderable.caseId, width: metadata.width, height: metadata.height, bytes: image.length };
  } finally {
    await renderer.close();
  }
}

async function main(): Promise<void> {
  const result = await runRenderSmoke();
  console.log(
    `PASS: rendered ${result.caseId} headlessly at ${result.width}x${result.height} (${result.bytes} bytes).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
