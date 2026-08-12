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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OCR_PAGE_SEGMENTATION_MODE,
  OCR_TIMEOUT_MS,
  runWarningOcr,
  TESSDATA_DIR,
  TESSDATA_LANGUAGE_FILE,
  type RunWarningOcrDeps,
} from "./ocr";
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

/**
 * TRO-519: a hung `worker_threads` worker used to hang `runWarningOcr`
 * forever, and `/api/verify` with it. These tests inject a `createWorker`
 * that never resolves (or a worker whose `recognize` never resolves) —
 * never a real sleep (lessons.md rule 8) — and drive vitest's fake timers
 * forward by exactly `OCR_TIMEOUT_MS`, so the whole suite stays fast and
 * deterministic instead of waiting on a real 2-second clock.
 */
describe("runWarningOcr — timeout (TRO-519)", () => {
  afterEach(() => {
    // Always restored, even if an assertion above throws mid-test — a
    // fake-timer leak into a later, unrelated test file is exactly the
    // kind of failure that is hard to diagnose from its own symptoms.
    vi.useRealTimers();
  });

  /** A loosely-typed `createWorker` fake — `runWarningOcr` only ever calls
   * `createWorker(...)` and, on what it resolves to, `setParameters`,
   * `recognize`, and `terminate`. Implementing tesseract.js's full
   * `Worker` interface here would test nothing extra. */
  function fakeCreateWorker(worker: {
    setParameters: ReturnType<typeof vi.fn>;
    recognize: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }): RunWarningOcrDeps["createWorker"] {
    return vi.fn().mockResolvedValue(worker) as unknown as RunWarningOcrDeps["createWorker"];
  }

  const neverResolvingCreateWorker: RunWarningOcrDeps["createWorker"] = vi.fn(
    () => new Promise(() => {}),
  ) as unknown as RunWarningOcrDeps["createWorker"];

  it("degrades to null within OCR_TIMEOUT_MS when createWorker itself never resolves — the Turbopack MODULE_NOT_FOUND shape", async () => {
    vi.useFakeTimers();

    const resultPromise = runWarningOcr(Buffer.from("crop"), { createWorker: neverResolvingCreateWorker });
    await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS);

    await expect(resultPromise).resolves.toBeNull();
  });

  it("degrades to null within OCR_TIMEOUT_MS when recognize() never resolves, and terminates the worker instead of abandoning it", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const worker = {
      setParameters: vi.fn().mockResolvedValue(undefined),
      recognize: vi.fn(() => new Promise(() => {})),
      terminate,
    };

    const resultPromise = runWarningOcr(Buffer.from("crop"), { createWorker: fakeCreateWorker(worker) });
    await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS);

    await expect(resultPromise).resolves.toBeNull();
    expect(terminate).toHaveBeenCalledTimes(1); // the loser is terminated, not abandoned
  });

  it("does not fire on a fast, successful recognition, and still terminates the worker used to get it", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const worker = {
      setParameters: vi.fn().mockResolvedValue(undefined),
      recognize: vi.fn().mockResolvedValue({ data: { text: "GOVERNMENT WARNING", confidence: 91 } }),
      terminate,
    };

    const result = await runWarningOcr(Buffer.from("crop"), { createWorker: fakeCreateWorker(worker) });

    expect(result).toEqual({ text: "GOVERNMENT WARNING", confidence: 91 });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("a thrown createWorker error and a createWorker timeout converge on the identical degraded value — CP-2 §4.4 rule 3, one rule for both", async () => {
    // The thrown-error side closes a real, pre-existing coverage gap:
    // nothing in this suite previously forced runWarningOcr's OWN
    // catch-all to fire (index.test.ts's rejection test exercises a
    // rejected DEPENDENCY one layer up, in index.ts, not this function).
    const throwingCreateWorker: RunWarningOcrDeps["createWorker"] = vi.fn(() =>
      Promise.reject(new Error("createWorker: synthetic failure for this test")),
    ) as unknown as RunWarningOcrDeps["createWorker"];
    const thrownResult = await runWarningOcr(Buffer.from("crop"), { createWorker: throwingCreateWorker });

    vi.useFakeTimers();
    const timedOutPromise = runWarningOcr(Buffer.from("crop"), { createWorker: neverResolvingCreateWorker });
    await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS);
    const timedOutResult = await timedOutPromise;

    expect(thrownResult).toBeNull();
    expect(timedOutResult).toBeNull();
  });
});
