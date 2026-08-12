/**
 * Builds a batch-upload fixture from the golden set.
 *
 * The golden set already holds everything a batch upload needs. Each case
 * carries the application fields the CSV manifest wants, and a committed
 * JPEG the ZIP wants. This script joins the two. It creates no new assets.
 *
 * Why this exists: nothing has ever driven a real batch through the deployed
 * instance. `docs/deploy.md` records the risk it tests (TRO-518) — the web
 * service and the worker run on separate Render services, so they hold
 * separate disks, and `local-file-storage.ts` writes to whichever process
 * saved the image. A small batch answers that question for a few cents.
 *
 * The fixture is self-checking. Every case already records the verdict the
 * router should return, so a reader compares the batch results against
 * `golden-set/manifest.json` instead of against an opinion.
 *
 * Run:
 *   pnpm batch:fixture              # every case in the manifest
 *   pnpm batch:fixture -- --count=3 # the first 3 cases, for a cheap probe
 *
 * Output goes to `var/batch-fixture/`. That directory is a build artifact,
 * not source. Upload both files together through the batch screen.
 *
 * No network call. No model call. No database. Reads the manifest and the
 * committed images, writes two files.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import {
  MANIFEST_COLUMNS,
  type ManifestColumn,
  type NetContentsUnit,
} from "../../src/server/batch/types";

/**
 * One CSV row, before serialization.
 *
 * `alcoholContentPercent` accepts `""` on purpose. An application may
 * declare no alcohol content — see `caseToManifestRow` for the three
 * sources that agree on that rule.
 */
export interface ManifestCsvRow {
  beverageType: GoldenSetCase["beverageType"];
  brandName: string;
  classType: string;
  alcoholContentPercent: number | "";
  netContentsValue: number;
  netContentsUnit: NetContentsUnit;
  imageFilename: string;
}

/** RFC 4180 quoting, applied only when a cell needs it. A brand name may
 * legitimately carry a comma or a quotation mark. */
function csvField(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Serializes rows against `MANIFEST_COLUMNS`, the same constant
 * `src/server/batch/manifest.ts` reads the header against.
 *
 * `scripts/e2e/fixtures.ts` already has a builder like this one. It is not
 * reused here: that module imports the fake Anthropic server, which reaches
 * a database connection at import time, and this script needs no database.
 */
export function buildManifestCsv(rows: readonly ManifestCsvRow[]): string {
  const cellsFor = (row: ManifestCsvRow): Record<ManifestColumn, string> => ({
    beverage_type: row.beverageType,
    brand_name: row.brandName,
    class_type: row.classType,
    alcohol_content_percent: row.alcoholContentPercent === "" ? "" : String(row.alcoholContentPercent),
    net_contents_value: String(row.netContentsValue),
    net_contents_unit: row.netContentsUnit,
    image_filename: row.imageFilename,
  });
  const header = MANIFEST_COLUMNS.join(",");
  const lines = rows.map((row) => {
    const cells = cellsFor(row);
    return MANIFEST_COLUMNS.map((col) => csvField(cells[col])).join(",");
  });
  return [header, ...lines].join("\n") + "\n";
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUTPUT_DIR = resolve(REPO_ROOT, "var/batch-fixture");

/**
 * Turns one golden case into one CSV row.
 *
 * `abvPercent` is optional on a golden case, and an empty cell is the right
 * output when it is absent. Three sources agree on that rule, so this
 * function does not invent it:
 *
 * - `audit/requirements/source-TH.md:44` lists alcohol content "with some
 *   exceptions for certain wine/beer".
 * - `src/server/batch/manifest.ts` reads an empty cell as `null` and reports
 *   no row error.
 * - `src/app/api/verify/parse-request.ts` applies the same rule to the
 *   single-label form.
 *
 * `case-02-clean-match-beer-no-abv` is the case that exercises it.
 */
export function caseToManifestRow(goldenCase: GoldenSetCase): ManifestCsvRow {
  const { application } = goldenCase;
  return {
    beverageType: goldenCase.beverageType,
    brandName: application.brandName,
    classType: application.classType,
    alcoholContentPercent: application.abvPercent ?? "",
    netContentsValue: application.netContentsValue,
    netContentsUnit: application.netContentsUnit as NetContentsUnit,
    // The manifest pairs a row to an image by FILENAME, never by upload
    // order (PRD §3.5). `imagePath` is repo-relative, so strip the
    // directory — the ZIP stores each image at its bare name.
    imageFilename: basename(goldenCase.imagePath),
  };
}

/** Reads `--count=N` from argv. Returns every case when the flag is absent.
 * A small count keeps a probe run cheap: each item costs one Haiku call, and
 * some items escalate to a Sonnet call on top. */
function parseCount(argv: readonly string[]): number | null {
  const flag = argv.find((arg) => arg.startsWith("--count="));
  if (!flag) return null;
  const value = Number(flag.slice("--count=".length));
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`batchFixture: --count must be a positive integer, got "${flag}"`);
  }
  return value;
}

function main(): void {
  const manifest = loadGoldenSetManifest();
  const count = parseCount(process.argv.slice(2));

  // An `ai-generated` case may have no committed image yet. Skip anything
  // whose file is absent rather than fail the whole build — the point is a
  // usable fixture, not a complete one.
  const usable = manifest.cases.filter((c) => {
    try {
      readFileSync(resolve(REPO_ROOT, c.imagePath));
      return true;
    } catch {
      return false;
    }
  });

  const selected = count === null ? usable : usable.slice(0, count);
  if (selected.length === 0) {
    throw new Error("batchFixture: no golden case has a committed image; nothing to build");
  }

  const csv = buildManifestCsv(selected.map(caseToManifestRow));

  const zipEntries: Record<string, Uint8Array> = {};
  for (const goldenCase of selected) {
    const bytes = readFileSync(resolve(REPO_ROOT, goldenCase.imagePath));
    zipEntries[basename(goldenCase.imagePath)] = new Uint8Array(bytes);
  }
  const zip = zipSync(zipEntries);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const csvPath = resolve(OUTPUT_DIR, "manifest.csv");
  const zipPath = resolve(OUTPUT_DIR, "images.zip");
  writeFileSync(csvPath, csv);
  writeFileSync(zipPath, zip);

  const skipped = manifest.cases.length - usable.length;
  console.log(`Built a batch fixture from ${selected.length} golden case(s).`);
  console.log(`  ${csvPath}  (${csv.length} bytes)`);
  console.log(`  ${zipPath}  (${zip.length} bytes)`);
  if (skipped > 0) {
    console.log(`  Skipped ${skipped} case(s) with no committed image.`);
  }

  // Every selected case already records its expected verdict. Print the
  // tally so a reader can check the batch summary against it rather than
  // against a guess.
  const expected = new Map<string, number>();
  for (const goldenCase of selected) {
    const verdict = goldenCase.expected.labelVerdict;
    expected.set(verdict, (expected.get(verdict) ?? 0) + 1);
  }
  const tally = [...expected].map(([verdict, n]) => `${n} ${verdict}`).join(" · ");
  console.log(`\nExpected label verdicts for this fixture: ${tally}`);
  console.log("Compare the batch results screen against that line.");
  console.log(
    "\nThe expected verdicts come from golden-set/manifest.json. The live run\n" +
      "may differ: 11 of 32 cases missed their expectation in the 2026-08-12\n" +
      "eval run, and docs/diagnostics/2026-08-12-verdict-miss-triage.md says\n" +
      "which are the pipeline's fault and which are the corpus's.",
  );
}

// Only run when invoked directly, so the test can import the pure helper.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
