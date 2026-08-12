import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractZipEntries } from "./zip";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("extractZipEntries", () => {
  it("extracts flat entries with their filenames and decompressed sizes", () => {
    const zipped = zipSync({
      "a.jpg": bytes("fake-jpeg-bytes-1"),
      "b.jpg": bytes("fake-jpeg-bytes-2-longer"),
    });
    const result = extractZipEntries(zipped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byName = Object.fromEntries(result.images.map((i) => [i.filename, i.sizeBytes]));
    expect(byName).toEqual({
      "a.jpg": bytes("fake-jpeg-bytes-1").length,
      "b.jpg": bytes("fake-jpeg-bytes-2-longer").length,
    });
  });

  it("reduces a nested entry path to its basename", () => {
    const zipped = zipSync({
      "images/front/bottle-001.jpg": bytes("data"),
    });
    const result = extractZipEntries(zipped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toEqual([{ filename: "bottle-001.jpg", sizeBytes: bytes("data").length }]);
  });

  it("skips explicit directory entries", () => {
    const zipped = zipSync({
      "images/": new Uint8Array(0),
      "images/bottle-001.jpg": bytes("data"),
    });
    const result = extractZipEntries(zipped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images.map((i) => i.filename)).toEqual(["bottle-001.jpg"]);
  });

  it("rejects bytes that are not a valid zip archive", () => {
    const result = extractZipEntries(bytes("this is not a zip file at all"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/could not open this zip/i);
  });

  it("rejects a zip with more entries than the configured limit, without decompressing past it", () => {
    const zipped = zipSync({
      "a.jpg": bytes("1"),
      "b.jpg": bytes("2"),
      "c.jpg": bytes("3"),
    });
    const result = extractZipEntries(zipped, { maxEntries: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/too many entries/i);
  });

  it("rejects a zip whose declared uncompressed size exceeds the configured byte limit", () => {
    const zipped = zipSync({
      "big.jpg": bytes("x".repeat(1000)),
    });
    const result = extractZipEntries(zipped, { maxTotalBytes: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/too large/i);
  });

  it("normalizes extracted filenames to NFC (standing rule 20)", () => {
    const nfd = "caf" + String.fromCharCode(0x65, 0x0301) + ".jpg"; // decomposed
    const nfc = "caf" + String.fromCharCode(0x00e9) + ".jpg"; // precomposed
    const zipped = zipSync({ [nfd]: bytes("data") });
    const result = extractZipEntries(zipped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images[0].filename).toBe(nfc);
  });

  it("returns an empty image list for a zip with only directory entries", () => {
    const zipped = zipSync({ "images/": new Uint8Array(0) });
    const result = extractZipEntries(zipped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toEqual([]);
  });
});
