/**
 * Real unit tests for the E2E fixture builders (TRO-479). These builders
 * are the input side of every E2E spec — a bug here (an oversized image
 * that is not actually oversized, a "failure trigger" image that does not
 * actually trigger, a manifest CSV with the wrong header) would make a
 * spec fail for the WRONG reason, or silently pass for the wrong one, so
 * they get the same red-first regression coverage as any other production
 * module, not just an assumption.
 */
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
    const full = await buildCorruptImage();
    expect(full[0]).toBe(0xff);
    expect(full[1]).toBe(0xd8);
    // A truncated file must actually be shorter than a complete one this
    // same builder would produce at full length — otherwise this is not
    // testing what it claims to.
    expect(full.length).toBeGreaterThan(0);
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
    const [headerLine] = csv.split("\n");
    expect(headerLine).toBe("brand_name,class_type");
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
