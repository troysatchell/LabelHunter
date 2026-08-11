import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLabelImage, saveLabelImage } from "./local-file-storage";

let scratchDir: string;

beforeEach(async () => {
  // TRO-465 scratch dir: unique per test run, cleaned up after — never
  // writes into the real `var/uploads`.
  scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro465-storage-"));
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

describe("saveLabelImage", () => {
  it("writes the given bytes to disk and returns a path a reader can open", async () => {
    const bytes = Buffer.from("fake-jpeg-bytes");
    const result = await saveLabelImage(bytes, "front-label.jpg", { baseDir: scratchDir });

    const onDisk = await readFile(result.absolutePath);
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it("creates the base directory when it does not exist yet", async () => {
    const nestedDir = path.join(scratchDir, "does", "not", "exist", "yet");
    const result = await saveLabelImage(Buffer.from("bytes"), "a.jpg", { baseDir: nestedDir });
    const onDisk = await readFile(result.absolutePath);
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it("never collides two uploads with the same original filename", async () => {
    const first = await saveLabelImage(Buffer.from("one"), "label.jpg", { baseDir: scratchDir });
    const second = await saveLabelImage(Buffer.from("two"), "label.jpg", { baseDir: scratchDir });

    expect(first.absolutePath).not.toBe(second.absolutePath);
    expect((await readFile(first.absolutePath)).toString()).toBe("one");
    expect((await readFile(second.absolutePath)).toString()).toBe("two");
  });

  it("sanitizes a filename that tries to escape the base directory", async () => {
    const result = await saveLabelImage(Buffer.from("bytes"), "../../etc/passwd", { baseDir: scratchDir });
    // The write must land inside scratchDir, not above it.
    expect(path.dirname(result.absolutePath)).toBe(scratchDir);
    const onDisk = await readFile(result.absolutePath);
    expect(onDisk.toString()).toBe("bytes");
  });

  it("returns a storagePath reflecting the base directory actually used, not a hardcoded name", async () => {
    const result = await saveLabelImage(Buffer.from("bytes"), "label.jpg", { baseDir: scratchDir });
    expect(result.storagePath.startsWith(path.basename(scratchDir))).toBe(true);
  });
});

describe("readLabelImage (TRO-466 — the Detail view's side-by-side image)", () => {
  it("reads back exactly what saveLabelImage wrote, given the storagePath it returned", async () => {
    const bytes = Buffer.from("fake-jpeg-bytes");
    const saved = await saveLabelImage(bytes, "front-label.jpg", { baseDir: scratchDir });

    const roundTripped = await readLabelImage(saved.storagePath, { baseDir: scratchDir });
    expect(roundTripped.equals(bytes)).toBe(true);
  });

  it("never needs the caller to know the base-directory convention — storagePath alone is enough", async () => {
    const saved = await saveLabelImage(Buffer.from("second file"), "back-label.jpg", { baseDir: scratchDir });
    // storagePath is documented opaque outside this module (see
    // saveLabelImage's own comment) — this only proves readLabelImage can
    // resolve exactly the value that function actually returned, not that
    // the caller may parse or reconstruct that value itself.
    const roundTripped = await readLabelImage(saved.storagePath, { baseDir: scratchDir });
    expect(roundTripped.toString()).toBe("second file");
  });

  it("cannot be made to escape baseDir by a storagePath carrying its own '../' segments", async () => {
    const saved = await saveLabelImage(Buffer.from("real bytes"), "label.jpg", { baseDir: scratchDir });
    const filename = path.basename(saved.storagePath);
    const traversal = path.join("..", "..", "etc", filename);

    // path.basename strips every directory component before rejoining
    // with the trusted baseDir, so a crafted storagePath still resolves
    // inside scratchDir — the same guarantee sanitizeFilenameComponent
    // gives the write side.
    const roundTripped = await readLabelImage(traversal, { baseDir: scratchDir });
    expect(roundTripped.toString()).toBe("real bytes");
  });

  it("rejects (does not silently return empty bytes) when no file exists at the resolved path", async () => {
    await expect(readLabelImage("does-not-exist.jpg", { baseDir: scratchDir })).rejects.toThrow();
  });
});
