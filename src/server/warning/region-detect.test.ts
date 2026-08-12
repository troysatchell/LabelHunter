/**
 * Tests for warning-region detection (LH-020 / TRO-468, CP-2 §8.2).
 * Written before `region-detect.ts` — TDD, PRD §6.
 *
 * CP-2 §8.2's recommendation, adopted per open question 3: classical
 * detection (row-density + line clustering, milliseconds, no OCR) as
 * primary, so OCR still starts immediately and PRD §3.8's "concurrent with
 * Haiku" budget holds; band search (four fixed thirds + OCR) as fallback.
 *
 * The geometry helpers are tested directly on small numeric arrays first
 * (fast, exact). `detectWarningRegionClassical`/`detectWarningRegionByBandSearch`
 * are then tested against real images — synthetic ones built with sharp/SVG
 * for deterministic control, and one real golden-set label image
 * (case-01) so this is not proven only against fixtures shaped to fit the
 * algorithm. The real-image result was measured while building this
 * ticket: the detector finds the warning block and a real OCR pass on the
 * resulting crop reads it back at 95% confidence — not fabricated, and
 * reproduced here as a test.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { runWarningOcr } from "./ocr";
import {
  cropForOcr,
  detectWarningRegion,
  detectWarningRegionByBandSearch,
  detectWarningRegionClassical,
  findInkRuns,
  groupRunsIntoBlocks,
  pickBestParagraphBlock,
} from "./region-detect";

describe("findInkRuns — groups consecutive in-band rows into runs", () => {
  it("finds one run for a single contiguous band", () => {
    const fractions = [0, 0, 0.2, 0.3, 0.25, 0, 0];
    expect(findInkRuns(fractions, 0.01, 0.6)).toEqual([{ start: 2, end: 4 }]);
  });

  it("finds separate runs when a gap drops below the minimum fraction", () => {
    const fractions = [0.2, 0.2, 0, 0, 0.3, 0.3];
    expect(findInkRuns(fractions, 0.01, 0.6)).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ]);
  });

  it("excludes a row above the max fraction — a solid block, not text", () => {
    const fractions = [0.2, 0.95, 0.2];
    expect(findInkRuns(fractions, 0.01, 0.6)).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 2 },
    ]);
  });

  it("returns an empty array for an all-blank image", () => {
    expect(findInkRuns([0, 0, 0], 0.01, 0.6)).toEqual([]);
  });
});

describe("groupRunsIntoBlocks — merges nearby line runs into paragraph blocks", () => {
  it("merges runs within the gap tolerance, counting lines", () => {
    const runs = [
      { start: 10, end: 15 },
      { start: 20, end: 25 }, // gap 4
      { start: 30, end: 35 }, // gap 4
    ];
    expect(groupRunsIntoBlocks(runs, 15)).toEqual([{ start: 10, end: 35, lines: 3 }]);
  });

  it("keeps runs separate when the gap exceeds the tolerance", () => {
    const runs = [
      { start: 10, end: 15 },
      { start: 100, end: 105 }, // gap 84
    ];
    expect(groupRunsIntoBlocks(runs, 15)).toEqual([
      { start: 10, end: 15, lines: 1 },
      { start: 100, end: 105, lines: 1 },
    ]);
  });
});

describe("pickBestParagraphBlock — the ≥3-line requirement (CP-2 §8.2)", () => {
  it("picks the block with the most lines, among those meeting the minimum", () => {
    const blocks = [
      { start: 0, end: 10, lines: 1 },
      { start: 20, end: 60, lines: 4 },
      { start: 70, end: 90, lines: 2 },
    ];
    expect(pickBestParagraphBlock(blocks, 3)).toEqual({ start: 20, end: 60, lines: 4 });
  });

  it("returns null when no block meets the minimum — triggers the band-search fallback", () => {
    const blocks = [
      { start: 0, end: 10, lines: 1 },
      { start: 20, end: 30, lines: 2 },
    ];
    expect(pickBestParagraphBlock(blocks, 3)).toBeNull();
  });
});

/** A synthetic "label": a single-line brand near the top, a 5-line
 * paragraph block (standing in for the warning) below it, and a
 * single-line footer at the bottom — the same shape validated against a
 * real golden-set image while building this ticket. */
async function buildSyntheticLabel(): Promise<{ image: Buffer; width: number; height: number; paragraphTopFrac: number; paragraphBottomFrac: number }> {
  const width = 1200;
  const height = 1600;
  const brandY = 150;
  const paraTop = 500;
  const lineHeight = 46;
  const paraLines = [
    "GOVERNMENT WARNING: (1) According to the",
    "Surgeon General, women should not drink",
    "alcoholic beverages during pregnancy because",
    "of the risk of birth defects. (2) Consumption",
    "of alcoholic beverages impairs your ability.",
  ];
  const footerY = 1450;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="white"/>
    <text x="80" y="${brandY}" font-family="Georgia" font-size="90" fill="black">Old Tom Distillery</text>`;
  paraLines.forEach((line, i) => {
    svg += `<text x="90" y="${paraTop + i * lineHeight}" font-family="Arial" font-size="30" fill="black">${line}</text>`;
  });
  svg += `<text x="90" y="${footerY}" font-family="Arial" font-size="22" fill="black">750 mL</text></svg>`;

  const image = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  return {
    image,
    width,
    height,
    paragraphTopFrac: (paraTop - 40) / height,
    paragraphBottomFrac: (paraTop + (paraLines.length - 1) * lineHeight + 20) / height,
  };
}

async function buildSingleLineOnlyLabel(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
    <rect width="1200" height="800" fill="white"/>
    <text x="80" y="150" font-family="Georgia" font-size="90" fill="black">Old Tom Distillery</text>
    <text x="90" y="700" font-family="Arial" font-size="22" fill="black">750 mL</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

describe("detectWarningRegionClassical — synthetic multi-block label", () => {
  it("finds the multi-line paragraph block, not the single-line brand or footer", async () => {
    const { image, height, paragraphTopFrac, paragraphBottomFrac } = await buildSyntheticLabel();
    const region = await detectWarningRegionClassical(image);
    expect(region).not.toBeNull();
    if (!region) return;
    const regionCenterFrac = (region.y + region.height / 2) / height;
    expect(regionCenterFrac).toBeGreaterThan(paragraphTopFrac);
    expect(regionCenterFrac).toBeLessThan(paragraphBottomFrac);
    // Found a paragraph-sized block, not the whole image.
    expect(region.height).toBeLessThan(height / 2);
  });

  it("returns null when no block has three or more lines", async () => {
    const image = await buildSingleLineOnlyLabel();
    const region = await detectWarningRegionClassical(image);
    expect(region).toBeNull();
  });
});

describe("detectWarningRegionByBandSearch — CP-2 §8.2 option B, four fixed thirds", () => {
  it("returns the band whose OCR text contains GOVERNMENT, case-insensitively", async () => {
    const image = await buildSingleLineOnlyLabel();
    let call = 0;
    const fakeRecognize = async (): Promise<{ text: string; confidence: number }> => {
      call += 1;
      // The third band checked (per the region order this module defines)
      // is where the fake finds the warning.
      return call === 3 ? { text: "government warning: ...", confidence: 90 } : { text: "nothing relevant here", confidence: 90 };
    };
    const region = await detectWarningRegionByBandSearch(image, fakeRecognize);
    expect(region).not.toBeNull();
    expect(call).toBe(3);
  });

  it("returns null when no band's OCR text contains GOVERNMENT", async () => {
    const image = await buildSingleLineOnlyLabel();
    const fakeRecognize = async (): Promise<{ text: string; confidence: number }> => ({ text: "nothing relevant", confidence: 90 });
    const region = await detectWarningRegionByBandSearch(image, fakeRecognize);
    expect(region).toBeNull();
  });
});

describe("detectWarningRegion — classical first, band search as fallback (CP-2 §8.2, open question 3)", () => {
  it("uses the classical method when it succeeds, without calling OCR at all", async () => {
    const { image } = await buildSyntheticLabel();
    let ocrCalls = 0;
    const fakeRecognize = async (): Promise<{ text: string; confidence: number }> => {
      ocrCalls += 1;
      return { text: "", confidence: 0 };
    };
    const result = await detectWarningRegion(image, fakeRecognize);
    expect(result?.method).toBe("classical");
    expect(ocrCalls).toBe(0); // PRD §3.8: classical detection must not need OCR to run first.
  });

  it("falls back to band search when classical finds nothing", async () => {
    const image = await buildSingleLineOnlyLabel();
    const fakeRecognize = async (): Promise<{ text: string; confidence: number }> => ({
      text: "GOVERNMENT WARNING: fallback found it",
      confidence: 90,
    });
    const result = await detectWarningRegion(image, fakeRecognize);
    expect(result?.method).toBe("band-search");
  });

  it("returns null (single-channel final fallback, CP-2 §8.2) when both methods fail", async () => {
    const image = await buildSingleLineOnlyLabel();
    const fakeRecognize = async (): Promise<{ text: string; confidence: number }> => ({ text: "nothing", confidence: 90 });
    const result = await detectWarningRegion(image, fakeRecognize);
    expect(result).toBeNull();
  });
});

describe("cropForOcr — PNG output, never JPEG (CP-2 §8.3, open question 6)", () => {
  it("outputs PNG, not the JPEG OUTPUT_MEDIA_TYPE the API-bound pipeline variants use", async () => {
    const { image } = await buildSyntheticLabel();
    const crop = await cropForOcr(image, { x: 0, y: 0, width: 200, height: 100 });
    const metadata = await sharp(crop).metadata();
    expect(metadata.format).toBe("png");
  });
});

describe("region detection + crop + real OCR — a real golden-set label image", () => {
  it(
    "case-01: detects the warning region and reads it back correctly at high confidence",
    async () => {
      const image = readFileSync("golden-set/images/case-01-clean-match-spirits.jpg");
      const result = await detectWarningRegion(image, async (crop) => runWarningOcr(crop));
      expect(result).not.toBeNull();
      if (!result) return;
      expect(result.method).toBe("classical"); // measured: classical alone finds it on this image
      const crop = await cropForOcr(image, result.region);
      const ocrResult = await runWarningOcr(crop);
      expect(ocrResult).not.toBeNull();
      expect(ocrResult?.text).toContain("GOVERNMENT WARNING");
      expect(ocrResult?.text).toContain("Surgeon General");
      expect(ocrResult?.confidence).toBeGreaterThanOrEqual(90); // measured 95 while building this ticket
    },
    15_000,
  );
});
