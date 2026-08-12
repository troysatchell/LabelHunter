/**
 * Tests for the golden-set batch fixture builder.
 *
 * The risk this file guards is narrow and real: a golden case may omit
 * `abvPercent`, and the CSV must then emit an EMPTY cell rather than the
 * string "undefined" or a zero. `audit/requirements/source-TH.md:44` lists
 * alcohol content "with some exceptions for certain wine/beer", and both
 * `src/server/batch/manifest.ts` and `src/app/api/verify/parse-request.ts`
 * accept a blank value. A fixture that wrote "0" would silently assert a
 * declared 0% ABV, which is a different application entirely.
 */
import { describe, expect, it } from "vitest";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import { buildManifestCsv, caseToManifestRow } from "./batchFixture";

const manifest = loadGoldenSetManifest();

function caseById(caseId: string) {
  const found = manifest.cases.find((c) => c.caseId === caseId);
  if (!found) throw new Error(`test fixture: no golden case "${caseId}"`);
  return found;
}

describe("caseToManifestRow", () => {
  it("maps a spirits case with a declared ABV", () => {
    const row = caseToManifestRow(caseById("case-01-clean-match-spirits"));
    expect(row.beverageType).toBe("spirits");
    expect(row.brandName).toBe("Old Tom Distillery");
    expect(row.alcoholContentPercent).toBe(45);
    expect(row.netContentsValue).toBe(750);
    expect(row.netContentsUnit).toBe("mL");
  });

  it("emits an empty ABV cell when the application declares none", () => {
    // case-02 is the beer case the corpus built for exactly this rule.
    const beer = caseById("case-02-clean-match-beer-no-abv");
    expect(beer.application.abvPercent).toBeUndefined();

    const row = caseToManifestRow(beer);
    expect(row.alcoholContentPercent).toBe("");

    const csv = buildManifestCsv([row]);
    const dataLine = csv.trim().split("\n")[1];
    // The alcohol_content_percent column is 4th in MANIFEST_COLUMNS.
    expect(dataLine.split(",")[3]).toBe("");
    // The two failure modes worth naming, both of which would parse as a
    // real declared value rather than as an absent one.
    expect(csv).not.toContain("undefined");
    expect(dataLine.split(",")[3]).not.toBe("0");
  });

  it("strips the directory from imagePath, because pairing is by filename", () => {
    // PRD §3.5: a manifest row pairs to an image by filename, never by
    // upload order. The ZIP stores each image at its bare name, so the CSV
    // must carry the bare name too.
    const row = caseToManifestRow(caseById("case-01-clean-match-spirits"));
    expect(row.imageFilename).toBe("case-01-clean-match-spirits.jpg");
    expect(row.imageFilename).not.toContain("/");
  });

  it("produces a row the real manifest parser accepts, for every case", async () => {
    // The strongest check available without running a batch: build a row for
    // every golden case, render the CSV, and hand it to the SAME parser the
    // upload route uses. A fixture the product rejects is worthless.
    const { parseManifest } = await import("../../src/server/batch/manifest");
    const csv = buildManifestCsv(manifest.cases.map(caseToManifestRow));

    const result = parseManifest(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(manifest.cases.length);

    // The beer case survives the round trip as a real absence, not a zero.
    const beerRow = result.rows.find((r) => r.brandName === caseById("case-02-clean-match-beer-no-abv").application.brandName);
    expect(beerRow?.alcoholContentPercent).toBeNull();
  });
});
