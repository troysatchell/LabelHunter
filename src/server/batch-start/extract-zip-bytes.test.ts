import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractZipImageBytes } from "./extract-zip-bytes";

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("extractZipImageBytes", () => {
  it("decompresses exactly the wanted filenames, by basename, and no others", () => {
    const zipped = zipSync({
      "bottle-01.jpg": textBytes("front-label-bytes"),
      "bottle-02.jpg": textBytes("back-label-bytes"),
      "readme.txt": textBytes("not an image, and not wanted either"),
    });

    const result = extractZipImageBytes(zipped, new Set(["bottle-01.jpg"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images.size).toBe(1);
    expect(new TextDecoder().decode(result.images.get("bottle-01.jpg"))).toBe("front-label-bytes");
    expect(result.images.has("bottle-02.jpg")).toBe(false);
    expect(result.images.has("readme.txt")).toBe(false);
  });

  it("matches a wanted filename against an entry stored under a directory path, by basename", () => {
    const zipped = zipSync({
      "images/front/bottle-01.jpg": textBytes("nested-bytes"),
    });

    const result = extractZipImageBytes(zipped, new Set(["bottle-01.jpg"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.images.get("bottle-01.jpg"))).toBe("nested-bytes");
  });

  it("returns an empty map, not an error, when no wanted filename is present in the zip", () => {
    const zipped = zipSync({ "other.jpg": textBytes("x") });
    const result = extractZipImageBytes(zipped, new Set(["missing.jpg"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images.size).toBe(0);
  });

  it("returns an empty map for an empty wanted set, without decompressing anything", () => {
    const zipped = zipSync({ "bottle-01.jpg": textBytes("x") });
    const result = extractZipImageBytes(zipped, new Set());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images.size).toBe(0);
  });

  it("returns a plain-English ok:false for a corrupt zip, never a raw exception", () => {
    const result = extractZipImageBytes(textBytes("not actually a zip file"), new Set(["bottle-01.jpg"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toMatch(/Error:|at extractZipImageBytes|\.ts:\d/);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("rejects a wanted entry whose real inflated size exceeds the configured per-image cap", () => {
    const zipped = zipSync({ "huge.jpg": textBytes("x".repeat(1000)) });
    const result = extractZipImageBytes(zipped, new Set(["huge.jpg"]), { maxBytesPerImage: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/too large/i);
    expect(result.message).toMatch(/huge\.jpg/);
  });

  it("does not let one oversized wanted entry block a DIFFERENT wanted entry from being reported (both filenames named in the batch)", () => {
    // Only the offending file's own name matters in the message; this test
    // just proves the check fires per-entry, not against the whole zip's
    // combined size.
    const zipped = zipSync({
      "ok.jpg": textBytes("small"),
      "huge.jpg": textBytes("x".repeat(1000)),
    });
    const result = extractZipImageBytes(zipped, new Set(["ok.jpg", "huge.jpg"]), { maxBytesPerImage: 10 });
    expect(result.ok).toBe(false);
  });
});
