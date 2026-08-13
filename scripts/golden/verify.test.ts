/**
 * Tests for the golden-set verify gate (LH-006 / TRO-499).
 *
 * `verifyGoldenSet` never touches the real `golden-set/` directory except in
 * the last `describe` block, which deliberately checks the real committed
 * manifest. Every other test builds a small, isolated manifest + image tree
 * under a temp directory (`repoRoot` override) so each scenario tests
 * exactly one failure mode without needing 20+ hand-written cases to satisfy
 * the other checks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GoldenSetCase, RubricVector } from "../../src/lib/golden-set/types";
import { verifyGoldenSet } from "./verify";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One well-formed case, reused as a base for every fixture below (mirrors loader.test.ts's validCase). */
function baseCase(overrides: Partial<GoldenSetCase> = {}): GoldenSetCase {
  const caseId = overrides.caseId ?? "case-fixture";
  return {
    caseId,
    description: "Fixture case for verify.ts tests.",
    category: "clean-match",
    beverageType: "spirits",
    imagePath: `golden-set/images/${caseId}.jpg`,
    provenance: "rendered",
    verified: false,
    vectors: [],
    application: {
      brandName: "Test Brand",
      classType: "Test Class",
      abvPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    },
    label: {
      brandName: "Test Brand",
      classType: "Test Class",
      abvPresent: true,
      abvText: "45% Alc./Vol.",
      abvPercent: 45,
      netContentsText: "750 mL",
      netContentsValue: 750,
      netContentsUnit: "mL",
      governmentWarningPresent: true,
      governmentWarningText: "GOVERNMENT WARNING: test.",
      governmentWarningPrefixAllCaps: true,
      governmentWarningPrefixBold: true,
      governmentWarningBodyBold: false,
    },
    expected: {
      labelVerdict: "PASS",
      fields: {
        brandName: { verdict: "MATCH", reason: "Matches." },
        classType: { verdict: "MATCH", reason: "Matches." },
        abv: { verdict: "MATCH", reason: "Matches." },
        netContents: { verdict: "MATCH", reason: "Matches." },
        governmentWarning: { verdict: "MATCH", reason: "Matches." },
      },
    },
    ...overrides,
  };
}

/**
 * Eight of the ten rubric vectors, one per case index below — everything
 * except V7 and V10. V10 is a manifest-wide batch property, not a per-case
 * tag (see the V10-specific tests below). V7 is left uncovered on purpose:
 * the known-gap / drift tests further down inject `knownVectorGaps: new
 * Set(["V7"])` to exercise `verify.ts`'s tracked-gap mechanism against this
 * fixture. That injected set is independent of whichever vector, if any, is
 * genuinely untracked in the real, committed golden set right now — see
 * `verify.ts`'s own `KNOWN_VECTOR_GAPS`, empty as of TRO-515.
 */
const COVERABLE_VECTORS: readonly RubricVector[] = [
  "V1", "V2", "V3", "V4", "V5", "V6", "V8", "V9",
];

/** `count` cases (default 20, satisfying V10's batch-of->=20 property) with the first 8 each tagging one distinct COVERABLE_VECTORS entry. */
function validManifestCases(count = 20): GoldenSetCase[] {
  const cases: GoldenSetCase[] = [];
  for (let i = 1; i <= count; i++) {
    const caseId = `case-${String(i).padStart(2, "0")}-fixture`;
    const vector = COVERABLE_VECTORS[i - 1];
    cases.push(
      baseCase({
        caseId,
        imagePath: `golden-set/images/${caseId}.jpg`,
        vectors: vector ? [vector] : [],
      }),
    );
  }
  return cases;
}

/** Writes manifest.json plus a real (non-empty, content doesn't matter) file for every non-ai-generated case's imagePath. */
function writeFixture(
  repoRoot: string,
  cases: GoldenSetCase[],
  options: { skipImages?: Set<string> } = {},
): void {
  const goldenSetDir = join(repoRoot, "golden-set");
  mkdirSync(join(goldenSetDir, "images"), { recursive: true });
  writeFileSync(
    join(goldenSetDir, "manifest.json"),
    JSON.stringify({ version: "1.0.0", cases }, null, 2),
  );
  for (const c of cases) {
    if (options.skipImages?.has(c.caseId)) continue;
    if (c.provenance === "ai-generated") continue; // caller writes these explicitly when needed
    writeFileSync(join(repoRoot, c.imagePath), Buffer.from("fake-image-bytes"));
  }
}

describe("verifyGoldenSet — happy path", () => {
  it("passes against a fully valid fixture and reports an injected known gap", () => {
    const dir = makeTempDir();
    writeFixture(dir, validManifestCases());

    const report = verifyGoldenSet({ repoRoot: dir, knownVectorGaps: new Set(["V7"]) });

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.knownGaps).toEqual(["V7"]);
    expect(report.caseCount).toBe(20);
  });

  it("passes against a fully covered fixture with no override, and reports zero known gaps", () => {
    // The default path: no knownVectorGaps override, so this reads the real
    // KNOWN_VECTOR_GAPS in verify.ts — empty since TRO-515 closed V7. Tags
    // V7 onto one fixture case (on top of validManifestCases()'s existing
    // V1-V6/V8/V9 spread) so nothing is uncovered; against an empty tracked
    // set, a fixture with no genuine gap should report none.
    const dir = makeTempDir();
    const cases = validManifestCases().map((c) =>
      c.caseId === "case-01-fixture" ? { ...c, vectors: [...c.vectors, "V7" as RubricVector] } : c,
    );
    writeFixture(dir, cases);

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.knownGaps).toEqual([]);
  });
});

describe("verifyGoldenSet — image existence (manifest -> disk)", () => {
  it("fails when a case's image is missing from disk", () => {
    const dir = makeTempDir();
    const cases = validManifestCases();
    writeFixture(dir, cases, { skipImages: new Set([cases[0].caseId]) });

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "image-exists" && p.caseId === cases[0].caseId),
    ).toBe(true);
  });

  it("fails when a case's image file exists but is empty", () => {
    const dir = makeTempDir();
    const cases = validManifestCases();
    writeFixture(dir, cases);
    writeFileSync(join(dir, cases[0].imagePath), Buffer.alloc(0));

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some(
        (p) => p.check === "image-exists" && p.caseId === cases[0].caseId && p.message.includes("empty"),
      ),
    ).toBe(true);
  });
});

describe("verifyGoldenSet — orphan images (disk -> manifest)", () => {
  it("fails when a file in golden-set/images/ has no matching manifest case", () => {
    const dir = makeTempDir();
    writeFixture(dir, validManifestCases());
    writeFileSync(join(dir, "golden-set/images/case-99-orphan.jpg"), Buffer.from("x"));

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "orphan-image" && p.message.includes("case-99-orphan.jpg")),
    ).toBe(true);
  });

  it("ignores dotfiles in golden-set/images/ (e.g. .gitkeep, .DS_Store)", () => {
    const dir = makeTempDir();
    writeFixture(dir, validManifestCases());
    writeFileSync(join(dir, "golden-set/images/.gitkeep"), "");

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.problems.some((p) => p.check === "orphan-image")).toBe(false);
  });
});

describe("verifyGoldenSet — rubric vector coverage", () => {
  it("fails when a non-known-gap vector has zero covering case", () => {
    const dir = makeTempDir();
    const cases = validManifestCases().map((c) =>
      c.vectors.includes("V8") ? { ...c, vectors: [] as RubricVector[] } : c,
    );
    writeFixture(dir, cases);

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "vector-coverage" && p.message.includes("V8")),
    ).toBe(true);
  });

  it("fails when fewer than 20 cases exist, even if every per-case vector is covered", () => {
    const dir = makeTempDir();
    // 10 cases is enough to cover all 8 COVERABLE_VECTORS (one per case for
    // the first 8), but is below V10's batch-of->=20 threshold.
    writeFixture(dir, validManifestCases(10));

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "vector-coverage" && p.message.includes("V10")),
    ).toBe(true);
  });

  it("reports an injected known-gap vector as a known gap (not a failure) when nothing covers it", () => {
    const dir = makeTempDir();
    writeFixture(dir, validManifestCases());

    const report = verifyGoldenSet({ repoRoot: dir, knownVectorGaps: new Set(["V7"]) });

    expect(report.problems.some((p) => p.message.includes("V7"))).toBe(false);
    expect(report.knownGaps).toContain("V7");
  });

  it("fails when an injected known-gap vector becomes covered without updating the declaration (drift)", () => {
    const dir = makeTempDir();
    const cases = validManifestCases();
    cases[0] = { ...cases[0], vectors: [...cases[0].vectors, "V7"] };
    writeFixture(dir, cases);

    const report = verifyGoldenSet({ repoRoot: dir, knownVectorGaps: new Set(["V7"]) });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "vector-coverage-drift" && p.message.includes("V7")),
    ).toBe(true);
  });
});

describe("verifyGoldenSet — manifest validity", () => {
  it("fails, reporting every problem, when the manifest fails schema validation", () => {
    const dir = makeTempDir();
    const cases = validManifestCases();
    cases[1] = { ...cases[0] }; // exact duplicate -> duplicate caseId
    writeFixture(dir, cases);

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "manifest-schema" && p.message.includes("duplicate")),
    ).toBe(true);
  });

  it("fails when manifest.json is not valid JSON, without throwing", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "golden-set", "images"), { recursive: true });
    writeFileSync(join(dir, "golden-set/manifest.json"), "{ not valid json");

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.check === "manifest-parse")).toBe(true);
  });

  it("fails with a clear message when an ai-generated case is not verified, and skips other checks", () => {
    const dir = makeTempDir();
    const cases = [
      baseCase({
        caseId: "case-ai-1",
        provenance: "ai-generated",
        verified: false,
        imagePath: "golden-set/images/case-ai-1.png",
      }),
    ];
    writeFixture(dir, cases);

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.message.includes("ai-generated") && p.message.includes("verified")),
    ).toBe(true);
    // The manifest never loaded, so only the schema-validation problem(s)
    // should appear -- no image-exists / vector-coverage noise on top of it.
    expect(report.problems.every((p) => p.check === "manifest-schema")).toBe(true);
  });
});

describe("verifyGoldenSet — ai-generated cases (verified or excluded from eval)", () => {
  it("passes when an ai-generated case is verified and has a real image", () => {
    const dir = makeTempDir();
    const cases = validManifestCases();
    const aiCase = baseCase({
      caseId: "case-ai-ok",
      provenance: "ai-generated",
      verified: true,
      imagePath: "golden-set/images/case-ai-ok.png",
    });
    writeFixture(dir, [...cases, aiCase]);
    writeFileSync(join(dir, aiCase.imagePath), Buffer.from("fake-png-bytes"));

    // knownVectorGaps: this test's concern is the ai-generated verified/
    // image-exists check, not vector coverage — validManifestCases() always
    // leaves V7 uncovered (see its own doc comment), so an override is
    // needed for report.problems to come back genuinely empty.
    const report = verifyGoldenSet({ repoRoot: dir, knownVectorGaps: new Set(["V7"]) });

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails when a verified ai-generated case's image file is missing", () => {
    const dir = makeTempDir();
    const cases = validManifestCases();
    const aiCase = baseCase({
      caseId: "case-ai-missing-image",
      provenance: "ai-generated",
      verified: true,
      imagePath: "golden-set/images/case-ai-missing-image.png",
    });
    writeFixture(dir, [...cases, aiCase]); // writeFixture never writes ai-generated images

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "image-exists" && p.caseId === "case-ai-missing-image"),
    ).toBe(true);
  });
});

describe("verifyGoldenSet — rendered+ai-backdrop cases", () => {
  function backdropCase(overrides: Partial<GoldenSetCase> = {}): GoldenSetCase {
    return baseCase({
      caseId: "case-backdrop-1",
      imagePath: "golden-set/images/case-backdrop-1.jpg",
      provenance: "rendered+ai-backdrop",
      verified: true,
      referenceBottle: "amber-whiskey-01",
      scene: "bar-counter",
      cameraCondition: "steady",
      labelPlacement: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 1, y: 0 },
        bottomLeft: { x: 0, y: 1 },
        bottomRight: { x: 1, y: 1 },
      },
      generationMetadata: {
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        promptVersion: "v1",
        generatedAt: "2026-08-11T00:00:00.000Z",
      },
      ...overrides,
    });
  }

  const VALID_BOTTLE_REFERENCE = {
    bottleId: "amber-whiskey-01",
    referencePhoto: "assets/golden/references/amber-whiskey-01.jpg",
    beverageType: "spirits",
    bottleDescription: "tall amber glass whiskey bottle, cork stopper, tapered shoulders",
    scenes: [
      { sceneId: "bar-counter", setting: "a rustic dark-wood bar counter", lighting: "warm tungsten backlight" },
    ],
    cameraConditions: ["steady"],
  };

  function writeBackdropFile(repoRoot: string, caseId = "case-backdrop-1"): void {
    mkdirSync(join(repoRoot, "golden-set/backdrops"), { recursive: true });
    writeFileSync(join(repoRoot, `golden-set/backdrops/${caseId}.png`), Buffer.from("x"));
  }

  function writeValidReference(repoRoot: string): void {
    const dir = join(repoRoot, "assets/golden/references");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "amber-whiskey-01.json"), JSON.stringify(VALID_BOTTLE_REFERENCE));
    writeFileSync(join(dir, "amber-whiskey-01.jpg"), Buffer.from("fake-reference-photo"));
  }

  it("fails when a rendered+ai-backdrop case has no backdrop file", () => {
    const dir = makeTempDir();
    writeFixture(dir, [...validManifestCases(), backdropCase()]);
    writeValidReference(dir);
    // No golden-set/backdrops/case-backdrop-1.png written.

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "backdrop-exists" && p.caseId === "case-backdrop-1"),
    ).toBe(true);
  });

  it("fails when a rendered+ai-backdrop case's bottle reference JSON is missing", () => {
    const dir = makeTempDir();
    writeFixture(dir, [...validManifestCases(), backdropCase()]);
    writeBackdropFile(dir);
    // No assets/golden/references/amber-whiskey-01.json written.

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "reference-bottle-exists" && p.caseId === "case-backdrop-1"),
    ).toBe(true);
  });

  it("fails when a rendered+ai-backdrop case's bottle reference JSON fails schema validation", () => {
    const dir = makeTempDir();
    writeFixture(dir, [...validManifestCases(), backdropCase()]);
    writeBackdropFile(dir);
    const refDir = join(dir, "assets/golden/references");
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, "amber-whiskey-01.json"), JSON.stringify({ bottleId: "amber-whiskey-01" }));

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "reference-bottle-schema" && p.caseId === "case-backdrop-1"),
    ).toBe(true);
  });

  it("fails when a rendered+ai-backdrop case's bottle reference photo is missing", () => {
    const dir = makeTempDir();
    writeFixture(dir, [...validManifestCases(), backdropCase()]);
    writeBackdropFile(dir);
    const refDir = join(dir, "assets/golden/references");
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, "amber-whiskey-01.json"), JSON.stringify(VALID_BOTTLE_REFERENCE));
    // amber-whiskey-01.jpg (the referencePhoto) is not written.

    const report = verifyGoldenSet({ repoRoot: dir });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "reference-photo-exists" && p.caseId === "case-backdrop-1"),
    ).toBe(true);
  });

  it("passes when a rendered+ai-backdrop case's backdrop, bottle reference, and reference photo all exist", () => {
    const dir = makeTempDir();
    writeFixture(dir, [...validManifestCases(), backdropCase()]);
    writeBackdropFile(dir);
    writeValidReference(dir);

    // knownVectorGaps: this test's concern is the backdrop/reference checks,
    // not vector coverage — same reasoning as the ai-generated "passes" test
    // above.
    const report = verifyGoldenSet({ repoRoot: dir, knownVectorGaps: new Set(["V7"]) });

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

// TRO-529 / LH-024 — the new "photographed" provenance and its own
// imagePath convention (assets/golden/references/<original-filename>, not
// golden-set/images/<caseId>).
describe("verifyGoldenSet — photographed cases (TRO-529 / LH-024)", () => {
  function photographedCase(overrides: Partial<GoldenSetCase> = {}): GoldenSetCase {
    return baseCase({
      caseId: "case-photo-1",
      provenance: "photographed",
      imagePath: "assets/golden/references/case-photo-1-original-name.jpg",
      label: {
        ...baseCase().label,
        governmentWarningPrefixBold: "unknown",
        governmentWarningBodyBold: "unknown",
      },
      ...overrides,
    });
  }

  it("passes when a photographed case's imagePath resolves inside assets/golden/references/", () => {
    const dir = makeTempDir();
    const referencesDir = join(dir, "assets/golden/references");
    mkdirSync(referencesDir, { recursive: true });
    writeFileSync(join(referencesDir, "case-photo-1-original-name.jpg"), Buffer.from("fake-photo-bytes"));
    writeFixture(dir, [...validManifestCases(), photographedCase()]);

    const report = verifyGoldenSet({ repoRoot: dir, knownVectorGaps: new Set(["V7"]) });

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails when a photographed case's imagePath escapes assets/golden/references/ via path traversal", () => {
    // A plain wrong prefix (e.g. "golden-set/images/...") is already caught
    // earlier, at manifest-schema validation (loader.ts's checkCase's own
    // string-prefix check) — verifyGoldenSet never reaches its own checks
    // in that case (verify.ts's own step 1: a schema failure short-
    // circuits). This check exists for what a STRING-prefix test cannot
    // catch: a value that starts with the right prefix as text but
    // resolves outside it once "../" segments collapse — the same
    // reasoning build.ts's resolveImagePath already applies to
    // golden-set/images/.
    const dir = makeTempDir();
    // "assets/golden/references/../../outside-references/evil.jpg" pops
    // just "references" and "golden" (two ".." for two popped segments),
    // landing at assets/outside-references/evil.jpg — still outside
    // assets/golden/references/, which is all this test needs.
    const outsideDir = join(dir, "assets/outside-references");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "evil.jpg"), Buffer.from("fake-photo-bytes"));
    writeFixture(dir, [
      ...validManifestCases(),
      photographedCase({ imagePath: "assets/golden/references/../../outside-references/evil.jpg" }),
    ]);

    const report = verifyGoldenSet({ repoRoot: dir, knownVectorGaps: new Set(["V7"]) });

    expect(report.ok).toBe(false);
    expect(
      report.problems.some((p) => p.check === "photographed-image-location" && p.caseId === "case-photo-1"),
    ).toBe(true);
  });
});

describe("verifyGoldenSet — the real committed golden set", () => {
  it("passes with zero problems and reports zero known gaps (V7 closed by TRO-515)", () => {
    // No repoRoot override: checks the actual golden-set/manifest.json and
    // golden-set/images/ committed to this repo. KNOWN_VECTOR_GAPS in
    // verify.ts is empty: V7 (net-contents format match) was its last
    // entry, closed by case-30-clean-match-net-contents-alt-format. If a
    // FUTURE vector loses its only covering case, this test starts
    // failing -- add a real covering case first; only fall back to tracking
    // it in KNOWN_VECTOR_GAPS, in the same change, if closing it right away
    // is not possible.
    const report = verifyGoldenSet();

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.knownGaps).toEqual([]);
    expect(report.caseCount).toBeGreaterThanOrEqual(20);
  });
});
