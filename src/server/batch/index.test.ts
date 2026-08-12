import { describe, expect, it } from "vitest";
import { buildBatchPreview } from "./index";

const HEADER =
  "beverage_type,brand_name,class_type,alcohol_content_percent,net_contents_value,net_contents_unit,image_filename";

describe("buildBatchPreview", () => {
  it("passes a malformed-CSV failure straight through", () => {
    const result = buildBatchPreview({ csvText: "", images: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/empty/i);
  });

  it("returns a full pairing preview for a clean manifest with every image present", () => {
    const csvText = [
      HEADER,
      "spirits,Highland Peak Distillery,Straight Bourbon Whiskey,45,750,mL,bottle-01.jpg",
      "wine,Rolling Hills,Cabernet Sauvignon,13.5,750,mL,bottle-02.jpg",
    ].join("\n");
    const result = buildBatchPreview({
      csvText,
      images: [
        { filename: "bottle-01.jpg", sizeBytes: 1000 },
        { filename: "bottle-02.jpg", sizeBytes: 2000 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalRows).toBe(2);
    expect(result.readyCount).toBe(2);
    expect(result.matched).toHaveLength(2);
    expect(result.unmatchedRows).toEqual([]);
    expect(result.unmatchedImages).toEqual([]);
    expect(result.invalidRows).toEqual([]);
  });

  it("assembles a mixed batch: matched, unmatched row, unmatched image, and an invalid row, all accounted for", () => {
    const csvText = [
      HEADER,
      "spirits,Highland Peak Distillery,Straight Bourbon Whiskey,45,750,mL,bottle-01.jpg", // matched
      "wine,Rolling Hills,Cabernet Sauvignon,13.5,750,mL,missing.jpg", // unmatched row
      "ale,Bad Type Co,Lager,5,355,mL,bottle-03.jpg", // invalid row (bad beverage_type)
    ].join("\n");
    const result = buildBatchPreview({
      csvText,
      images: [
        { filename: "bottle-01.jpg", sizeBytes: 1000 },
        { filename: "orphan.jpg", sizeBytes: 500 }, // unmatched image
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 3 data rows total: 2 structurally valid (matched + unmatched-row) + 1 invalid.
    expect(result.totalRows).toBe(3);
    expect(result.readyCount).toBe(1);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].row.brandName).toBe("Highland Peak Distillery");
    expect(result.unmatchedRows).toHaveLength(1);
    expect(result.unmatchedRows[0].row.brandName).toBe("Rolling Hills");
    expect(result.unmatchedImages).toHaveLength(1);
    expect(result.unmatchedImages[0].image.filename).toBe("orphan.jpg");
    expect(result.invalidRows).toHaveLength(1);
    expect(result.invalidRows[0].rowNumber).toBe(4);
  });
});
