# Realistic Golden-Set Corpus Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full tooling for the realistic-corpus track — reference-photo-driven Gemini backdrop generation, automated label-placement detection, deterministic compositing — so it is ready to run the moment Troy supplies real bottle photos. This plan does not generate the real corpus (no reference photos exist yet); it builds and tests every component against synthetic fixtures.

**Architecture:** A hand-authored per-bottle JSON (`assets/golden/references/*.json`) drives a deterministic prompt compiler (`imagenPrompt.ts`), which feeds Gemini 3.1 Flash Image (`imagen.ts`). Each generated backdrop is scanned for its blank label region (`blankRegionDetector.ts`) and the result is committed as a raw backdrop PNG + a `.meta.json` sidecar — never written into `manifest.json` automatically. A human folds that sidecar into a `rendered+ai-backdrop` manifest case. From there, `build.ts` (already the deterministic, network-free orchestrator) composites the renderer's exact-text label onto the committed backdrop (`compositeBackdrop.ts`) on every rebuild — no further network calls, matching the existing `rendered`/`rendered+degraded` determinism contract.

**Tech Stack:** TypeScript, `sharp` (already a dependency), `@google/genai` (new dependency), `vitest`, existing `src/lib/golden-set/{types,loader}.ts` and `scripts/golden/{render,degrade,build}.ts`.

## Global Constraints

- CI never calls an image API. Every unit test in this plan uses synthetic, locally-generated fixtures (drawn with `sharp` itself) — never a real Gemini call. (Design doc §8, matching the existing rule in `docs/superpowers/specs/2026-08-10-golden-label-image-gen-design.md` §2.)
- AI-generated images are committed to git, not regenerated on demand — generation is not reproducible. (Design doc §10.)
- `GOOGLE_API_KEY` lives in `.env.local` only, already documented in `.env.local.example`. Never hardcode a key.
- No hard budget ceiling on generation spend; `imagen.ts` logs running estimated spend instead. (Design doc §9.)
- Model: `gemini-3.1-flash-image`. Never `gemini-2.5-flash-image` (retires 2026-10-02, design doc §4).
- Keep the prompt compiler boring: no LLM-generated prompt layer, no dynamic prompt rewriting, no per-bottle prompt customization. (Design doc §3 guardrail.)
- Never weaken a spec (or a validation check) to make a test pass (CLAUDE.md non-negotiable).
- Every comment explains *why*, not *what* — match the existing style in `render.ts`/`degrade.ts`/`loader.ts` (dense rationale comments citing the design doc section they implement), not a generic doc-comment style.
- `scripts/golden/verify.ts` (LH-006) does not exist yet and is out of scope for this plan — its "must additionally check `rendered+ai-backdrop` fields" requirement (design doc §6) belongs to whichever ticket builds it.
- Generating the real corpus (running `pnpm golden:imagen` against real reference photos) is out of scope for this plan — Troy hasn't supplied photos yet. This plan ends with a tested, working pipeline and empty `assets/golden/references/`/`golden-set/backdrops/` directories.

---

## Task 1: Extend the golden-set schema for `rendered+ai-backdrop`

**Files:**
- Modify: `src/lib/golden-set/types.ts`
- Modify: `src/lib/golden-set/loader.ts`
- Modify: `src/lib/golden-set/loader.test.ts`

**Interfaces:**
- Produces: `GoldenSetProvenance` gains `"rendered+ai-backdrop"`. New types `LabelPlacementQuad`, `GenerationMetadata`, `CameraCondition` (re-exported from `types.ts`; `CameraCondition`'s canonical definition lands in Task 2's `bottleReference.ts`, but `types.ts` needs it too — define it in `types.ts` instead and have `bottleReference.ts` import it from there, so there is exactly one definition). New optional `GoldenSetCase` fields: `referenceBottle?: string`, `scene?: string`, `cameraCondition?: CameraCondition`, `labelPlacement?: LabelPlacementQuad`, `generationMetadata?: GenerationMetadata`.

- [ ] **Step 1: Write the failing tests in `loader.test.ts`**

Add these tests, reusing the existing `validCase()`/`manifest()` helpers already in the file:

```typescript
describe("validateManifest — rendered+ai-backdrop provenance", () => {
  const aiBackdropCase = (overrides: Partial<GoldenSetCase> = {}): GoldenSetCase =>
    validCase({
      caseId: "case-ai-backdrop-amber-whiskey-01-bar-counter-steady",
      imagePath: "golden-set/images/case-ai-backdrop-amber-whiskey-01-bar-counter-steady.jpg",
      provenance: "rendered+ai-backdrop",
      verified: true,
      referenceBottle: "amber-whiskey-01",
      scene: "bar-counter",
      cameraCondition: "steady",
      labelPlacement: {
        topLeft: { x: 120, y: 90 },
        topRight: { x: 420, y: 100 },
        bottomLeft: { x: 130, y: 380 },
        bottomRight: { x: 430, y: 390 },
      },
      generationMetadata: {
        model: "gemini-3.1-flash-image",
        resolution: "1K",
        promptVersion: "v1",
        generatedAt: "2026-08-11T00:00:00.000Z",
      },
      ...overrides,
    });

  it("accepts a well-formed rendered+ai-backdrop case", () => {
    const result = validateManifest(manifest([aiBackdropCase()]));
    expect(result.cases).toHaveLength(1);
  });

  it("rejects rendered+ai-backdrop with verified: false", () => {
    expect(() => validateManifest(manifest([aiBackdropCase({ verified: false })]))).toThrow(
      GoldenSetValidationError,
    );
  });

  it("rejects rendered+ai-backdrop missing referenceBottle", () => {
    const broken = manifest([aiBackdropCase()]);
    // referenceBottle is an optional field on GoldenSetCase (valid on any
    // provenance at the type level — the "only on rendered+ai-backdrop"
    // rule is manifest-level, not a type constraint), so deleting it here
    // is not a type error and needs no @ts-expect-error.
    delete broken.cases[0].referenceBottle;
    try {
      validateManifest(broken);
      expect.unreachable("validateManifest should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GoldenSetValidationError);
      expect((err as GoldenSetValidationError).problems.some((p) => p.includes("referenceBottle"))).toBe(
        true,
      );
    }
  });

  it("rejects an invalid cameraCondition value", () => {
    expect(() =>
      validateManifest(
        // @ts-expect-error -- intentionally invalid enum value for the red-first test
        manifest([aiBackdropCase({ cameraCondition: "underwater" })]),
      ),
    ).toThrow(GoldenSetValidationError);
  });

  it("rejects labelPlacement with a non-numeric corner", () => {
    expect(() =>
      validateManifest(
        manifest([
          aiBackdropCase({
            // @ts-expect-error -- intentionally malformed input for the red-first test
            labelPlacement: { topLeft: { x: "left", y: 0 }, topRight: { x: 1, y: 0 }, bottomLeft: { x: 0, y: 1 }, bottomRight: { x: 1, y: 1 } },
          }),
        ]),
      ),
    ).toThrow(GoldenSetValidationError);
  });

  it("rejects generationMetadata missing promptVersion", () => {
    const broken = manifest([aiBackdropCase()]);
    // @ts-expect-error -- intentionally malformed input for the red-first test
    delete broken.cases[0].generationMetadata.promptVersion;
    expect(() => validateManifest(broken)).toThrow(GoldenSetValidationError);
  });

  it("rejects referenceBottle set on a rendered (non-ai-backdrop) case", () => {
    // referenceBottle is type-valid on any GoldenSetCase regardless of
    // provenance (same reasoning as above) — this is a manifest-level
    // rule, so no @ts-expect-error is expected here either.
    expect(() =>
      validateManifest(manifest([validCase({ referenceBottle: "amber-whiskey-01" })])),
    ).toThrow(GoldenSetValidationError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/lib/golden-set/loader.test.ts`
Expected: FAIL — `types.ts` does not have these fields yet (TypeScript errors on the object literals) and `loader.ts` does not validate them.

- [ ] **Step 3: Extend `types.ts`**

Add near `GoldenSetProvenance`:

```typescript
/**
 * The three photographic conditions Gemini generates for the
 * realistic-corpus track (design doc §3,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md).
 * Baked into the generation prompt itself, not a `degrade.ts` transform —
 * these are properties of the Gemini-generated photo, not a deterministic
 * sharp filter applied afterward.
 */
export type CameraCondition = "steady" | "motion-blur" | "camera-shake";
```

Change:

```typescript
export type GoldenSetProvenance = "rendered" | "rendered+degraded" | "ai-generated";
```

to:

```typescript
export type GoldenSetProvenance =
  | "rendered"
  | "rendered+degraded"
  | "ai-generated"
  | "rendered+ai-backdrop";
```

Add after `Degradation`:

```typescript
/** One 2D point, in the pixel space of a committed backdrop image. */
export interface Point2D {
  readonly x: number;
  readonly y: number;
}

/**
 * The 4 corners of the blank label region a `rendered+ai-backdrop` case's
 * backdrop photo carries, as either `blankRegionDetector.ts` found them or
 * a human recorded them by hand (design doc §5). `build.ts` warps the
 * renderer's label into this exact quad on every rebuild — recording it
 * here, not re-detecting it at build time, is what keeps `build.ts`
 * network-free and deterministic even though the backdrop photo itself
 * was not.
 */
export interface LabelPlacementQuad {
  readonly topLeft: Point2D;
  readonly topRight: Point2D;
  readonly bottomLeft: Point2D;
  readonly bottomRight: Point2D;
}

/**
 * Forensic record of how a `rendered+ai-backdrop` case's backdrop photo
 * was generated — which model, at what resolution, with which prompt
 * template version, and when. Not a reproducibility claim (design doc
 * §6/§10): re-running generation will not produce the same bytes. This
 * lets anyone looking at a committed image later understand why it looks
 * the way it does.
 */
export interface GenerationMetadata {
  readonly model: string;
  readonly resolution: string;
  readonly promptVersion: string;
  readonly generatedAt: string;
}
```

Add these optional fields to `GoldenSetCase`, near `degradations`:

```typescript
  /**
   * The bottle reference JSON (`assets/golden/references/<id>.json`) this
   * case's backdrop was generated from. Present only on a
   * `rendered+ai-backdrop` case (design doc §6).
   */
  referenceBottle?: string;
  /** The `sceneId` (from the bottle reference's `scenes` list) this case's backdrop used. Present only on a `rendered+ai-backdrop` case. */
  scene?: string;
  /** The photographic condition Gemini generated this case's backdrop under. Present only on a `rendered+ai-backdrop` case. */
  cameraCondition?: CameraCondition;
  /** Where on the backdrop the renderer's label gets composited. Present only on a `rendered+ai-backdrop` case. */
  labelPlacement?: LabelPlacementQuad;
  /** How this case's backdrop was generated — forensic, not reproducible. Present only on a `rendered+ai-backdrop` case. */
  generationMetadata?: GenerationMetadata;
```

- [ ] **Step 4: Extend `loader.ts`**

Add to the imports from `./types`: `CameraCondition`.

Add near the other constant arrays (after `PROVENANCE_VALUES`):

```typescript
const CAMERA_CONDITIONS: readonly CameraCondition[] = ["steady", "motion-blur", "camera-shake"];
const AI_BACKDROP_ONLY_FIELDS = [
  "referenceBottle",
  "scene",
  "cameraCondition",
  "labelPlacement",
  "generationMetadata",
] as const;
```

Change `PROVENANCE_VALUES`:

```typescript
const PROVENANCE_VALUES: readonly GoldenSetProvenance[] = [
  "rendered",
  "rendered+degraded",
  "ai-generated",
  "rendered+ai-backdrop",
];
```

Add two new checker functions, near `checkDegradations`:

```typescript
/**
 * Validates a `rendered+ai-backdrop` case's `labelPlacement` — the 4
 * corners `build.ts` warps the renderer's label into on every rebuild
 * (design doc §5/§6). Each corner just needs finite x/y; the geometry
 * itself (does this quad make sense on the backdrop) is a human's job at
 * `verified: true` time, not a schema check.
 */
function checkLabelPlacement(problems: string[], where: string, raw: unknown): void {
  if (!isRecord(raw)) {
    problems.push(`${where}: "labelPlacement" must be an object`);
    return;
  }
  for (const corner of ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const) {
    const point = raw[corner];
    if (!isRecord(point) || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
      problems.push(`${where}.labelPlacement.${corner}: must be an object with finite "x" and "y"`);
    }
  }
}

/**
 * Validates a `rendered+ai-backdrop` case's `generationMetadata` — a
 * forensic record, not a reproducibility claim (design doc §6/§10). Every
 * field is a required non-empty string; there is no enum to check against
 * here because the model name and resolution are free text describing
 * whatever `imagen.ts` actually used, not a closed set this schema owns.
 */
function checkGenerationMetadata(problems: string[], where: string, raw: unknown): void {
  if (!isRecord(raw)) {
    problems.push(`${where}: "generationMetadata" must be an object`);
    return;
  }
  const w = `${where}.generationMetadata`;
  checkField(problems, w, raw, "model", isNonEmptyString, "a non-empty string");
  checkField(problems, w, raw, "resolution", isNonEmptyString, "a non-empty string");
  checkField(problems, w, raw, "promptVersion", isNonEmptyString, "a non-empty string");
  checkField(problems, w, raw, "generatedAt", isNonEmptyString, "a non-empty string");
}
```

In `checkCase`, immediately after the existing block:

```typescript
  if (raw.provenance === "ai-generated" && raw.verified !== true) {
    // ... existing code, unchanged ...
  }
```

add:

```typescript
  if (raw.provenance === "rendered+ai-backdrop") {
    // Design doc §6: no warning-text transcription risk (the renderer owns
    // that text), but a human must still confirm the composited label
    // landed legibly and correctly placed before eval may trust the case —
    // the same verified: true gate as ai-generated, checked here rather
    // than only in the type because this is a manifest-level rule.
    checkField(problems, caseLabel, raw, "referenceBottle", isNonEmptyString, "a non-empty string");
    checkField(problems, caseLabel, raw, "scene", isNonEmptyString, "a non-empty string");
    checkEnum(problems, caseLabel, raw, "cameraCondition", CAMERA_CONDITIONS);
    if ("labelPlacement" in raw) {
      checkLabelPlacement(problems, caseLabel, raw.labelPlacement);
    } else {
      problems.push(`${caseLabel}: missing required field "labelPlacement"`);
    }
    if ("generationMetadata" in raw) {
      checkGenerationMetadata(problems, caseLabel, raw.generationMetadata);
    } else {
      problems.push(`${caseLabel}: missing required field "generationMetadata"`);
    }
    if (raw.verified !== true) {
      problems.push(
        `${caseLabel}: provenance "rendered+ai-backdrop" requires verified: true before the eval harness may use it (currently ${JSON.stringify(raw.verified)})`,
      );
    }
  } else {
    // A rendered/rendered+degraded/ai-generated case has no business
    // carrying backdrop-generation traceability fields — the same
    // closed-schema reasoning checkDegradations already applies to a
    // non-rendered+degraded case's degradations list.
    for (const key of AI_BACKDROP_ONLY_FIELDS) {
      if (key in raw && raw[key] !== undefined) {
        problems.push(
          `${caseLabel}: field "${key}" is only valid when provenance is "rendered+ai-backdrop" (currently ${JSON.stringify(raw.provenance)})`,
        );
      }
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- src/lib/golden-set/loader.test.ts`
Expected: PASS, all tests including the 7 new ones.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/golden-set/types.ts src/lib/golden-set/loader.ts src/lib/golden-set/loader.test.ts
git commit -m "feat(golden-set): add rendered+ai-backdrop provenance and schema"
```

---

## Task 2: Bottle reference type and loader

**Files:**
- Create: `src/lib/golden-set/bottleReference.ts`
- Create: `src/lib/golden-set/bottleReference.test.ts`

**Interfaces:**
- Consumes: `CameraCondition` from `./types` (Task 1).
- Produces: `BottleScene { sceneId, setting, lighting }`, `BottleReference { bottleId, referencePhoto, beverageType, bottleDescription, scenes, cameraConditions }`, `BottleReferenceValidationError`, `validateBottleReference(raw: unknown): BottleReference`, `loadBottleReference(path: string): BottleReference`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/golden-set/bottleReference.test.ts
import { describe, expect, it } from "vitest";
import { BottleReferenceValidationError, validateBottleReference } from "./bottleReference";

const VALID = {
  bottleId: "amber-whiskey-01",
  referencePhoto: "assets/golden/references/amber-whiskey-01.jpg",
  beverageType: "spirits",
  bottleDescription: "tall amber glass whiskey bottle, cork stopper, tapered shoulders",
  scenes: [
    { sceneId: "bar-counter", setting: "a rustic dark-wood bar counter", lighting: "warm tungsten backlight" },
  ],
  cameraConditions: ["steady", "motion-blur"],
};

describe("validateBottleReference", () => {
  it("accepts a well-formed reference", () => {
    expect(validateBottleReference(VALID)).toEqual(VALID);
  });

  it("rejects a missing bottleId", () => {
    const { bottleId: _drop, ...rest } = VALID;
    expect(() => validateBottleReference(rest)).toThrow(BottleReferenceValidationError);
  });

  it("rejects an unrecognized beverageType", () => {
    expect(() => validateBottleReference({ ...VALID, beverageType: "cider" })).toThrow(
      BottleReferenceValidationError,
    );
  });

  it("rejects an empty scenes array", () => {
    expect(() => validateBottleReference({ ...VALID, scenes: [] })).toThrow(
      BottleReferenceValidationError,
    );
  });

  it("rejects a scene missing lighting", () => {
    const { lighting: _drop, ...sceneRest } = VALID.scenes[0];
    expect(() => validateBottleReference({ ...VALID, scenes: [sceneRest] })).toThrow(
      BottleReferenceValidationError,
    );
  });

  it("rejects an unknown camera condition", () => {
    expect(() => validateBottleReference({ ...VALID, cameraConditions: ["underwater"] })).toThrow(
      BottleReferenceValidationError,
    );
  });

  it("collects every problem, not just the first", () => {
    try {
      validateBottleReference({ scenes: [], cameraConditions: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BottleReferenceValidationError);
      const problems = (err as BottleReferenceValidationError).problems;
      expect(problems.length).toBeGreaterThan(1);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/lib/golden-set/bottleReference.test.ts`
Expected: FAIL — `./bottleReference` module does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/golden-set/bottleReference.ts
/**
 * A real bottle reference photo Troy supplies for the realistic-corpus
 * track (design doc §3,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md). One
 * hand-authored JSON file per photo, committed alongside it under
 * assets/golden/references/. Data only — never its own prompt phrasing.
 * scripts/golden/imagenPrompt.ts is the single place that turns this data
 * into prose (design doc §3's "keep the compiler boring" guardrail).
 */
import { readFileSync } from "node:fs";
import type { CameraCondition } from "./types";

export interface BottleScene {
  readonly sceneId: string;
  readonly setting: string;
  readonly lighting: string;
}

export interface BottleReference {
  readonly bottleId: string;
  readonly referencePhoto: string;
  readonly beverageType: "beer" | "wine" | "spirits";
  readonly bottleDescription: string;
  readonly scenes: readonly BottleScene[];
  readonly cameraConditions: readonly CameraCondition[];
}

/** Thrown when a bottle reference JSON fails validation. `problems` lists every issue found, not just the first. */
export class BottleReferenceValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `bottle reference failed validation (${problems.length} problem(s)):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "BottleReferenceValidationError";
    this.problems = problems;
  }
}

const BEVERAGE_TYPES = ["beer", "wine", "spirits"] as const;
const CAMERA_CONDITIONS: readonly CameraCondition[] = ["steady", "motion-blur", "camera-shake"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateBottleReference(raw: unknown): BottleReference {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    throw new BottleReferenceValidationError(["root must be an object"]);
  }

  for (const key of ["bottleId", "referencePhoto", "bottleDescription"] as const) {
    if (!isNonEmptyString(raw[key])) {
      problems.push(`field "${key}" must be a non-empty string, got ${JSON.stringify(raw[key])}`);
    }
  }

  if (!(BEVERAGE_TYPES as readonly string[]).includes(raw.beverageType as string)) {
    problems.push(
      `field "beverageType" must be one of ${BEVERAGE_TYPES.join(", ")}, got ${JSON.stringify(raw.beverageType)}`,
    );
  }

  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) {
    problems.push('field "scenes" must be a non-empty array');
  } else {
    raw.scenes.forEach((scene: unknown, i: number) => {
      if (!isRecord(scene)) {
        problems.push(`scenes[${i}] must be an object`);
        return;
      }
      for (const key of ["sceneId", "setting", "lighting"] as const) {
        if (!isNonEmptyString(scene[key])) {
          problems.push(`scenes[${i}].${key} must be a non-empty string, got ${JSON.stringify(scene[key])}`);
        }
      }
    });
  }

  if (!Array.isArray(raw.cameraConditions) || raw.cameraConditions.length === 0) {
    problems.push('field "cameraConditions" must be a non-empty array');
  } else {
    raw.cameraConditions.forEach((c: unknown, i: number) => {
      if (typeof c !== "string" || !CAMERA_CONDITIONS.includes(c as CameraCondition)) {
        problems.push(
          `cameraConditions[${i}] must be one of ${CAMERA_CONDITIONS.join(", ")}, got ${JSON.stringify(c)}`,
        );
      }
    });
  }

  if (problems.length > 0) {
    throw new BottleReferenceValidationError(problems);
  }
  return raw as unknown as BottleReference;
}

/** Reads and validates one bottle reference JSON file from disk. */
export function loadBottleReference(path: string): BottleReference {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return validateBottleReference(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/lib/golden-set/bottleReference.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/golden-set/bottleReference.ts src/lib/golden-set/bottleReference.test.ts
git commit -m "feat(golden-set): add bottle reference type and validator"
```

---

## Task 3: Prompt compiler

**Files:**
- Create: `scripts/golden/imagenPrompt.ts`
- Create: `scripts/golden/imagenPrompt.test.ts`

**Interfaces:**
- Consumes: `BottleScene`, `CameraCondition` (from `../../src/lib/golden-set/bottleReference` and `../../src/lib/golden-set/types`).
- Produces: `PROMPT_VERSION: string`, `BLANK_LABEL_COLOR_HEX: string`, `BLANK_LABEL_COLOR_RGB: { r, g, b }`, `buildBackdropPrompt(scene: BottleScene, cameraCondition: CameraCondition): string`. `imagen.ts` (Task 7) and `blankRegionDetector.ts` callers both need `BLANK_LABEL_COLOR_RGB` — this is the single source of truth for that color, so the prompt text and the detector target never drift apart.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/golden/imagenPrompt.test.ts
import { describe, expect, it } from "vitest";
import { BLANK_LABEL_COLOR_HEX, PROMPT_VERSION, buildBackdropPrompt } from "./imagenPrompt";
import type { BottleScene } from "../../src/lib/golden-set/bottleReference";

const SCENE: BottleScene = {
  sceneId: "bar-counter",
  setting: "a rustic dark-wood bar counter",
  lighting: "Warm tungsten backlight, golden-hour glow.",
};

describe("buildBackdropPrompt", () => {
  it("interpolates the scene's setting and lighting", () => {
    const prompt = buildBackdropPrompt(SCENE, "steady");
    expect(prompt).toContain("Place the bottle on a rustic dark-wood bar counter.");
    expect(prompt).toContain("Warm tungsten backlight, golden-hour glow.");
  });

  it("includes the fixed blank-label compositing instruction and its exact color", () => {
    const prompt = buildBackdropPrompt(SCENE, "steady");
    expect(prompt).toContain(BLANK_LABEL_COLOR_HEX);
    expect(prompt).toContain("Do not generate any text, logos, illustrations, typography, seals");
    expect(prompt).toContain("suitable for later digital compositing");
  });

  it("gives each camera condition a distinct clause", () => {
    const steady = buildBackdropPrompt(SCENE, "steady");
    const motionBlur = buildBackdropPrompt(SCENE, "motion-blur");
    const cameraShake = buildBackdropPrompt(SCENE, "camera-shake");
    expect(steady).not.toEqual(motionBlur);
    expect(motionBlur).not.toEqual(cameraShake);
    expect(steady).toContain("Tripod-steady, 1/125s shutter speed");
    expect(motionBlur).toContain("1/15s");
    expect(cameraShake).toContain("camera shake");
  });

  it("never leaves an interpolation placeholder unresolved", () => {
    const prompt = buildBackdropPrompt(SCENE, "camera-shake");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toMatch(/\{.*\}/);
  });

  it("exposes a stable prompt version for generationMetadata", () => {
    expect(PROMPT_VERSION).toBe("v1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- scripts/golden/imagenPrompt.test.ts`
Expected: FAIL — `./imagenPrompt` module does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// scripts/golden/imagenPrompt.ts
/**
 * Prompt compiler for the realistic-corpus track (design doc §3,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md). The
 * single place that turns a bottle reference's data (scene, camera
 * condition) into the narrative prose Gemini actually reads. A bottle
 * JSON never carries its own prompt phrasing — this file is the only
 * place that changes what gets sent (§3's "keep the compiler boring"
 * guardrail): no LLM-generated prompt layer, no dynamic rewriting, no
 * per-bottle customization.
 */
import type { CameraCondition } from "../../src/lib/golden-set/types";
import type { BottleScene } from "../../src/lib/golden-set/bottleReference";

/**
 * Bumped whenever this file's prompt text changes. Stamped into a
 * generated case's `generationMetadata.promptVersion` (design doc §6) —
 * forensic record-keeping, not a reproducibility claim (generation is not
 * deterministic regardless of prompt version).
 */
export const PROMPT_VERSION = "v1";

/**
 * The one color the prompt asks Gemini to paint the blank label area.
 * `blankRegionDetector.ts` (Task 4) scans generated photos for this exact
 * color — defined once, here, so the prompt text and the detector's target
 * can never drift apart.
 */
export const BLANK_LABEL_COLOR_RGB = { r: 240, g: 233, b: 220 } as const;
export const BLANK_LABEL_COLOR_HEX = "#F0E9DC";

const CAMERA_CONDITION_CLAUSES: Record<CameraCondition, string> = {
  steady: "Tripod-steady, 1/125s shutter speed, tack-sharp image with minimal motion blur.",
  "motion-blur":
    "Handheld at approximately 1/15s, with gentle directional motion blur while the bottle silhouette and label area remain clearly recognizable.",
  "camera-shake":
    "Handheld low-light phone photograph with visible multi-directional camera shake and imperfect sharpness, while the bottle remains recognizable.",
};

/**
 * Builds the full Gemini prompt for one `(scene, cameraCondition)`
 * combination. The reference photo (passed separately as an image input,
 * not here) carries the bottle's identity — this text only ever describes
 * environment, camera artifact, and the compositing requirement (design
 * doc §3's explicit hierarchy).
 */
export function buildBackdropPrompt(scene: BottleScene, cameraCondition: CameraCondition): string {
  return `Create a photorealistic photograph of the bottle shown in the provided reference image. Preserve the bottle's silhouette, proportions, glass color, closure, and overall geometry. Place the bottle on ${scene.setting}. ${scene.lighting} ${CAMERA_CONDITION_CLAUSES[cameraCondition]}

Keep the bottle's label area in its existing position and perspective, but make the label surface completely blank and uniform matte cream (${BLANK_LABEL_COLOR_HEX}). Do not generate any text, logos, illustrations, typography, seals, or other graphics. The blank label must remain suitable for later digital compositing.

Realistic materials, reflections, shadows, depth of field, and physically plausible lighting.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- scripts/golden/imagenPrompt.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/golden/imagenPrompt.ts scripts/golden/imagenPrompt.test.ts
git commit -m "feat(golden-set): add Gemini backdrop prompt compiler"
```

---

## Task 4: Blank-region detector

**Files:**
- Create: `scripts/golden/blankRegionDetector.ts`
- Create: `scripts/golden/blankRegionDetector.test.ts`

**Interfaces:**
- Produces: `Point { x, y }`, `Quad { topLeft, topRight, bottomLeft, bottomRight }` (just the 4 corners — this is the shape `src/lib/golden-set/types.ts`'s `LabelPlacementQuad` (Task 1) structurally matches, so a manifest case's recorded placement and a freshly detected one are interchangeable wherever only the corners matter), `DetectedQuad extends Quad` (adds `pixelCount`, `imageWidth`, `imageHeight`), `detectBlankRegionQuad(image: Buffer, targetColor: { r, g, b }, tolerance: number): Promise<DetectedQuad | null>`. `compositeBackdrop.ts` (Task 5) consumes `Quad`; `imagen.ts` (Task 7) consumes `DetectedQuad`.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/golden/blankRegionDetector.test.ts
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { detectBlankRegionQuad } from "./blankRegionDetector";

const TARGET_COLOR = { r: 240, g: 233, b: 220 };
const BACKGROUND_COLOR = { r: 40, g: 60, b: 90 };

async function makeFixture(
  rectX: number,
  rectY: number,
  rectW: number,
  rectH: number,
  imgW = 800,
  imgH = 600,
): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}">
    <rect width="${imgW}" height="${imgH}" fill="rgb(${BACKGROUND_COLOR.r},${BACKGROUND_COLOR.g},${BACKGROUND_COLOR.b})" />
    ${rectW > 0 && rectH > 0 ? `<rect x="${rectX}" y="${rectY}" width="${rectW}" height="${rectH}" fill="rgb(${TARGET_COLOR.r},${TARGET_COLOR.g},${TARGET_COLOR.b})" />` : ""}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("detectBlankRegionQuad", () => {
  it("finds the corners of a known axis-aligned rectangle", async () => {
    const fixture = await makeFixture(200, 150, 400, 300);
    const quad = await detectBlankRegionQuad(fixture, TARGET_COLOR, 10);
    expect(quad).not.toBeNull();
    const q = quad!;
    const TOLERANCE_PX = 15; // absorbs downsample/rescale rounding
    expect(Math.abs(q.topLeft.x - 200)).toBeLessThanOrEqual(TOLERANCE_PX);
    expect(Math.abs(q.topLeft.y - 150)).toBeLessThanOrEqual(TOLERANCE_PX);
    expect(Math.abs(q.bottomRight.x - 600)).toBeLessThanOrEqual(TOLERANCE_PX);
    expect(Math.abs(q.bottomRight.y - 450)).toBeLessThanOrEqual(TOLERANCE_PX);
  });

  it("returns null when no pixel matches the target color", async () => {
    const fixture = await makeFixture(0, 0, 0, 0);
    const quad = await detectBlankRegionQuad(fixture, TARGET_COLOR, 10);
    expect(quad).toBeNull();
  });

  it("returns null when the matching region is too small to be the label", async () => {
    const fixture = await makeFixture(400, 300, 4, 4);
    const quad = await detectBlankRegionQuad(fixture, TARGET_COLOR, 10);
    expect(quad).toBeNull();
  });

  it("ignores a small unrelated patch of a similar color and still finds the large region", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
      <rect width="800" height="600" fill="rgb(${BACKGROUND_COLOR.r},${BACKGROUND_COLOR.g},${BACKGROUND_COLOR.b})" />
      <rect x="10" y="10" width="6" height="6" fill="rgb(${TARGET_COLOR.r},${TARGET_COLOR.g},${TARGET_COLOR.b})" />
      <rect x="200" y="150" width="400" height="300" fill="rgb(${TARGET_COLOR.r},${TARGET_COLOR.g},${TARGET_COLOR.b})" />
    </svg>`;
    const fixture = await sharp(Buffer.from(svg)).png().toBuffer();
    const quad = await detectBlankRegionQuad(fixture, TARGET_COLOR, 10);
    expect(quad).not.toBeNull();
    expect(Math.abs(quad!.topLeft.x - 200)).toBeLessThanOrEqual(15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- scripts/golden/blankRegionDetector.test.ts`
Expected: FAIL — `./blankRegionDetector` module does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// scripts/golden/blankRegionDetector.ts
/**
 * Finds the blank label region in a Gemini-generated backdrop photo
 * (design doc §5,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md).
 * `imagenPrompt.ts` asks Gemini to paint that region one known, distinct
 * color; this file scans the generated photo for the largest connected
 * region near that color and returns its 4 extreme corners — the same
 * "min/max of x+y and x-y" technique document-scanner apps use to find a
 * page's corners inside a photo. `compositeBackdrop.ts` warps the
 * renderer's label into the returned quad.
 */
import sharp from "sharp";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Just the 4 corners of a label placement — the shape `compositeBackdrop.ts`
 * actually needs. `src/lib/golden-set/types.ts`'s `LabelPlacementQuad`
 * (Task 1) matches this shape field-for-field but is declared separately
 * (a manifest case shouldn't import from `scripts/golden/`) — TypeScript's
 * structural typing makes the two interchangeable wherever only the
 * corners matter, which is everywhere except this file's own detection
 * bookkeeping (`pixelCount`, `imageWidth`, `imageHeight` below).
 */
export interface Quad {
  readonly topLeft: Point;
  readonly topRight: Point;
  readonly bottomLeft: Point;
  readonly bottomRight: Point;
}

export interface DetectedQuad extends Quad {
  readonly pixelCount: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Downsample width for the flood fill — fast, and corners are rescaled back to full resolution. */
const DETECTION_WIDTH = 240;
/** A matched region smaller than this fraction of the frame is noise (a cap glint, a highlight), not the label. */
const MIN_REGION_FRACTION = 0.02;

function colorDistance(a: RgbColor, b: RgbColor): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

export async function detectBlankRegionQuad(
  image: Buffer,
  targetColor: RgbColor,
  tolerance: number,
): Promise<DetectedQuad | null> {
  const originalMeta = await sharp(image).metadata();
  const originalWidth = originalMeta.width;
  const originalHeight = originalMeta.height;
  if (!originalWidth || !originalHeight) {
    throw new RangeError("blankRegionDetector: could not read image dimensions");
  }

  const scale = DETECTION_WIDTH / originalWidth;
  const detectionHeight = Math.max(1, Math.round(originalHeight * scale));
  const { data, info } = await sharp(image)
    .resize(DETECTION_WIDTH, detectionHeight, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const isMatch = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const offset = i * channels;
    const pixel: RgbColor = { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
    isMatch[i] = colorDistance(pixel, targetColor) <= tolerance ? 1 : 0;
  }

  // Iterative flood fill (explicit stack, not recursion) over 4-connected
  // matching pixels, keeping only the largest component found.
  const visited = new Uint8Array(width * height);
  let bestComponent: number[] = [];

  for (let start = 0; start < width * height; start++) {
    if (!isMatch[start] || visited[start]) continue;

    const component: number[] = [];
    const stack = [start];
    visited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      component.push(idx);
      const x = idx % width;
      const y = Math.floor(idx / width);
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && isMatch[n] && !visited[n]) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    if (component.length > bestComponent.length) {
      bestComponent = component;
    }
  }

  if (bestComponent.length < width * height * MIN_REGION_FRACTION) {
    return null;
  }

  let topLeft = { x: 0, y: 0, score: Infinity };
  let bottomRight = { x: 0, y: 0, score: -Infinity };
  let topRight = { x: 0, y: 0, score: -Infinity };
  let bottomLeft = { x: 0, y: 0, score: Infinity };

  for (const idx of bestComponent) {
    const x = idx % width;
    const y = Math.floor(idx / width);
    const sum = x + y;
    const diff = x - y;
    if (sum < topLeft.score) topLeft = { x, y, score: sum };
    if (sum > bottomRight.score) bottomRight = { x, y, score: sum };
    if (diff > topRight.score) topRight = { x, y, score: diff };
    if (diff < bottomLeft.score) bottomLeft = { x, y, score: diff };
  }

  const rescale = 1 / scale;
  const toOriginal = (p: { x: number; y: number }): Point => ({
    x: Math.round(p.x * rescale),
    y: Math.round(p.y * rescale),
  });

  return {
    topLeft: toOriginal(topLeft),
    topRight: toOriginal(topRight),
    bottomLeft: toOriginal(bottomLeft),
    bottomRight: toOriginal(bottomRight),
    pixelCount: bestComponent.length,
    imageWidth: originalWidth,
    imageHeight: originalHeight,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- scripts/golden/blankRegionDetector.test.ts`
Expected: PASS, all 4 tests. If the corner-tolerance assertions fail by a small margin, widen `TOLERANCE_PX` in the test rather than the detector — the downsample/rescale rounding error scales with `DETECTION_WIDTH`, and 15px at 800px-wide input is already a deliberate margin, not a tight bound.

- [ ] **Step 5: Commit**

```bash
git add scripts/golden/blankRegionDetector.ts scripts/golden/blankRegionDetector.test.ts
git commit -m "feat(golden-set): add blank label region detector"
```

---

## Task 5: Backdrop compositor

**Files:**
- Create: `scripts/golden/compositeBackdrop.ts`
- Create: `scripts/golden/compositeBackdrop.test.ts`

**Interfaces:**
- Consumes: `Quad` from `./blankRegionDetector` (Task 4) — deliberately the narrower corners-only type, not `DetectedQuad`, so this function accepts both a freshly detected quad and a manifest case's committed `LabelPlacementQuad` (Task 1) without conversion.
- Produces: `compositeLabelOntoBackdrop(backdropImage: Buffer, labelImage: Buffer, quad: Quad): Promise<Buffer>` (PNG bytes). Consumed by `build.ts` (Task 6), which passes it a `GoldenSetCase.labelPlacement` value directly.

**Note on approach:** this does not use `sharp`'s built-in `.affine()`. `.affine()` auto-expands its output canvas to fit the transformed content and does not report back where the original content landed, which makes placing the result at an exact position on the backdrop unreliable without empirically reverse-engineering that behavior. Instead this does direct inverse-mapped pixel sampling — for every destination pixel inside the quad's bounding box, compute where it came from in the label image and copy that pixel. This is the same rasterization technique image-warping libraries use internally, self-contained, and has no dependency on `sharp` affine-offset conventions this plan cannot verify without running it.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/golden/compositeBackdrop.test.ts
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compositeLabelOntoBackdrop } from "./compositeBackdrop";
import type { DetectedQuad } from "./blankRegionDetector";

const BACKDROP_COLOR = { r: 10, g: 10, b: 10 };

async function makeBackdrop(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: BACKDROP_COLOR } })
    .png()
    .toBuffer();
}

async function makeTwoToneLabel(width: number, height: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect x="0" y="0" width="${width}" height="${height / 2}" fill="rgb(200,0,0)" />
    <rect x="0" y="${height / 2}" width="${width}" height="${height / 2}" fill="rgb(0,0,200)" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function pixelAt(image: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
}

describe("compositeLabelOntoBackdrop", () => {
  it("places the label's top half at the quad's top and bottom half at the quad's bottom, axis-aligned", async () => {
    const backdrop = await makeBackdrop(800, 600);
    const label = await makeTwoToneLabel(200, 100);
    const quad: DetectedQuad = {
      topLeft: { x: 300, y: 200 },
      topRight: { x: 500, y: 200 },
      bottomLeft: { x: 300, y: 300 },
      bottomRight: { x: 500, y: 300 },
      pixelCount: 20000,
      imageWidth: 800,
      imageHeight: 600,
    };

    const result = await compositeLabelOntoBackdrop(backdrop, label, quad);

    const topOfQuad = await pixelAt(result, 400, 220);
    expect(topOfQuad.r).toBeGreaterThan(150);
    expect(topOfQuad.b).toBeLessThan(50);

    const bottomOfQuad = await pixelAt(result, 400, 280);
    expect(bottomOfQuad.b).toBeGreaterThan(150);
    expect(bottomOfQuad.r).toBeLessThan(50);

    const outsideQuad = await pixelAt(result, 50, 50);
    expect(outsideQuad.r).toBe(BACKDROP_COLOR.r);
    expect(outsideQuad.g).toBe(BACKDROP_COLOR.g);
    expect(outsideQuad.b).toBe(BACKDROP_COLOR.b);
  });

  it("throws on a degenerate (zero-area) quad", async () => {
    const backdrop = await makeBackdrop(400, 300);
    const label = await makeTwoToneLabel(100, 100);
    const quad: DetectedQuad = {
      topLeft: { x: 100, y: 100 },
      topRight: { x: 100, y: 100 },
      bottomLeft: { x: 100, y: 100 },
      bottomRight: { x: 100, y: 100 },
      pixelCount: 0,
      imageWidth: 400,
      imageHeight: 300,
    };
    await expect(compositeLabelOntoBackdrop(backdrop, label, quad)).rejects.toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- scripts/golden/compositeBackdrop.test.ts`
Expected: FAIL — `./compositeBackdrop` module does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// scripts/golden/compositeBackdrop.ts
/**
 * Warps the renderer's exact-text label into a backdrop photo's detected
 * blank region and composites it there (design doc §5,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md).
 * `build.ts` calls this on every rebuild, using a case's committed
 * `labelPlacement` quad — no network, no re-detection, matching the
 * existing `rendered`/`rendered+degraded` determinism contract even though
 * the backdrop photo itself was generated once and is not reproducible.
 */
import sharp from "sharp";
import type { Quad } from "./blankRegionDetector";

interface Matrix2x2 {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

/**
 * Solves the 2x2 linear map that carries a label image's (0,0)/(W,0)/(0,H)
 * corners onto `quad`'s topLeft/topRight/bottomLeft corners (relative to
 * topLeft, the map's implicit origin). 3 point correspondences exactly
 * determine an affine transform's remaining 4 degrees of freedom — no
 * least-squares fit needed. `quad.bottomRight` is unused: this repo has no
 * true 4-point projective (homography) warp dependency, the same
 * limitation `degrade.ts`'s `applyPerspective` already documents for its
 * own shear approximation. When the detected quad is a true trapezoid
 * (real camera perspective foreshortening) rather than a parallelogram,
 * this warp will not exactly reach the detected bottomRight corner — an
 * accepted approximation (design doc §11, "not a true ... projection").
 */
function solveLinearMap(labelWidth: number, labelHeight: number, quad: Quad): Matrix2x2 {
  const { topLeft, topRight, bottomLeft } = quad;
  return {
    a: (topRight.x - topLeft.x) / labelWidth,
    c: (topRight.y - topLeft.y) / labelWidth,
    b: (bottomLeft.x - topLeft.x) / labelHeight,
    d: (bottomLeft.y - topLeft.y) / labelHeight,
  };
}

function invert(m: Matrix2x2): Matrix2x2 {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-9) {
    throw new RangeError("compositeLabelOntoBackdrop: detected quad is degenerate (zero area)");
  }
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det };
}

/**
 * Perspective-warps `labelImage` into `quad`'s position on `backdropImage`
 * by direct inverse-mapped pixel sampling: for every destination pixel in
 * the quad's bounding box, compute where it came from in the label image
 * (via the inverse linear map) and copy that pixel — nearest-neighbor, no
 * interpolation. This avoids `sharp`'s `.affine()`, which auto-expands its
 * output canvas and reports no offset back to the caller, making exact
 * placement on the backdrop unreliable to reason about without empirical
 * testing this plan cannot do ahead of running it.
 */
export async function compositeLabelOntoBackdrop(
  backdropImage: Buffer,
  labelImage: Buffer,
  quad: Quad,
): Promise<Buffer> {
  const labelRaw = await sharp(labelImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const backdropRaw = await sharp(backdropImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const labelWidth = labelRaw.info.width;
  const labelHeight = labelRaw.info.height;
  const bgWidth = backdropRaw.info.width;
  const bgHeight = backdropRaw.info.height;
  const channels = backdropRaw.info.channels;

  const linear = solveLinearMap(labelWidth, labelHeight, quad);
  const inverse = invert(linear);

  const xs = [quad.topLeft.x, quad.topRight.x, quad.bottomLeft.x, quad.bottomRight.x];
  const ys = [quad.topLeft.y, quad.topRight.y, quad.bottomLeft.y, quad.bottomRight.y];
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(bgWidth - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(bgHeight - 1, Math.ceil(Math.max(...ys)));

  const output = Buffer.from(backdropRaw.data);

  for (let dy = minY; dy <= maxY; dy++) {
    for (let dx = minX; dx <= maxX; dx++) {
      const rx = dx - quad.topLeft.x;
      const ry = dy - quad.topLeft.y;
      const sx = Math.round(inverse.a * rx + inverse.b * ry);
      const sy = Math.round(inverse.c * rx + inverse.d * ry);
      if (sx < 0 || sx >= labelWidth || sy < 0 || sy >= labelHeight) continue;

      const srcOffset = (sy * labelWidth + sx) * labelRaw.info.channels;
      const dstOffset = (dy * bgWidth + dx) * channels;
      output[dstOffset] = labelRaw.data[srcOffset];
      output[dstOffset + 1] = labelRaw.data[srcOffset + 1];
      output[dstOffset + 2] = labelRaw.data[srcOffset + 2];
      output[dstOffset + 3] = 255;
    }
  }

  return sharp(output, { raw: { width: bgWidth, height: bgHeight, channels } })
    .png()
    .toBuffer();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- scripts/golden/compositeBackdrop.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/golden/compositeBackdrop.ts scripts/golden/compositeBackdrop.test.ts
git commit -m "feat(golden-set): add label-to-backdrop compositor"
```

---

## Task 6: Extend `build.ts` for `rendered+ai-backdrop` cases

**Files:**
- Modify: `scripts/golden/build.ts`
- Create: `scripts/golden/build.test.ts`

**Interfaces:**
- Consumes: `compositeLabelOntoBackdrop` (Task 5), `GoldenSetCase.labelPlacement` (Task 1).
- Produces: `buildAiBackdropCase(caseSpec, renderer, backdropsDir?): Promise<Buffer>` (new, exported for direct testing). `buildCase` gains an optional third `backdropsDir` parameter but stays module-private, same as today — its dispatch logic is a 2-line branch, tested indirectly through `buildAiBackdropCase`, not worth its own disk-writing integration test (see Step 1's note on why this plan doesn't add one).

- [ ] **Step 1: Write the failing tests**

Note on scope: this only tests `buildAiBackdropCase` directly, not a full `buildCase` disk-write.
`buildCase`'s final JPEG-encode-and-write path (`resolveImagePath`, `IMAGES_DIR`) already existed
before this task, is not parameterized, and always resolves against the real
`golden-set/images/` directory (`caseSpec.imagePath` is repo-root-relative by the schema's own
rule). Testing that path end-to-end would mean writing a throwaway file into the real repo
directory during `pnpm test` — not worth it for a 2-line dispatch branch. `buildAiBackdropCase`
covers everything genuinely new.

```typescript
// scripts/golden/build.test.ts
/**
 * Tests for build.ts's rendered+ai-backdrop branch (Task 6,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md).
 * The render-and-degrade path (rendered/rendered+degraded) is exercised
 * end-to-end by `pnpm golden:build` itself and by render.test.ts /
 * degrade.test.ts; this file covers only what's new here.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import { buildAiBackdropCase } from "./build";
import { createLabelRenderer, type LabelRenderer } from "./render";

function aiBackdropCase(overrides: Partial<GoldenSetCase> = {}): GoldenSetCase {
  return {
    caseId: "case-ai-backdrop-test",
    description: "Test fixture for the rendered+ai-backdrop build path.",
    category: "clean-match",
    beverageType: "spirits",
    imagePath: "golden-set/images/case-ai-backdrop-test.jpg",
    provenance: "rendered+ai-backdrop",
    verified: true,
    vectors: [],
    referenceBottle: "amber-whiskey-01",
    scene: "bar-counter",
    cameraCondition: "steady",
    application: {
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      abvPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    },
    label: {
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      abvPresent: true,
      abvText: "45% Alc./Vol. (90 Proof)",
      abvPercent: 45,
      proof: 90,
      netContentsText: "750 mL",
      netContentsValue: 750,
      netContentsUnit: "mL",
      governmentWarningPresent: true,
      governmentWarningText: "GOVERNMENT WARNING: test text.",
      governmentWarningPrefixAllCaps: true,
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

describe("buildAiBackdropCase", () => {
  it("throws a clear error when labelPlacement is missing", async () => {
    const caseSpec = aiBackdropCase({ labelPlacement: undefined });
    // The error must fire before any render call, so a dummy renderer
    // (never dereferenced) is safe to pass here.
    const dummyRenderer = { page: undefined, close: async () => {} } as unknown as LabelRenderer;
    await expect(buildAiBackdropCase(caseSpec, dummyRenderer, "/nonexistent")).rejects.toThrow(
      /labelPlacement/,
    );
  });

  it("composites the rendered label onto the committed backdrop", async () => {
    const backdropsDir = mkdtempSync(path.join(tmpdir(), "build-test-backdrops-"));
    const backdrop = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .png()
      .toBuffer();
    writeFileSync(path.join(backdropsDir, "case-ai-backdrop-test.png"), backdrop);

    const caseSpec = aiBackdropCase({
      labelPlacement: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 1000, y: 0 },
        bottomLeft: { x: 0, y: 800 },
        bottomRight: { x: 1000, y: 800 },
      },
    });

    const renderer = await createLabelRenderer();
    try {
      const image = await buildAiBackdropCase(caseSpec, renderer, backdropsDir);
      const meta = await sharp(image).metadata();
      expect(meta.width).toBe(1000);
      expect(meta.height).toBe(800);
    } finally {
      await renderer.close();
      rmSync(backdropsDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- scripts/golden/build.test.ts`
Expected: FAIL — `buildAiBackdropCase` does not exist yet.

- [ ] **Step 3: Modify `build.ts`**

Change the imports at the top to add `readFileSync` and the new compositor:

```typescript
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
```

and add:

```typescript
import { compositeLabelOntoBackdrop } from "./compositeBackdrop";
```

Add a constant next to `IMAGES_DIR`:

```typescript
const BACKDROPS_DIR = resolve(REPO_ROOT, "golden-set/backdrops");
```

Replace the existing `buildCase` function with:

```typescript
/** The original render-and-degrade path, unchanged — pulled into its own function only so `buildCase` can dispatch on provenance. */
async function buildRenderedCase(caseSpec: GoldenSetCase, renderer: LabelRenderer): Promise<Buffer> {
  let image = await renderLabelImage(caseSpec, renderer.page);
  for (const degradation of caseSpec.degradations ?? []) {
    image = await applyDegradation(image, degradation);
  }
  return image;
}

/**
 * Builds a `rendered+ai-backdrop` case: renders the label (same exact-text
 * guarantee as every other case), loads the case's committed backdrop
 * photo, and warps the label into the case's recorded `labelPlacement`
 * (design doc §5/§6). No network call — the backdrop was already
 * generated and committed by a prior, separate `pnpm golden:imagen` run;
 * this only re-runs the deterministic parts, matching `rendered+degraded`
 * cases' own determinism contract.
 */
export async function buildAiBackdropCase(
  caseSpec: GoldenSetCase,
  renderer: LabelRenderer,
  backdropsDir: string = BACKDROPS_DIR,
): Promise<Buffer> {
  if (!caseSpec.labelPlacement) {
    throw new RangeError(
      `build: case "${caseSpec.caseId}" has provenance "rendered+ai-backdrop" but no labelPlacement — ` +
        `run pnpm golden:imagen and fold its .meta.json output into the manifest entry first`,
    );
  }
  const labelImage = await renderLabelImage(caseSpec, renderer.page);
  const backdropPath = resolve(backdropsDir, `${caseSpec.caseId}.png`);
  const backdropImage = readFileSync(backdropPath);
  return compositeLabelOntoBackdrop(backdropImage, labelImage, caseSpec.labelPlacement);
}

async function buildCase(
  caseSpec: GoldenSetCase,
  renderer: LabelRenderer,
  backdropsDir: string = BACKDROPS_DIR,
): Promise<BuildResult> {
  const image =
    caseSpec.provenance === "rendered+ai-backdrop"
      ? await buildAiBackdropCase(caseSpec, renderer, backdropsDir)
      : await buildRenderedCase(caseSpec, renderer);

  // Flattens any alpha onto white before the JPEG encode, matching
  // pipeline.ts's own reasoning for its `.flatten()` calls. sharp's JPEG
  // encoder composites alpha over black by default. Today every source
  // pixel is already opaque (render.ts paints an opaque white body;
  // applyRotate/applyPerspective fill new corners with white), so this is a
  // no-op — defense in depth against a future transform that introduces a
  // transparent pixel, not a response to a bug in the current pipeline.
  const jpeg = await sharp(image)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  const outPath = resolveImagePath(caseSpec.imagePath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, jpeg);

  return { caseId: caseSpec.caseId, bytes: jpeg.length, path: outPath };
}
```

(This replaces the old `buildCase` function body in place — same function name and same module-private visibility as before, now dispatching on provenance via the new `buildRenderedCase`/`buildAiBackdropCase` helpers. `buildAiBackdropCase` alone is exported, for Task 6's tests. `main()` is unchanged: it already calls `buildCase(caseSpec, renderer)`, which still works with the new optional third parameter defaulting to `BACKDROPS_DIR`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- scripts/golden/build.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Typecheck and run the full existing golden-set test suite to confirm no regression**

Run: `pnpm typecheck && pnpm test -- scripts/golden src/lib/golden-set`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/golden/build.ts scripts/golden/build.test.ts
git commit -m "feat(golden-set): composite rendered+ai-backdrop cases in build.ts"
```

---

## Task 7: Gemini generation script

**Files:**
- Create: `scripts/golden/imagen.ts`
- Create: `scripts/golden/imagen.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `loadBottleReference`, `BottleReference`, `BottleScene` (Task 2); `buildBackdropPrompt`, `PROMPT_VERSION`, `BLANK_LABEL_COLOR_RGB` (Task 3); `detectBlankRegionQuad` (Task 4).
- Produces: `GenerationTarget`, `enumerateTargets(referencesDir?: string): GenerationTarget[]`, `targetCaseId(target: GenerationTarget): string`, `ImageGenerator = (prompt: string, referencePhotoPath: string) => Promise<Buffer>`, `generateOne(target, generate: ImageGenerator, outDir?: string): Promise<GenerationResult>`, `main(): Promise<void>` (CLI entry point, not unit tested — see the "verify before wiring" note directly below).

**Important — verify before wiring the real API call:** this task's `generateWithGemini` function is written from `@google/genai` documentation research, not a live-tested call (this plan was written without network access to run it). Before trusting it, check the installed package's own type definitions (`node_modules/@google/genai/dist/**/*.d.ts`, or run `pnpm exec tsc --noEmit` and read any type errors on this file) for the exact method name and request/response shape for image generation — SDK surfaces change across versions. The pure orchestration logic (`enumerateTargets`, `targetCaseId`, `generateOne`) does not depend on this and is fully unit-tested with a fake `ImageGenerator`.

- [ ] **Step 1: Add the dependency**

Run: `pnpm add @google/genai`

- [ ] **Step 2: Write the failing tests**

```typescript
// scripts/golden/imagen.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { enumerateTargets, generateOne, targetCaseId, type ImageGenerator } from "./imagen";

function makeTempReferencesDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "imagen-test-refs-"));
  writeFileSync(
    path.join(dir, "amber-whiskey-01.json"),
    JSON.stringify({
      bottleId: "amber-whiskey-01",
      referencePhoto: "assets/golden/references/amber-whiskey-01.jpg",
      beverageType: "spirits",
      bottleDescription: "tall amber glass whiskey bottle",
      scenes: [{ sceneId: "bar-counter", setting: "a bar counter", lighting: "warm light" }],
      cameraConditions: ["steady", "motion-blur"],
    }),
  );
  return dir;
}

describe("enumerateTargets", () => {
  it("produces the cartesian product of scenes x cameraConditions per bottle", () => {
    const dir = makeTempReferencesDir();
    try {
      const targets = enumerateTargets(dir);
      expect(targets).toHaveLength(2);
      expect(targets.map((t) => t.cameraCondition).sort()).toEqual(["motion-blur", "steady"]);
      expect(targets.every((t) => t.bottleId === "amber-whiskey-01")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for an empty references directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "imagen-test-empty-"));
    try {
      expect(enumerateTargets(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("targetCaseId", () => {
  it("builds a stable, readable case ID from bottle/scene/condition", () => {
    const id = targetCaseId({
      bottleId: "amber-whiskey-01",
      referencePhotoPath: "/x.jpg",
      scene: { sceneId: "bar-counter", setting: "x", lighting: "y" },
      cameraCondition: "motion-blur",
    });
    expect(id).toBe("case-ai-backdrop-amber-whiskey-01-bar-counter-motion-blur");
  });
});

const STEADY_TARGET = {
  bottleId: "amber-whiskey-01",
  referencePhotoPath: "/fake.jpg",
  scene: { sceneId: "bar-counter", setting: "a bar counter", lighting: "warm light" },
  cameraCondition: "steady" as const,
};

async function fakeGeneratorWithBlankRegion(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
    <rect width="400" height="300" fill="rgb(20,20,20)" />
    <rect x="100" y="100" width="150" height="80" fill="rgb(240,233,220)" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function fakeGeneratorWithNoBlankRegion(): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .png()
    .toBuffer();
}

describe("generateOne", () => {
  it("writes a backdrop PNG and a meta.json sidecar with detected placement", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-out-"));
    const generate: ImageGenerator = fakeGeneratorWithBlankRegion;
    try {
      const result = await generateOne(STEADY_TARGET, generate, outDir);

      expect(result.caseId).toBe("case-ai-backdrop-amber-whiskey-01-bar-counter-steady");
      expect(result.detectedQuad).not.toBeNull();

      expect(readFileSync(result.backdropPath).length).toBeGreaterThan(0);

      const meta = JSON.parse(readFileSync(result.metaPath, "utf8"));
      expect(meta.referenceBottle).toBe("amber-whiskey-01");
      expect(meta.scene).toBe("bar-counter");
      expect(meta.cameraCondition).toBe("steady");
      expect(meta.generationMetadata.promptVersion).toBe("v1");
      expect(meta.labelPlacement).not.toBeNull();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("reports a null quad when the generated image has no detectable blank region", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-out-"));
    try {
      const result = await generateOne(STEADY_TARGET, fakeGeneratorWithNoBlankRegion, outDir);
      expect(result.detectedQuad).toBeNull();
      const meta = JSON.parse(readFileSync(result.metaPath, "utf8"));
      expect(meta.labelPlacement).toBeNull();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- scripts/golden/imagen.test.ts`
Expected: FAIL — `./imagen` module does not exist yet.

- [ ] **Step 4: Write the implementation**

```typescript
// scripts/golden/imagen.ts
/**
 * Generates realistic-corpus backdrop photos via Gemini 3.1 Flash Image
 * (design doc §4/§5,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md).
 * For every `(bottle reference, scene, cameraCondition)` combination,
 * builds a prompt (imagenPrompt.ts), calls Gemini with the bottle's real
 * photo as a reference image, detects the blank label region
 * (blankRegionDetector.ts), and writes a raw backdrop PNG plus a
 * `.meta.json` sidecar to golden-set/backdrops/. Never touches
 * golden-set/manifest.json directly — a human folds a sidecar's content
 * into a rendered+ai-backdrop case entry, the same human-in-the-loop step
 * ai-generated cases already use (golden-set/README.md). Network, costs
 * money — run manually with `pnpm golden:imagen`, never from CI (design
 * doc §8's "CI never calls an image API").
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { loadBottleReference, type BottleScene } from "../../src/lib/golden-set/bottleReference";
import type { CameraCondition } from "../../src/lib/golden-set/types";
import { BLANK_LABEL_COLOR_RGB, PROMPT_VERSION, buildBackdropPrompt } from "./imagenPrompt";
import { detectBlankRegionQuad, type DetectedQuad } from "./blankRegionDetector";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REFERENCES_DIR = path.resolve(REPO_ROOT, "assets/golden/references");
const BACKDROPS_DIR = path.resolve(REPO_ROOT, "golden-set/backdrops");

const MODEL = "gemini-3.1-flash-image";
const RESOLUTION = "1K";
const DETECTION_TOLERANCE = 20;

/**
 * Standard-tier cost per image at 1K resolution, confirmed against
 * ai.google.dev/gemini-api/docs/pricing on 2026-08-11 (design doc §9).
 * An estimate for the running-total log only — prices change; verify
 * against the live billing console before trusting this for a real
 * invoice.
 */
const ESTIMATED_COST_PER_IMAGE_USD = 0.067;

export interface GenerationTarget {
  readonly bottleId: string;
  readonly referencePhotoPath: string;
  readonly scene: BottleScene;
  readonly cameraCondition: CameraCondition;
}

/** Every `(scene, cameraCondition)` combination across every bottle reference JSON in `referencesDir`. */
export function enumerateTargets(referencesDir: string = REFERENCES_DIR): GenerationTarget[] {
  let files: string[];
  try {
    files = readdirSync(referencesDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const targets: GenerationTarget[] = [];
  for (const file of files) {
    const bottle = loadBottleReference(path.join(referencesDir, file));
    for (const scene of bottle.scenes) {
      for (const cameraCondition of bottle.cameraConditions) {
        targets.push({
          bottleId: bottle.bottleId,
          referencePhotoPath: path.resolve(REPO_ROOT, bottle.referencePhoto),
          scene,
          cameraCondition,
        });
      }
    }
  }
  return targets;
}

export function targetCaseId(target: GenerationTarget): string {
  return `case-ai-backdrop-${target.bottleId}-${target.scene.sceneId}-${target.cameraCondition}`;
}

/** Injected so `generateOne`'s orchestration is testable without a real network call. */
export type ImageGenerator = (prompt: string, referencePhotoPath: string) => Promise<Buffer>;

/**
 * Builds a real `ImageGenerator` backed by the Gemini API. See this file's
 * module comment and this task's "verify before wiring" note: the exact
 * `@google/genai` call shape below is best-effort from documentation
 * research, not a live-tested call — confirm the method name and
 * request/response shape against the installed SDK's own types before
 * trusting it for a real run.
 */
export async function generateWithGemini(apiKey: string): Promise<ImageGenerator> {
  const client = new GoogleGenAI({ apiKey });
  return async (prompt: string, referencePhotoPath: string): Promise<Buffer> => {
    const referenceBytes = readFileSync(referencePhotoPath);
    const response = await client.models.generateContent({
      model: MODEL,
      contents: [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: referenceBytes.toString("base64") } },
      ],
      config: { responseModalities: ["IMAGE"] },
    });
    const imagePart = response.candidates?.[0]?.content?.parts?.find(
      (p: { inlineData?: { data?: string } }) => p.inlineData?.data,
    );
    if (!imagePart?.inlineData?.data) {
      throw new Error(`imagen: no image returned for prompt: ${prompt.slice(0, 80)}...`);
    }
    return Buffer.from(imagePart.inlineData.data, "base64");
  };
}

export interface GenerationResult {
  readonly caseId: string;
  readonly backdropPath: string;
  readonly metaPath: string;
  readonly detectedQuad: DetectedQuad | null;
}

/**
 * Generates and detects one target's backdrop, writing the raw PNG and a
 * `.meta.json` sidecar to `outDir`. Never writes to
 * `golden-set/manifest.json` — see this file's module comment.
 */
export async function generateOne(
  target: GenerationTarget,
  generate: ImageGenerator,
  outDir: string = BACKDROPS_DIR,
): Promise<GenerationResult> {
  const prompt = buildBackdropPrompt(target.scene, target.cameraCondition);
  const image = await generate(prompt, target.referencePhotoPath);
  const quad = await detectBlankRegionQuad(image, BLANK_LABEL_COLOR_RGB, DETECTION_TOLERANCE);

  const caseId = targetCaseId(target);
  mkdirSync(outDir, { recursive: true });
  const backdropPath = path.join(outDir, `${caseId}.png`);
  const metaPath = path.join(outDir, `${caseId}.meta.json`);
  writeFileSync(backdropPath, image);
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        caseId,
        referenceBottle: target.bottleId,
        scene: target.scene.sceneId,
        cameraCondition: target.cameraCondition,
        labelPlacement: quad,
        generationMetadata: {
          model: MODEL,
          resolution: RESOLUTION,
          promptVersion: PROMPT_VERSION,
          generatedAt: new Date().toISOString(),
        },
      },
      null,
      2,
    ),
  );
  return { caseId, backdropPath, metaPath, detectedQuad: quad };
}

export async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("imagen: GOOGLE_API_KEY is not set (see .env.local.example)");
  }
  const targets = enumerateTargets();
  if (targets.length === 0) {
    console.log("imagen: no bottle references found in assets/golden/references/ — nothing to generate.");
    return;
  }

  const generate = await generateWithGemini(apiKey);
  let spentUsd = 0;
  let detectionFailures = 0;

  for (const target of targets) {
    const result = await generateOne(target, generate);
    spentUsd += ESTIMATED_COST_PER_IMAGE_USD;
    if (result.detectedQuad === null) {
      detectionFailures++;
      console.log(`${result.caseId}: DETECTION FAILED — needs manual placement. (est. spend so far: $${spentUsd.toFixed(2)})`);
    } else {
      console.log(`${result.caseId}: OK. (est. spend so far: $${spentUsd.toFixed(2)})`);
    }
  }

  console.log(
    `\nDone. ${targets.length} generated, ${detectionFailures} need manual placement, ~$${spentUsd.toFixed(2)} estimated spend.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- scripts/golden/imagen.test.ts`
Expected: PASS, all 5 tests. These tests never call `generateWithGemini` or touch the network — they pass a fake `ImageGenerator` directly to `generateOne`.

- [ ] **Step 6: Add the `golden:imagen` script to `package.json`**

In the `scripts` block, next to `"golden:build"`:

```json
"golden:imagen": "tsx scripts/golden/imagen.ts",
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If `@google/genai`'s types don't match `generateWithGemini`'s usage, fix the call shape against the installed package's actual types now — this is exactly the "verify before wiring" step this task's intro flagged.

- [ ] **Step 8: Commit**

```bash
git add scripts/golden/imagen.ts scripts/golden/imagen.test.ts package.json pnpm-lock.yaml
git commit -m "feat(golden-set): add Gemini backdrop generation script"
```

---

## Task 8: Directories, docs, and final verification

**Files:**
- Create: `assets/golden/references/.gitkeep`
- Create: `golden-set/backdrops/.gitkeep`
- Modify: `golden-set/README.md`

- [ ] **Step 1: Create the two new directories with placeholders**

```bash
mkdir -p assets/golden/references golden-set/backdrops
touch assets/golden/references/.gitkeep golden-set/backdrops/.gitkeep
```

- [ ] **Step 2: Update `golden-set/README.md`**

Find this exact paragraph (it currently sits right before the "## Manifest format" heading) and
replace it in full:

```markdown
**Still not done:** design doc §5 describes about 5 fully `ai-generated` "wild" labels.
LH-005 owns that work. LH-005 makes the Gemini API call and gets the human `verified: true`
sign-off. No case in this manifest has `provenance: "ai-generated"` yet. When LH-005 adds
one, its image starts out absent — the same way every case here started before this ticket.
LH-005 must land the image and set `verified: true` in the same manifest change. The loader
already rejects a `verified: false` `ai-generated` case at load time. But the loader checks
only the schema shape, not whether the file actually exists. `scripts/golden/images.test.ts`
checks that second part. It starts failing the moment an `ai-generated` case claims
`verified: true` with no matching file.
`scripts/golden/verify.ts` (LH-006: the consistency and coverage CI gate) is also still open.
```

with:

```markdown
**Still not done — `ai-generated` wild labels.** design doc §5 describes about 5 fully
`ai-generated` "wild" labels (text included). No case in this manifest has `provenance:
"ai-generated"` yet. When a future ticket adds one, its image starts out absent — the same way
every case here started before LH-004. That ticket must land the image and set `verified: true`
in the same manifest change. The loader already rejects a `verified: false` `ai-generated` case
at load time, but only checks the schema shape, not whether the file actually exists —
`scripts/golden/images.test.ts` checks that part.

**Still not done — the realistic-corpus track.** A newer design,
`docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md`, supersedes the rest of the
original §5 scope: Gemini generates realistic bottle photographs (steady / motion-blur /
camera-shake) from real reference photos, and the renderer's exact-text label is composited onto
them — no warning-text transcription risk, unlike `ai-generated`. The tooling is built
(`scripts/golden/{imagenPrompt,blankRegionDetector,compositeBackdrop,imagen}.ts`) and tested
against synthetic fixtures, but `assets/golden/references/` is still empty — no case in this
manifest has `provenance: "rendered+ai-backdrop"` yet. To add one once real bottle photos exist:

1. Add a bottle reference JSON + photo under `assets/golden/references/` (schema:
   `src/lib/golden-set/bottleReference.ts`).
2. Run `pnpm golden:imagen` — it writes a backdrop PNG and a `.meta.json` sidecar (detected
   `labelPlacement` + `generationMetadata`) to `golden-set/backdrops/` for every
   `(scene, cameraCondition)` combination. It never edits `manifest.json`.
3. Hand-author the case's manifest entry (ground truth, category, vectors — same as every other
   case), folding in the sidecar's `referenceBottle`/`scene`/`cameraCondition`/`labelPlacement`/
   `generationMetadata`. Set `verified: true` only after confirming the composited label is
   legible and correctly placed (not re-transcribing warning text — the renderer already
   guarantees that).
4. Run `pnpm golden:build` — it composites the label onto the committed backdrop deterministically,
   no network call.

`scripts/golden/verify.ts` (LH-006, not yet built) will eventually check this track's consistency
too; until then, the loader (`src/lib/golden-set/loader.ts`) already enforces the schema shape.
```

- [ ] **Step 3: Run the full test suite and lints**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS. This is the plan's final check — every task above already verified its own slice, this confirms nothing conflicts across files.

- [ ] **Step 4: Commit**

```bash
git add assets/golden/references/.gitkeep golden-set/backdrops/.gitkeep golden-set/README.md
git commit -m "docs(golden-set): document the realistic-corpus track and add its directories"
```

---

## Out of scope (explicitly deferred)

- Generating the real corpus. No reference photos exist yet — Troy supplies them later, then runs `pnpm golden:imagen` himself (or asks for a follow-up session to run it).
- `scripts/golden/verify.ts` (LH-006) — belongs to a separate ticket per `factory/tickets.md`.
- Updating `factory/tickets.md` / Linear (LH-005 / TRO-498)'s description to match this design — design doc §10 flags this as deferred to whoever picks up ticket bookkeeping; it is not a code change this plan makes.
- The manual-corner-click fallback tool for images where automated detection fails (design doc §5) — build it only if the pilot batch (once real photos exist) shows automated detection genuinely fails on some images. Speculative before that.
