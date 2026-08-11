import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveLabelImage } from "./local-file-storage";

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
