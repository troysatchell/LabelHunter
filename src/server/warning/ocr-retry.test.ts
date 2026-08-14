/**
 * Tests for the OCR retry decision and preprocessing variant (TRO-583).
 * Written before `index.ts`'s wiring — TDD, PRD §6. `index.test.ts`
 * covers the wiring into `runOcrChannel`; this file covers the two pure
 * pieces in isolation.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { OCR_CONFIDENCE_FLOOR } from "./reconcile";
import { buildOcrRetryVariant, OCR_RETRY_UPSCALE_FACTOR, shouldRetryOcr } from "./ocr-retry";

describe("shouldRetryOcr", () => {
  it("retries when the first attempt is null — runWarningOcr's shared thrown-or-timed-out shape (TRO-519)", () => {
    expect(shouldRetryOcr(null)).toBe(true);
  });

  it("retries when confidence sits below OCR_CONFIDENCE_FLOOR — the same read reconcile.ts would discard to single-channel", () => {
    expect(shouldRetryOcr({ text: "garbled", confidence: OCR_CONFIDENCE_FLOOR - 1 })).toBe(true);
  });

  it("does not retry at exactly OCR_CONFIDENCE_FLOOR — reconcile.ts's own floor check is >=, not >", () => {
    expect(shouldRetryOcr({ text: "usable", confidence: OCR_CONFIDENCE_FLOOR })).toBe(false);
  });

  it("does not retry a confident, usable read", () => {
    expect(shouldRetryOcr({ text: "GOVERNMENT WARNING", confidence: 95 })).toBe(false);
  });
});

describe("buildOcrRetryVariant", () => {
  /** A small synthetic crop — a real PNG sharp can decode, not a golden-set
   * image, so this test is fast and has no external dependency (matching
   * `ocr.test.ts`'s own synthetic-fixture convention). */
  async function renderCrop(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();
  }

  it(`enlarges both dimensions by exactly OCR_RETRY_UPSCALE_FACTOR (${OCR_RETRY_UPSCALE_FACTOR}x)`, async () => {
    const crop = await renderCrop(100, 40);
    const variant = await buildOcrRetryVariant(crop);
    const metadata = await sharp(variant).metadata();
    expect(metadata.width).toBe(100 * OCR_RETRY_UPSCALE_FACTOR);
    expect(metadata.height).toBe(40 * OCR_RETRY_UPSCALE_FACTOR);
  });

  it("returns a PNG-decodable buffer, matching cropForOcr's own encoding", async () => {
    const crop = await renderCrop(50, 20);
    const variant = await buildOcrRetryVariant(crop);
    const metadata = await sharp(variant).metadata();
    expect(metadata.format).toBe("png");
  });

  it("never throws on an unreadable buffer — degrades to returning the input unchanged", async () => {
    const garbage = Buffer.from("not an image");
    await expect(buildOcrRetryVariant(garbage)).resolves.toBe(garbage);
  });
});
