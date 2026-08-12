/**
 * Tests for the tesseract.js OCR wrapper (LH-020 / TRO-468, CP-2 §4.3,
 * §8.3). Written before `ocr.ts` — TDD, PRD §6.
 *
 * Real recognition calls against the actual committed language data
 * (`tessdata/eng.traineddata.gz`) on a small synthetic image built with
 * sharp — not a mock. `ocr-startup.test.ts` is the separate, dedicated
 * "network disabled" startup test CP-2 §4.3 requires; this file checks
 * ordinary correctness.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { OCR_PAGE_SEGMENTATION_MODE, runWarningOcr, TESSDATA_DIR, TESSDATA_LANGUAGE_FILE } from "./ocr";
import { OCR_CONFIDENCE_FLOOR } from "./reconcile";

/** A small, crop-sized synthetic warning block — built with sharp/SVG, not
 * a real label photo, so this test is fast and has no external
 * dependency. `ocr-startup.test.ts` and `region-detect.test.ts` add
 * coverage against a real golden-set image. */
async function renderWarningCrop(text: string[]): Promise<Buffer> {
  const lineHeight = 34;
  const height = text.length * lineHeight + 20;
  const lines = text
    .map((line, i) => `<text x="10" y="${30 + i * lineHeight}" font-family="Arial" font-size="26" fill="black">${line}</text>`)
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}">
    <rect width="1000" height="${height}" fill="white"/>
    ${lines}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("committed language data", () => {
  it(`${TESSDATA_LANGUAGE_FILE} exists at TESSDATA_DIR`, () => {
    // Reads the real committed file — a test that only checked
    // `langPath !== undefined` would pass even if the filename contract
    // were wrong (CP-2 §4.3's own named failure mode). This test fails if
    // the committed file is ever renamed, moved, or deleted.
    const bytes = readFileSync(`${TESSDATA_DIR}/${TESSDATA_LANGUAGE_FILE}`);
    expect(bytes.length).toBeGreaterThan(1_000_000); // a real ~3 MB trained-data file, not a stub
  });

  it("is gzip-compressed data, matching the gzip: true option runWarningOcr passes", () => {
    const bytes = readFileSync(`${TESSDATA_DIR}/${TESSDATA_LANGUAGE_FILE}`);
    // gzip magic number, 0x1F 0x8B — the same check tesseract.js's own
    // loader uses (CP-2 Appendix B, worker-script/index.js).
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });
});

describe("OCR_PAGE_SEGMENTATION_MODE", () => {
  it("is tesseract.js's own PSM.SINGLE_BLOCK constant, confirmed against the installed library, not guessed", () => {
    expect(OCR_PAGE_SEGMENTATION_MODE).toBe("6");
  });
});

describe("runWarningOcr — real recognition against the committed language data", () => {
  it(
    "reads a clean synthetic warning block and returns text plus a 0-100 confidence",
    async () => {
      const crop = await renderWarningCrop([
        "GOVERNMENT WARNING: (1) According to the",
        "Surgeon General, women should not drink",
        "alcoholic beverages during pregnancy.",
      ]);
      const result = await runWarningOcr(crop);
      expect(result).not.toBeNull();
      expect(result?.text).toContain("GOVERNMENT WARNING");
      expect(result?.text).toContain("Surgeon General");
      expect(result?.confidence).toBeGreaterThan(0);
      expect(result?.confidence).toBeLessThanOrEqual(100);
    },
    15_000,
  );

  it(
    "returns low confidence rather than throwing on a blank image",
    async () => {
      const blank = await sharp({
        create: { width: 400, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .png()
        .toBuffer();
      const result = await runWarningOcr(blank);
      // Observed, not assumed: a blank crop must not throw, and must not
      // be reported as a confident read. Measured while building this
      // ticket: a blank image reports confidence 0 — well under
      // OCR_CONFIDENCE_FLOOR, the threshold reconcile.ts actually gates
      // on, so this connects the observation to the value that matters.
      expect(result).not.toBeNull();
      expect(result?.text.trim()).toBe("");
      expect(result?.confidence).toBeLessThan(OCR_CONFIDENCE_FLOOR);
    },
    15_000,
  );
});
