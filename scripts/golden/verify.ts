/**
 * Golden-set verify gate (LH-006 / TRO-499, design doc §6/§7).
 *
 * The consumer-facing health check for `golden-set/manifest.json`: every
 * later ticket that reads the manifest (the eval harness, the latency
 * harness, the seeded demo) trusts that a green `pnpm golden:verify` means
 * the manifest and its images are internally consistent. Checks:
 *
 * 1. The manifest itself loads and passes schema validation
 *    (`src/lib/golden-set/loader.ts` — reused directly, not re-implemented;
 *    this is also where the `ai-generated` / `rendered+ai-backdrop`
 *    "verified before eval" rule already lives).
 * 2. Every case's `imagePath` resolves to a real, non-empty file.
 * 3. Every file under `golden-set/images/` resolves back to some case's
 *    `imagePath` — no orphans in either direction.
 * 4. Every `rendered+ai-backdrop` case's backdrop input file
 *    (`golden-set/backdrops/<caseId>.png`) exists.
 * 5. Every `audit/rubric.md` Appendix A vector V1-V10 is covered by at
 *    least one case, except the two tracked gaps this run already knows
 *    about (see `KNOWN_VECTOR_GAPS` below).
 *
 * Deliberately does no image decoding, no rendering, and no network call —
 * that split is intentional (design doc §7): decoding/size/format checks
 * live in `scripts/golden/images.test.ts`, and a real headless render is
 * `scripts/golden/renderSmoke.ts`'s job. This file stays fast, pure
 * metadata/filesystem checks, so CI can run it as its own quick, clearly
 * labeled step.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BottleReferenceValidationError,
  loadBottleReference,
} from "../../src/lib/golden-set/bottleReference";
import {
  GoldenSetValidationError,
  loadGoldenSetManifest,
} from "../../src/lib/golden-set/loader";
import type { RubricVector } from "../../src/lib/golden-set/types";

export type VerifyCheckId =
  | "manifest-parse"
  | "manifest-schema"
  | "image-exists"
  | "orphan-image"
  | "backdrop-exists"
  | "reference-bottle-exists"
  | "reference-bottle-schema"
  | "reference-photo-exists"
  | "vector-coverage"
  | "vector-coverage-drift";

export interface VerifyProblem {
  readonly check: VerifyCheckId;
  readonly caseId?: string;
  readonly message: string;
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly caseCount: number;
  readonly problems: VerifyProblem[];
  /** Rubric vectors with zero covering case that are a tracked, expected gap — reported, not a failure. */
  readonly knownGaps: string[];
}

export interface VerifyOptions {
  readonly repoRoot?: string;
  readonly manifestPath?: string;
  readonly imagesDir?: string;
  readonly backdropsDir?: string;
  readonly referencesDir?: string;
}

const ALL_VECTORS: readonly RubricVector[] = [
  "V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10",
];

/**
 * V7 (net-contents format match, e.g. "750 mL" vs "750ml") has no dedicated
 * case yet — a real, documented gap (`golden-set/README.md`,
 * `src/lib/golden-set/loader.test.ts`). Tracked here, not silently ignored:
 * `verifyGoldenSet` still fails if V7 STOPS being a gap without this set
 * getting updated in the same change (see the drift check below), and it
 * still fails if any OTHER vector loses coverage. Closing V7 for real means
 * adding a covering case AND deleting it from this set together — deleting
 * it alone, with no covering case, fails the coverage check instead.
 */
const KNOWN_VECTOR_GAPS: ReadonlySet<RubricVector> = new Set(["V7"]);

/** audit/rubric.md Appendix A, V10: "Batch of >=20 mixed pass/fail applications." A manifest-wide property, not a per-case tag. */
const MIN_BATCH_SIZE_FOR_V10 = 20;

function resolveRepoRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

/**
 * Runs every golden-set consistency check and returns a full report —
 * never throws for a data problem (a malformed manifest, a missing image),
 * only for a genuine environment failure (e.g. `repoRoot` itself doesn't
 * exist). Callers (the CLI `main` below, and tests) read `report.ok`
 * instead of catching.
 */
export function verifyGoldenSet(options: VerifyOptions = {}): VerifyReport {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const manifestPath = options.manifestPath ?? resolve(repoRoot, "golden-set/manifest.json");
  const imagesDir = options.imagesDir ?? resolve(repoRoot, "golden-set/images");
  const backdropsDir = options.backdropsDir ?? resolve(repoRoot, "golden-set/backdrops");
  const referencesDir = options.referencesDir ?? resolve(repoRoot, "assets/golden/references");

  const problems: VerifyProblem[] = [];

  // 1. The manifest must load and pass schema validation first. Every other
  // check below assumes a well-formed GoldenSetManifest, so a validation
  // failure short-circuits here rather than piling on confusing secondary
  // errors (a duplicate caseId can also trip the imagePath-basename check,
  // for one). This is also where the ai-generated / rendered+ai-backdrop
  // "verified before eval" rule already lives (loader.ts's checkCase) — not
  // re-implemented here.
  let manifest;
  try {
    manifest = loadGoldenSetManifest(manifestPath);
  } catch (err) {
    if (err instanceof GoldenSetValidationError) {
      for (const message of err.problems) {
        problems.push({ check: "manifest-schema", message });
      }
    } else {
      const message = err instanceof Error ? err.message : String(err);
      problems.push({ check: "manifest-parse", message: `golden-set manifest failed to load: ${message}` });
    }
    return { ok: false, caseCount: 0, problems, knownGaps: [] };
  }

  // 2. Every case's image must exist on disk and be non-empty.
  for (const c of manifest.cases) {
    const imagePath = resolve(repoRoot, c.imagePath);
    if (!existsSync(imagePath)) {
      problems.push({ check: "image-exists", caseId: c.caseId, message: `${c.caseId}: no file at ${c.imagePath}` });
    } else if (statSync(imagePath).size === 0) {
      problems.push({
        check: "image-exists",
        caseId: c.caseId,
        message: `${c.caseId}: ${c.imagePath} exists but is empty`,
      });
    }
  }

  // 3. Every file under golden-set/images/ must resolve back to some case's
  // imagePath — the reverse direction from check 2, catching a leftover
  // file from a renamed or deleted case, or a stray duplicate-extension file.
  const expectedBasenames = new Set(manifest.cases.map((c) => basename(c.imagePath)));
  if (existsSync(imagesDir)) {
    for (const entry of readdirSync(imagesDir)) {
      if (entry.startsWith(".")) continue; // .gitkeep, .DS_Store, etc.
      const fullPath = join(imagesDir, entry);
      if (!statSync(fullPath).isFile()) continue;
      if (!expectedBasenames.has(entry)) {
        problems.push({
          check: "orphan-image",
          message: `golden-set/images/${entry} has no manifest case whose imagePath resolves to it`,
        });
      }
    }
  }

  // 4. Every rendered+ai-backdrop case's backdrop input file must exist
  // (golden-set/README.md: "verify.ts will eventually check this track's
  // consistency too" — this is that check). build.ts reads this exact path.
  // Also (realistic-corpus design doc §6): the case's referenceBottle must
  // resolve to a real, schema-valid bottle reference JSON
  // (src/lib/golden-set/bottleReference.ts — reused, not re-implemented),
  // and that JSON's own referencePhoto must exist too.
  for (const c of manifest.cases) {
    if (c.provenance !== "rendered+ai-backdrop") continue;

    const backdropPath = resolve(backdropsDir, `${c.caseId}.png`);
    if (!existsSync(backdropPath)) {
      problems.push({
        check: "backdrop-exists",
        caseId: c.caseId,
        message: `${c.caseId}: no backdrop file at golden-set/backdrops/${c.caseId}.png`,
      });
    }

    if (!c.referenceBottle) continue; // schema violation already reported by loadGoldenSetManifest above
    const referencePath = resolve(referencesDir, `${c.referenceBottle}.json`);
    if (!existsSync(referencePath)) {
      problems.push({
        check: "reference-bottle-exists",
        caseId: c.caseId,
        message: `${c.caseId}: no bottle reference file at assets/golden/references/${c.referenceBottle}.json`,
      });
      continue;
    }
    try {
      const reference = loadBottleReference(referencePath);
      const photoPath = resolve(repoRoot, reference.referencePhoto);
      if (!existsSync(photoPath)) {
        problems.push({
          check: "reference-photo-exists",
          caseId: c.caseId,
          message: `${c.caseId}: bottle reference ${c.referenceBottle}'s referencePhoto (${reference.referencePhoto}) does not exist`,
        });
      }
    } catch (err) {
      const message =
        err instanceof BottleReferenceValidationError
          ? err.message
          : `unexpected error reading it: ${err instanceof Error ? err.message : String(err)}`;
      problems.push({
        check: "reference-bottle-schema",
        caseId: c.caseId,
        message: `${c.caseId}: bottle reference ${c.referenceBottle} failed validation — ${message}`,
      });
    }
  }

  // 5. Every rubric vector V1-V10 must be covered by at least one case,
  // except the tracked known gaps. V10 is special: audit/rubric.md Appendix
  // A defines it as a property of the manifest as a whole (a batch of
  // >=20), not something one case can individually claim.
  const covered = new Set(manifest.cases.flatMap((c) => c.vectors));
  const knownGaps: string[] = [];
  for (const vector of ALL_VECTORS) {
    if (vector === "V10") {
      if (manifest.cases.length < MIN_BATCH_SIZE_FOR_V10) {
        problems.push({
          check: "vector-coverage",
          message:
            `V10 needs a batch of at least ${MIN_BATCH_SIZE_FOR_V10} cases (audit/rubric.md Appendix A); ` +
            `manifest has ${manifest.cases.length}`,
        });
      }
      continue;
    }

    const isKnownGap = KNOWN_VECTOR_GAPS.has(vector);
    const isCovered = covered.has(vector);
    if (isCovered && isKnownGap) {
      problems.push({
        check: "vector-coverage-drift",
        message:
          `${vector} is now covered by at least one case, but scripts/golden/verify.ts still lists it in ` +
          `KNOWN_VECTOR_GAPS — remove it there (and update golden-set/README.md's gap note) in this change`,
      });
    } else if (!isCovered && !isKnownGap) {
      problems.push({
        check: "vector-coverage",
        message: `${vector} has zero covering case — every rubric vector V1-V10 needs at least one (audit/rubric.md Appendix A)`,
      });
    } else if (!isCovered && isKnownGap) {
      knownGaps.push(vector);
    }
  }

  return { ok: problems.length === 0, caseCount: manifest.cases.length, problems, knownGaps };
}

function printReport(report: VerifyReport): void {
  console.log(`Checked ${report.caseCount} golden-set case(s).`);
  for (const gap of report.knownGaps) {
    console.log(`  KNOWN GAP: ${gap} has zero covering case (tracked in golden-set/README.md).`);
  }
  if (report.ok) {
    console.log("PASS: golden set is consistent.");
    return;
  }
  console.log(`FAIL: ${report.problems.length} problem(s) found.`);
  for (const p of report.problems) {
    console.log(`  [${p.check}] ${p.message}`);
  }
}

function main(): void {
  const report = verifyGoldenSet();
  printReport(report);
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
