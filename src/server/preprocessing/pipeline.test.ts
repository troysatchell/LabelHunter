import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  FileTooLargeError,
  ImageDimensionsTooLargeError,
  UnreadableImageError,
  UnsupportedFormatError,
} from "./errors";
import { cropRegion, preprocessImage } from "./pipeline";
import { HAIKU_MAX_LONG_EDGE_PX, MAX_UPLOAD_BYTES, SONNET_MAX_LONG_EDGE_PX } from "./constants";

/** Builds a synthetic JPEG of the given size, optionally tagged with an EXIF orientation. */
async function makeJpeg(
  width: number,
  height: number,
  orientation?: number,
): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 140, b: 60 } },
  }).jpeg();
  if (orientation === undefined) {
    return base.toBuffer();
  }
  return sharp(await base.toBuffer())
    .withMetadata({ orientation: orientation as never })
    .jpeg()
    .toBuffer();
}

describe("preprocessImage", () => {
  it("EXIF-rotates the image upright and reports the post-rotation dimensions", async () => {
    // orientation 6 = rotate 90 CW; a 100x60 source displays as 60x100.
    const upload = await makeJpeg(100, 60, 6);
    const result = await preprocessImage(upload);

    expect(result.width).toBe(60);
    expect(result.height).toBe(100);

    const originalMeta = await sharp(result.original).metadata();
    expect(originalMeta.width).toBe(60);
    expect(originalMeta.height).toBe(100);
    // The orientation tag is stripped after rotation, not just reinterpreted
    // — a viewer with no EXIF support still displays it upright.
    expect(originalMeta.orientation).toBeUndefined();
  });

  it("keeps the original at full resolution", async () => {
    const upload = await makeJpeg(3200, 2400);
    const result = await preprocessImage(upload);

    expect(result.width).toBe(3200);
    expect(result.height).toBe(2400);
    const meta = await sharp(result.original).metadata();
    expect(meta.width).toBe(3200);
    expect(meta.height).toBe(2400);
  });

  it("produces a Haiku variant capped at the documented 1568px long edge", async () => {
    const upload = await makeJpeg(3200, 2400);
    const result = await preprocessImage(upload);

    const meta = await sharp(result.haikuVariant).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
      HAIKU_MAX_LONG_EDGE_PX,
    );
  });

  it("produces a Sonnet variant capped at the documented 2576px long edge, larger than the Haiku variant", async () => {
    const upload = await makeJpeg(3200, 2400);
    const result = await preprocessImage(upload);

    const haikuMeta = await sharp(result.haikuVariant).metadata();
    const sonnetMeta = await sharp(result.sonnetVariant).metadata();
    const sonnetLongEdge = Math.max(sonnetMeta.width ?? 0, sonnetMeta.height ?? 0);
    expect(sonnetLongEdge).toBeLessThanOrEqual(SONNET_MAX_LONG_EDGE_PX);
    expect(sonnetLongEdge).toBeGreaterThan(
      Math.max(haikuMeta.width ?? 0, haikuMeta.height ?? 0),
    );
  });

  it("does not upscale a Haiku/Sonnet variant beyond the source's own resolution", async () => {
    const upload = await makeJpeg(400, 300);
    const result = await preprocessImage(upload);

    const haikuMeta = await sharp(result.haikuVariant).metadata();
    expect(haikuMeta.width).toBe(400);
    expect(haikuMeta.height).toBe(300);

    const sonnetMeta = await sharp(result.sonnetVariant).metadata();
    expect(sonnetMeta.width).toBe(400);
    expect(sonnetMeta.height).toBe(300);
  });

  it("flattens a transparent PNG onto a white background, not sharp's default black", async () => {
    // sharp's default matte for an alpha channel dropped during JPEG
    // encoding is black, not white — confirmed against a live sharp run.
    // A label graphic with a transparent background must not go dark.
    const transparent = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 4,
        background: { r: 10, g: 10, b: 10, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const result = await preprocessImage(transparent);

    const { data, info } = await sharp(result.original)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(data[0]).toBeGreaterThan(240);
    expect(data[1]).toBeGreaterThan(240);
    expect(data[2]).toBeGreaterThan(240);
  });

  it("normalizes every output to image/jpeg regardless of the source format", async () => {
    const png = await sharp({
      create: { width: 200, height: 150, channels: 4, background: { r: 10, g: 10, b: 200, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const result = await preprocessImage(png);

    expect(result.mediaType).toBe("image/jpeg");
    for (const buf of [result.original, result.haikuVariant, result.sonnetVariant]) {
      const meta = await sharp(buf).metadata();
      expect(meta.format).toBe("jpeg");
    }
  });

  it("rejects a file over the upload size ceiling with FileTooLargeError, before attempting to decode it", async () => {
    // Deliberately not a real image — the size check must run first, so a
    // garbage buffer this large is enough to prove it never reaches sharp.
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    await expect(preprocessImage(oversized)).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
  });

  it("rejects a non-image file with UnsupportedFormatError", async () => {
    const notAnImage = Buffer.from(
      "this is plain text, not an image, padded to be non-trivial in length",
    );
    await expect(preprocessImage(notAnImage)).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
  });

  it("rejects a format sharp can decode but LabelHunter does not accept", async () => {
    const gif = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .gif()
      .toBuffer();
    await expect(preprocessImage(gif)).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
  });

  it("rejects a corrupt/truncated image with UnreadableImageError", async () => {
    const real = await makeJpeg(200, 150);
    const truncated = real.subarray(0, Math.floor(real.length / 2));
    await expect(preprocessImage(truncated)).rejects.toBeInstanceOf(
      UnreadableImageError,
    );
  });

  it("rejects an image whose decoded pixel dimensions exceed the configured ceiling", async () => {
    // A normal small image with an artificially tiny maxInputPixels proves
    // the guard fires, without needing to build a genuinely huge fixture.
    const upload = await makeJpeg(200, 150);
    await expect(
      preprocessImage(upload, { maxInputPixels: 100 }),
    ).rejects.toBeInstanceOf(ImageDimensionsTooLargeError);
  });
});

describe("cropRegion", () => {
  it("crops the requested region from a full-resolution buffer", async () => {
    const upload = await makeJpeg(1000, 800);
    const cropped = await cropRegion(upload, { x: 100, y: 100, width: 200, height: 50 });
    const meta = await sharp(cropped).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(50);
  });

  it("clamps a region that extends past the image bounds instead of throwing", async () => {
    const upload = await makeJpeg(1000, 800);
    const cropped = await cropRegion(upload, { x: 900, y: 700, width: 500, height: 500 });
    const meta = await sharp(cropped).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
  });
});
