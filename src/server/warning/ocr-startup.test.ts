/**
 * The startup test CP-2 §4.3 requires as an implementation requirement,
 * not an option: "Add a startup test with the network disabled that
 * asserts recognition succeeds and no outbound request is attempted. A
 * test that only asserts `langPath !== undefined` would pass while the
 * filename contract in point 1 is wrong."
 *
 * This spawns a fresh `node` process with `NODE_OPTIONS` pointed at
 * `ocr-network-guard.cjs` (a `--require` preload that makes `fetch` /
 * `http` / `https` throw) and runs `runWarningOcr`'s exact configuration
 * inside it — proving the real, committed language data loads and
 * recognizes text with the network unavailable. `ocr.test.ts` covers
 * ordinary correctness; this file covers the one property that matters
 * for TH-R7 (LH-020 must not reintroduce the constrained-network failure).
 *
 * A subprocess is necessary here, not an in-process `vi.stubGlobal`:
 * tesseract.js's Node loader does its language-data loading inside a
 * `worker_threads` worker, a separate JS realm `vi.stubGlobal` cannot
 * reach — `NODE_OPTIONS` is the mechanism that reaches it (confirmed
 * empirically while building this ticket; see `ocr-network-guard.cjs`'s
 * own comment).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { OCR_PAGE_SEGMENTATION_MODE, TESSDATA_DIR } from "./ocr";

const execFileAsync = promisify(execFile);
const GUARD_PATH = path.join(__dirname, "ocr-network-guard.cjs");

/** Plain Node ESM resolves a bare specifier like `"tesseract.js"` by
 * walking UP from the script's own directory through `node_modules` —
 * `os.tmpdir()` is outside the repo tree, so a child script written there
 * cannot find this project's dependencies at all. `test-results/` is
 * already gitignored (`.gitignore`'s "Build / test output" section) and
 * lives inside the repo tree, so a script written under it resolves
 * `node_modules` normally and leaves nothing to commit. */
const SCRATCH_ROOT = path.join(process.cwd(), "test-results", "TRO-468-ocr-startup");

/** The child process's own script — deliberately plain JavaScript run
 * directly by `node` (no `tsx`/TypeScript loader), so `NODE_OPTIONS`'s
 * `--require` is the only loader involved and nothing else touches the
 * network path this test is trying to isolate. It re-states
 * `runWarningOcr`'s exact worker options using the langPath THIS test
 * passes in as an argument (the real `TESSDATA_DIR`, or a deliberately
 * empty directory for the negative control), rather than importing
 * `ocr.ts` — importing a `.ts` file into a plain `node` child would need
 * its own loader, reintroducing the same complication. */
function buildChildScript(langPath: string): string {
  return `
import { createWorker, PSM } from "tesseract.js";
import sharp from "sharp";
import path from "node:path";
import os from "node:os";

async function main() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="80">' +
    '<rect width="700" height="80" fill="white"/>' +
    '<text x="10" y="50" font-family="Arial" font-size="36" fill="black">GOVERNMENT WARNING</text>' +
    '</svg>';
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const cachePath = path.join(os.tmpdir(), "labelhunter-tessdata-cache-startup-test");
  const worker = await createWorker("eng", undefined, {
    langPath: ${JSON.stringify(langPath)},
    gzip: true,
    cachePath,
    cacheMethod: "none",
  });
  await worker.setParameters({ tessedit_pageseg_mode: ${JSON.stringify(OCR_PAGE_SEGMENTATION_MODE)} });
  const { data } = await worker.recognize(png);
  await worker.terminate();
  process.stdout.write(JSON.stringify({ text: data.text, confidence: data.confidence }));
}
main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
`;
}

async function runChildScript(langPath: string, scratchDir: string): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = path.join(scratchDir, "child.mjs");
  writeFileSync(scriptPath, buildChildScript(langPath));
  return execFileAsync(process.execPath, [scriptPath], {
    env: { ...process.env, NODE_OPTIONS: `--require ${GUARD_PATH}` },
    timeout: 20_000,
  });
}

describe("runWarningOcr's configuration — network disabled via NODE_OPTIONS preload", () => {
  it(
    "recognizes text using the real committed language data, with fetch/http/https blocked",
    async () => {
      mkdirSync(SCRATCH_ROOT, { recursive: true });
      const scratchDir = mkdtempSync(path.join(SCRATCH_ROOT, "positive-"));
      try {
        const { stdout } = await runChildScript(TESSDATA_DIR, scratchDir);
        const result = JSON.parse(stdout) as { text: string; confidence: number };
        expect(result.text).toContain("GOVERNMENT WARNING");
        expect(result.confidence).toBeGreaterThan(0);
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
      }
    },
    25_000,
  );

  it(
    "negative control: an explicit langPath with NO committed file fails outright — proving there is no silent network fallback",
    async () => {
      // If setting `langPath` still let tesseract.js fall back to the
      // jsdelivr CDN when the local file is missing, this call would
      // SUCCEED via a network fetch that the guard would catch and turn
      // into a thrown error — so either failure mode (ENOENT reading the
      // local file, or the guard's own "network blocked" error) proves
      // the property this test exists to check: no fallback exists.
      mkdirSync(SCRATCH_ROOT, { recursive: true });
      const scratchDir = mkdtempSync(path.join(SCRATCH_ROOT, "negative-"));
      const emptyLangDir = mkdtempSync(path.join(os.tmpdir(), "TRO-468-empty-langpath-"));
      try {
        await expect(runChildScript(emptyLangDir, scratchDir)).rejects.toThrow();
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
        rmSync(emptyLangDir, { recursive: true, force: true });
      }
    },
    25_000,
  );
});
