/**
 * Real unit tests for the E2E fixture builders (TRO-479). These builders
 * are the input side of every E2E spec — a bug here (an oversized image
 * that is not actually oversized, a "failure trigger" image that does not
 * actually trigger, a manifest CSV with the wrong header) would make a
 * spec fail for the WRONG reason, or silently pass for the wrong one, so
 * they get the same red-first regression coverage as any other production
 * module, not just an assumption.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MANIFEST_COLUMNS } from "../../src/server/batch/types";
import { MAX_UPLOAD_BYTES } from "../../src/server/preprocessing/constants";
import { FAILURE_TRIGGER_MAX_BYTES, isFailureTriggerImage } from "./fake-anthropic-server";
import { buildCorruptImage, buildFailureTriggerImage, buildManifestCsv, buildOversizedFile, readDefaultGoldenImage, uniqueTag } from "./fixtures";

describe("uniqueTag", () => {
  it("embeds the given label and never repeats across calls", () => {
    const a = uniqueTag("verify");
    const b = uniqueTag("verify");
    expect(a).toContain("verify");
    expect(a).not.toBe(b);
  });
});

describe("readDefaultGoldenImage", () => {
  it("reads a real, non-empty JPEG from the committed golden set", () => {
    const bytes = readDefaultGoldenImage();
    expect(bytes.length).toBeGreaterThan(1000);
    // JPEG magic number — confirms this is real image data, not a text
    // placeholder accidentally committed under a .jpg name.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });
});

describe("buildFailureTriggerImage", () => {
  it("produces a real JPEG small enough to trigger the fake server's failure response", async () => {
    const bytes = await buildFailureTriggerImage();
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    const base64 = bytes.toString("base64");
    expect(isFailureTriggerImage(base64)).toBe(true);
    expect(Buffer.byteLength(base64, "base64")).toBeLessThan(FAILURE_TRIGGER_MAX_BYTES);
  });
});

describe("buildCorruptImage", () => {
  it("keeps a real JPEG header but truncates the pixel data", async () => {
    const truncated = await buildCorruptImage();
    expect(truncated[0]).toBe(0xff);
    expect(truncated[1]).toBe(0xd8);
    expect(truncated.length).toBeGreaterThan(0);

    // A hardcoded length constant goes stale the moment the fixture
    // changes. A real complete encode, built the same way
    // buildCorruptImage builds its own image, stays a true baseline. The
    // truncated file must be shorter than this complete encode of the
    // SAME image, not just non-empty (CodeRabbit finding, TRO-525).
    const complete = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 210, g: 210, b: 210 } },
    })
      .jpeg()
      .toBuffer();
    expect(truncated.length).toBeLessThan(complete.length);
  });
});

describe("buildOversizedFile", () => {
  it("is larger than MAX_UPLOAD_BYTES", () => {
    const bytes = buildOversizedFile();
    expect(bytes.length).toBeGreaterThan(MAX_UPLOAD_BYTES);
  });
});

describe("buildManifestCsv", () => {
  const row = {
    beverageType: "spirits" as const,
    brandName: "Old Tom Distillery",
    classType: "Straight Bourbon Whiskey",
    alcoholContentPercent: 45,
    netContentsValue: 750,
    netContentsUnit: "mL" as const,
    imageFilename: "bottle.jpg",
  };

  it("writes the exact required header, in the required order", () => {
    const csv = buildManifestCsv([row]);
    const [headerLine] = csv.split("\n");
    expect(headerLine.split(",")).toEqual([...MANIFEST_COLUMNS]);
  });

  it("writes one well-formed data row per entry", () => {
    const csv = buildManifestCsv([row]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("spirits,Old Tom Distillery,Straight Bourbon Whiskey,45,750,mL,bottle.jpg");
  });

  it("renders a blank cell for an omitted alcohol content, never the literal string 'undefined'", () => {
    const csv = buildManifestCsv([{ ...row, alcoholContentPercent: undefined }]);
    const [, dataLine] = csv.trim().split("\n");
    expect(dataLine).toBe("spirits,Old Tom Distillery,Straight Bourbon Whiskey,,750,mL,bottle.jpg");
  });

  it("honors an override header, for a malformed-CSV test that needs a missing column", () => {
    const csv = buildManifestCsv([row], ["brand_name", "class_type"]);
    const [headerLine, dataLine] = csv.trim().split("\n");
    expect(headerLine).toBe("brand_name,class_type");
    // The data row must map cells over the SAME column sequence as the
    // header, not always MANIFEST_COLUMNS. Using MANIFEST_COLUMNS here
    // can make row width and column order drift from what the header
    // promises (CodeRabbit finding, TRO-526).
    expect(dataLine).toBe("Old Tom Distillery,Straight Bourbon Whiskey");
  });

  it("maps row cells to a reordered overrideHeader, not the default MANIFEST_COLUMNS order", () => {
    const csv = buildManifestCsv([row], ["image_filename", "brand_name"]);
    const [headerLine, dataLine] = csv.trim().split("\n");
    expect(headerLine).toBe("image_filename,brand_name");
    expect(dataLine).toBe("bottle.jpg,Old Tom Distillery");
  });

  it("throws when overrideHeader names a column that is not a real ManifestColumn", () => {
    expect(() => buildManifestCsv([row], ["brand_name", "not_a_real_column"])).toThrow(/not_a_real_column/);
  });

  it("quotes a cell containing a bare carriage return, not only a newline", () => {
    // RFC 4180 requires quoting for \r as well as \n — an earlier version
    // of csvField's character class checked only [",\n], which would have
    // written a bare \r straight into the CSV unquoted (CodeRabbit
    // finding, TRO-479 local review round 2).
    const csv = buildManifestCsv([{ ...row, classType: "Straight\rBourbon" }]);
    const [, dataLine] = csv.trim().split("\n");
    expect(dataLine).toContain('"Straight\rBourbon"');
  });
});
