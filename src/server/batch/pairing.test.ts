import { describe, expect, it } from "vitest";
import { pairRowsWithImages } from "./pairing";
import type { ManifestRow } from "./types";

let nextRowNumber = 2;
function row(overrides: Partial<ManifestRow> = {}): ManifestRow {
  return {
    rowNumber: nextRowNumber++,
    beverageType: "beer",
    brandName: "Hopyard Co",
    classType: "IPA",
    alcoholContentPercent: 5,
    netContentsValue: 355,
    netContentsUnit: "mL",
    imageFilename: "can-01.jpg",
    ...overrides,
  };
}

describe("pairRowsWithImages", () => {
  it("pairs a row to its matching image", () => {
    const r = row({ imageFilename: "can-01.jpg" });
    const result = pairRowsWithImages([r], [{ filename: "can-01.jpg", sizeBytes: 1024 }]);
    expect(result.matched).toEqual([{ row: r, image: { filename: "can-01.jpg", sizeBytes: 1024 } }]);
    expect(result.unmatchedRows).toEqual([]);
    expect(result.unmatchedImages).toEqual([]);
  });

  it("reports a row with no matching image, never silently dropping it", () => {
    const r = row({ imageFilename: "missing.jpg" });
    const result = pairRowsWithImages([r], [{ filename: "can-01.jpg", sizeBytes: 1024 }]);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedRows).toEqual([{ row: r, reason: expect.stringMatching(/no uploaded image/i) }]);
    expect(result.unmatchedImages).toEqual([{ image: { filename: "can-01.jpg", sizeBytes: 1024 }, reason: expect.stringMatching(/no csv row/i) }]);
  });

  it("reports an uploaded image with no matching row", () => {
    const result = pairRowsWithImages([], [{ filename: "orphan.jpg", sizeBytes: 2048 }]);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedImages).toEqual([
      { image: { filename: "orphan.jpg", sizeBytes: 2048 }, reason: expect.stringMatching(/no csv row/i) },
    ]);
  });

  it("reports every row when two rows claim the same image filename, and flags the image too", () => {
    const rowA = row({ imageFilename: "shared.jpg" });
    const rowB = row({ imageFilename: "shared.jpg" });
    const result = pairRowsWithImages([rowA, rowB], [{ filename: "shared.jpg", sizeBytes: 500 }]);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedRows).toHaveLength(2);
    expect(result.unmatchedRows.map((u) => u.row)).toEqual([rowA, rowB]);
    for (const u of result.unmatchedRows) {
      expect(u.reason).toMatch(/more than one row/i);
    }
    expect(result.unmatchedImages).toEqual([
      { image: { filename: "shared.jpg", sizeBytes: 500 }, reason: expect.stringMatching(/more than one csv row/i) },
    ]);
  });

  it("reports every uploaded image when two images share a filename, and flags the row too (review finding: every image, not just the first)", () => {
    const r = row({ imageFilename: "dup.jpg" });
    const images = [
      { filename: "dup.jpg", sizeBytes: 100 },
      { filename: "dup.jpg", sizeBytes: 200 },
    ];
    const result = pairRowsWithImages([r], images);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedRows).toEqual([{ row: r, reason: expect.stringMatching(/more than one uploaded image/i) }]);
    // Every uploaded instance is reported, not only the first — each
    // carries its own byte size, so a human comparing sizes can tell them
    // apart even though their filenames match.
    expect(result.unmatchedImages).toHaveLength(2);
    expect(result.unmatchedImages.map((u) => u.image)).toEqual(expect.arrayContaining(images));
    for (const u of result.unmatchedImages) {
      expect(u.reason).toMatch(/more than one uploaded/i);
    }
  });

  it("reports every duplicate-named image when NO row claims any of them (review finding: every image, not just the first)", () => {
    const images = [
      { filename: "triplicate.jpg", sizeBytes: 10 },
      { filename: "triplicate.jpg", sizeBytes: 20 },
      { filename: "triplicate.jpg", sizeBytes: 30 },
    ];
    const result = pairRowsWithImages([], images);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedImages).toHaveLength(3);
    expect(result.unmatchedImages.map((u) => u.image)).toEqual(expect.arrayContaining(images));
    for (const u of result.unmatchedImages) {
      expect(u.reason).toMatch(/no csv row/i);
    }
  });

  it("treats a zero-byte uploaded image as its own problem, distinct from an unmatched image", () => {
    // Deliberately NOT named with "empty" anywhere in the filename
    // (review finding) — the /empty/i assertions below must pass only
    // because the reported REASON text says so, not because the
    // filename itself happens to contain that substring.
    const r = row({ imageFilename: "can-09.jpg" });
    const result = pairRowsWithImages([r], [{ filename: "can-09.jpg", sizeBytes: 0 }]);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedRows).toEqual([{ row: r, reason: expect.stringMatching(/empty/i) }]);
    expect(result.unmatchedImages).toEqual([{ image: { filename: "can-09.jpg", sizeBytes: 0 }, reason: expect.stringMatching(/empty/i) }]);
  });

  it("reports a row referencing a zero-byte image as empty, never as 'no image found' (review finding)", () => {
    const r = row({ imageFilename: "can-10.jpg" });
    const result = pairRowsWithImages([r], [{ filename: "can-10.jpg", sizeBytes: 0 }]);
    expect(result.unmatchedRows).toHaveLength(1);
    expect(result.unmatchedRows[0].reason).not.toMatch(/no uploaded image/i);
    expect(result.unmatchedRows[0].reason).toMatch(/empty/i);
  });

  it("matches filenames after Unicode NFC normalization (standing rule 20)", () => {
    const nfd = "bottle-caf" + String.fromCharCode(0x65, 0x0301) + ".jpg"; // decomposed
    const nfc = "bottle-caf" + String.fromCharCode(0x00e9) + ".jpg"; // precomposed
    const r = row({ imageFilename: nfd });
    const result = pairRowsWithImages([r], [{ filename: nfc, sizeBytes: 1024 }]);
    expect(result.matched).toHaveLength(1);
    expect(result.unmatchedRows).toEqual([]);
    expect(result.unmatchedImages).toEqual([]);
  });

  it("treats filename matching as case-sensitive, and reports the mismatch on both sides", () => {
    const r = row({ imageFilename: "Bottle.JPG" });
    const result = pairRowsWithImages([r], [{ filename: "bottle.jpg", sizeBytes: 1024 }]);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedRows).toHaveLength(1);
    expect(result.unmatchedImages).toHaveLength(1);
  });

  it("handles a batch of independent rows and images, matching what matches and reporting the rest", () => {
    const matchedRow = row({ imageFilename: "a.jpg" });
    const unmatchedRow = row({ imageFilename: "b.jpg" });
    const images = [
      { filename: "a.jpg", sizeBytes: 10 },
      { filename: "c.jpg", sizeBytes: 20 },
    ];
    const result = pairRowsWithImages([matchedRow, unmatchedRow], images);
    expect(result.matched).toEqual([{ row: matchedRow, image: images[0] }]);
    expect(result.unmatchedRows).toEqual([{ row: unmatchedRow, reason: expect.any(String) }]);
    expect(result.unmatchedImages).toEqual([{ image: images[1], reason: expect.any(String) }]);
  });
});
