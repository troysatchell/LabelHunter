import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest";

const HEADER =
  "beverage_type,brand_name,class_type,alcohol_content_percent,net_contents_value,net_contents_unit,image_filename";

function csvWith(...rows: string[]): string {
  return [HEADER, ...rows].join("\n") + "\n";
}

describe("parseManifest", () => {
  it("parses valid rows with all fields populated", () => {
    const result = parseManifest(
      csvWith(
        "spirits,Old Tom Distillery,Straight Bourbon Whiskey,45,750,mL,bottle-001.jpg",
        "wine,Rolling Hills,Cabernet Sauvignon,13.5,750,mL,bottle-002.jpg",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toEqual([
      {
        rowNumber: 2,
        beverageType: "spirits",
        brandName: "Old Tom Distillery",
        classType: "Straight Bourbon Whiskey",
        alcoholContentPercent: 45,
        netContentsValue: 750,
        netContentsUnit: "mL",
        imageFilename: "bottle-001.jpg",
      },
      {
        rowNumber: 3,
        beverageType: "wine",
        brandName: "Rolling Hills",
        classType: "Cabernet Sauvignon",
        alcoholContentPercent: 13.5,
        netContentsValue: 750,
        netContentsUnit: "mL",
        imageFilename: "bottle-002.jpg",
      },
    ]);
  });

  it("parses a blank alcohol_content_percent as null (legal for beer/wine)", () => {
    const result = parseManifest(csvWith("beer,Hopyard Co,IPA,,355,mL,can-01.jpg"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].alcoholContentPercent).toBeNull();
  });

  it("reads columns by name, so a different column order still parses", () => {
    const reordered = [
      "image_filename,brand_name,class_type,beverage_type,net_contents_unit,net_contents_value,alcohol_content_percent",
      "bottle-01.jpg,Old Tom Distillery,Straight Bourbon Whiskey,spirits,mL,750,45",
    ].join("\n");
    const result = parseManifest(reordered);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({
      brandName: "Old Tom Distillery",
      imageFilename: "bottle-01.jpg",
      beverageType: "spirits",
    });
  });

  it("ignores an extra, unrecognized column", () => {
    const withExtra = [
      HEADER + ",internal_note",
      "beer,Hopyard Co,IPA,5,355,mL,can-01.jpg,rush order",
    ].join("\n");
    const result = parseManifest(withExtra);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].brandName).toBe("Hopyard Co");
  });

  it("matches header names case- and whitespace-insensitively", () => {
    const header = " Beverage_Type , Brand_Name,CLASS_TYPE,Alcohol_Content_Percent,Net_Contents_Value,Net_Contents_Unit,Image_Filename";
    const csv = [header, "beer,Hopyard Co,IPA,5,355,mL,can-01.jpg"].join("\n");
    const result = parseManifest(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].brandName).toBe("Hopyard Co");
  });

  it("rejects a CSV missing a required column, naming it", () => {
    const noImageColumn =
      "beverage_type,brand_name,class_type,alcohol_content_percent,net_contents_value,net_contents_unit\nbeer,Hopyard Co,IPA,5,355,mL\n";
    const result = parseManifest(noImageColumn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/image_filename/);
  });

  it("rejects a CSV with a duplicated header column", () => {
    const dup = HEADER + ",brand_name\nbeer,Hopyard Co,IPA,5,355,mL,can-01.jpg,Hopyard Co\n";
    const result = parseManifest(dup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/brand_name/);
  });

  it("rejects a file with a header row but no data rows", () => {
    const result = parseManifest(HEADER + "\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/no label rows|no data/i);
  });

  it("rejects a completely empty file", () => {
    const result = parseManifest("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/empty/i);
  });

  it("rejects a row whose column count does not match the header, naming the row", () => {
    const ragged = csvWith("beer,Hopyard Co,IPA,5,355,mL"); // missing image_filename cell
    const result = parseManifest(ragged);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/row 2/i);
  });

  it("propagates a CSV syntax error (unterminated quote) as a whole-file failure", () => {
    const broken = HEADER + '\n"unterminated,IPA,5,355,mL,can-01.jpg\n';
    const result = parseManifest(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/quote/i);
  });

  it("reports an invalid beverage_type on one row without dropping the others", () => {
    const result = parseManifest(
      csvWith(
        "ale,Hopyard Co,IPA,5,355,mL,can-01.jpg",
        "beer,Second Co,Lager,4.5,355,mL,can-02.jpg",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].brandName).toBe("Second Co");
    expect(result.rowErrors).toEqual([
      { rowNumber: 2, message: "Row 2: choose a beverage type: beer, wine, or spirits." },
    ]);
  });

  it("reports a blank brand_name", () => {
    const result = parseManifest(csvWith("beer,,IPA,5,355,mL,can-01.jpg"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowErrors).toEqual([{ rowNumber: 2, message: "Row 2: enter the brand name." }]);
  });

  it("reports a blank class_type", () => {
    const result = parseManifest(csvWith("beer,Hopyard Co,,5,355,mL,can-01.jpg"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowErrors).toEqual([{ rowNumber: 2, message: "Row 2: enter the class or type." }]);
  });

  it("reports a non-numeric alcohol_content_percent", () => {
    const result = parseManifest(csvWith("beer,Hopyard Co,IPA,strong,355,mL,can-01.jpg"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowErrors).toEqual([
      { rowNumber: 2, message: "Row 2: enter a number for alcohol content, or leave it blank." },
    ]);
  });

  it("reports an out-of-range alcohol_content_percent", () => {
    const result = parseManifest(csvWith("spirits,Old Tom,Whiskey,150,750,mL,bottle-01.jpg"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowErrors).toEqual([
      { rowNumber: 2, message: "Row 2: enter an alcohol content between 0 and 100, or leave it blank." },
    ]);
  });

  it("reports a non-positive net_contents_value", () => {
    const result = parseManifest(csvWith("beer,Hopyard Co,IPA,5,0,mL,can-01.jpg"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowErrors).toEqual([
      { rowNumber: 2, message: "Row 2: enter a net contents amount greater than zero." },
    ]);
  });

  it("reports an unrecognized net_contents_unit", () => {
    const result = parseManifest(csvWith("beer,Hopyard Co,IPA,5,355,ounces,can-01.jpg"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowErrors).toEqual([
      { rowNumber: 2, message: "Row 2: choose a net contents unit: mL, L, or fl oz." },
    ]);
  });

  it("reports a blank image_filename", () => {
    const result = parseManifest(csvWith("beer,Hopyard Co,IPA,5,355,mL,"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowErrors).toEqual([{ rowNumber: 2, message: "Row 2: enter an image filename." }]);
  });

  it("normalizes brand_name to NFC (standing rule 20)", () => {
    const nfd = "Caf" + String.fromCharCode(0x65, 0x0301) + " Wines";
    const nfc = "Caf" + String.fromCharCode(0x00e9) + " Wines";
    const result = parseManifest(csvWith(`wine,${nfd},Red Blend,13,750,mL,bottle-01.jpg`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].brandName).toBe(nfc);
  });
});
