/**
 * Test-data builders for the E2E suite (TRO-479, TH-R12, TH-R20). Every
 * spec that needs a corrupt image, an oversized upload, the dedicated
 * failure-trigger image, a real golden-set photo, a CSV manifest, or a
 * run-unique identifier gets it from here — one source, so a fixture's
 * exact shape never silently drifts between spec files.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { BeverageType } from "../../src/lib/db/enums";
import { MANIFEST_COLUMNS, NET_CONTENTS_UNITS, type ManifestColumn } from "../../src/server/batch/types";
import { MAX_UPLOAD_BYTES } from "../../src/server/preprocessing/constants";
import { FAILURE_TRIGGER_MAX_BYTES } from "./fake-anthropic-server";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(THIS_DIR, "../..");
export const GOLDEN_SET_IMAGES_DIR = path.join(REPO_ROOT, "golden-set", "images");

/**
 * A run-unique tag, e.g. `"e2e-verify-abv1x9k-1755000000000"`. Every spec
 * that creates data (an application, a batch job, a review-queue row)
 * tags an identifying field with one of these — repeated `pnpm test:e2e`
 * runs against the same persistent worktree database must never collide
 * with a previous run's leftover rows, and one spec file must never
 * mistake another's concurrently-created row for its own (`fullyParallel:
 * true`, `playwright.config.ts`). Assertions then look up "the row
 * containing MY tag", never "the Nth row" or "the only row" — the
 * resilient-selector discipline this ticket's brief asks for, applied to
 * test DATA identity, not just DOM selectors.
 */
export function uniqueTag(label: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `e2e-${label}-${random}-${Date.now()}`;
}

/** Reads a real, committed golden-set image (TH-R12: "create or source
 * additional test labels" — this repo's committed set, referenced here by
 * a real file read, not a fabricated fixture). */
export function readGoldenImage(filename: string): Buffer {
  return readFileSync(path.join(GOLDEN_SET_IMAGES_DIR, filename));
}

/** The default happy-path image every spec that does not need a specific
 * failure mode uses: `golden-set/manifest.json`'s case-01, the "TH-R11
 * reference example" — real, committed, and the same photo
 * `fake-anthropic-server.ts`'s default extraction body describes. */
export function readDefaultGoldenImage(): Buffer {
  return readGoldenImage("case-01-clean-match-spirits.jpg");
}

/**
 * A tiny, real, valid JPEG — small enough that
 * `fake-anthropic-server.ts` always classifies it as the deliberate
 * failure trigger, never the default happy-path extraction. No real
 * golden-set photo is anywhere close to this small (case-01 alone is
 * comfortably five figures of bytes as JPEG); preprocessing never enlarges
 * a small image (`withoutEnlargement: true`,
 * `src/server/preprocessing/pipeline.ts`), so this reaches the fake
 * server at exactly this tiny size, every time.
 */
export async function buildFailureTriggerImage(): Promise<Buffer> {
  const buffer = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 34, b: 56 } },
  })
    .jpeg({ quality: 60 })
    .toBuffer();
  if (buffer.length >= FAILURE_TRIGGER_MAX_BYTES) {
    // Defensive, standing rule 13: a future change to sharp's own encoder
    // or to the threshold must fail this loudly, at the point a spec asks
    // for the image, rather than silently turning into a flaky E2E test
    // that sometimes gets the wrong canned response.
    throw new Error(
      `buildFailureTriggerImage: produced ${buffer.length} bytes, which is not below FAILURE_TRIGGER_MAX_BYTES (${FAILURE_TRIGGER_MAX_BYTES}). Shrink the fixture or raise the threshold deliberately.`,
    );
  }
  return buffer;
}

/**
 * A real JPEG, truncated mid-file — the same "valid header, damaged pixel
 * data" technique `src/app/api/verify/route.test.ts`'s own "an unreadable
 * image" case already uses (see that test's comment), applied here to
 * produce a real file a real browser can upload. sharp recognizes the
 * JPEG format from the header, then fails to decode the (now-missing)
 * pixel data — `UnreadableImageError`, distinct from an unsupported
 * format (no recognizable header at all) and from a low-quality-but-
 * readable photo (LOW_IMAGE_QUALITY, a router judgment call, not a
 * preprocessing rejection).
 */
export async function buildCorruptImage(): Promise<Buffer> {
  const real = await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 210, g: 210, b: 210 } },
  })
    .jpeg()
    .toBuffer();
  return real.subarray(0, Math.floor(real.length / 2));
}

/**
 * Bigger than `MAX_UPLOAD_BYTES` — deliberately not a real image.
 * `assertUploadSize` (`src/server/preprocessing/validate.ts`) rejects an
 * oversized upload before any decode is attempted, so the content only
 * needs to be the right size, matching
 * `src/app/api/verify/route.test.ts`'s own "an oversized file" case.
 */
export function buildOversizedFile(): Buffer {
  return Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0);
}

export interface ManifestCsvRow {
  beverageType: BeverageType;
  brandName: string;
  classType: string;
  /** `undefined`/`""` renders as a blank cell — legal for beer/wine
   * (PRD §2), matching `parseManifest`'s own rule. */
  alcoholContentPercent?: number | "";
  netContentsValue: number;
  netContentsUnit: (typeof NET_CONTENTS_UNITS)[number];
  imageFilename: string;
}

/** RFC 4180 quoting, applied only when a cell actually needs it — every
 * value this suite's fixtures pass is plain ASCII with no comma/quote/
 * newline, so this is a correctness safety net, not a path any current
 * spec exercises. */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function manifestRowToCells(row: ManifestCsvRow): Record<ManifestColumn, string> {
  return {
    beverage_type: row.beverageType,
    brand_name: row.brandName,
    class_type: row.classType,
    alcohol_content_percent: row.alcoholContentPercent === undefined || row.alcoholContentPercent === "" ? "" : String(row.alcoholContentPercent),
    net_contents_value: String(row.netContentsValue),
    net_contents_unit: row.netContentsUnit,
    image_filename: row.imageFilename,
  };
}

/**
 * Builds a manifest CSV text body: the exact header row
 * `src/server/batch/types.ts`'s `MANIFEST_COLUMNS` requires, in that
 * order, then one data row per entry in `rows`. `overrideHeader` lets a
 * malformed-CSV test drop or rename a column deliberately, while every
 * other row-building rule stays the same as the well-formed case — a
 * malformed-CSV test should differ from a well-formed one in exactly the
 * one way it is testing, not accidentally in several.
 */
export function buildManifestCsv(rows: ManifestCsvRow[], overrideHeader?: readonly string[]): string {
  const header = (overrideHeader ?? MANIFEST_COLUMNS).join(",");
  const lines = rows.map((row) => {
    const cells = manifestRowToCells(row);
    return MANIFEST_COLUMNS.map((col) => csvField(cells[col])).join(",");
  });
  return [header, ...lines].join("\n") + "\n";
}
