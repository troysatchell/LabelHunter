/**
 * Loader and validator for the golden-set manifest (TRO-458 / LH-003, TH-R12).
 *
 * `validateManifest` checks the shape of a parsed manifest against the
 * ground-truth schema in `./types.ts` and reports every problem it finds —
 * not just the first one — so a broken manifest is fixable in one pass.
 * `loadGoldenSetManifest` reads `golden-set/manifest.json` from disk and
 * runs it through `validateManifest`. Both throw `GoldenSetValidationError`
 * on a malformed manifest; neither ever returns a partially-valid result.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BeverageType,
  CameraCondition,
  FieldVerdict,
  GoldenSetCase,
  GoldenSetCategory,
  GoldenSetManifest,
  GoldenSetProvenance,
  LabelVerdict,
  ReviewReason,
  RubricVector,
} from "./types";

/** Exported so a caller that needs the manifest's own file path — not just
 * its parsed content — can read the identical file this loader reads
 * (TRO-538 / LH-033: `scripts/eval/manifest-hash.ts` hashes this same path,
 * so "the manifest we loaded" and "the manifest we hashed" can never
 * drift apart into two different files). */
export const DEFAULT_MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../golden-set/manifest.json",
);

/** Thrown when a manifest fails validation. `problems` lists every issue found, not just the first. */
export class GoldenSetValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `golden-set manifest failed validation (${problems.length} problem(s)):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "GoldenSetValidationError";
    this.problems = problems;
  }
}

const FIELD_VERDICTS: readonly FieldVerdict[] = [
  "MATCH",
  "MISMATCH",
  "NEEDS_REVIEW",
];
const LABEL_VERDICTS: readonly LabelVerdict[] = ["PASS", "FAIL", "REVIEW"];
const REVIEW_REASONS: readonly ReviewReason[] = [
  "LOW_IMAGE_QUALITY",
  "AMBIGUOUS_BRAND",
  "AMBIGUOUS_ABV",
  "AMBIGUOUS_NET_CONTENTS",
  "WARNING_MISMATCH",
  "MISSING_REQUIRED_FIELD",
  "CONFLICTING_EXTRACTION",
  "LOW_MODEL_CONFIDENCE",
];
const CATEGORIES: readonly GoldenSetCategory[] = [
  "clean-match",
  "abv-mismatch",
  "title-case-warning",
  "reworded-warning",
  "missing-warning",
  "case-variant-brand",
  "glare",
  "rotation",
  "low-light",
  "tiny-warning-text",
  "odd-typography",
  "conflicting-application-vs-label",
];
const BEVERAGE_TYPES: readonly BeverageType[] = ["beer", "wine", "spirits"];
const PROVENANCE_VALUES: readonly GoldenSetProvenance[] = [
  "rendered",
  "rendered+degraded",
  "ai-generated",
  "rendered+ai-backdrop",
];
const CAMERA_CONDITIONS: readonly CameraCondition[] = ["steady", "motion-blur", "camera-shake"];
const AI_BACKDROP_ONLY_FIELDS = [
  "referenceBottle",
  "scene",
  "cameraCondition",
  "labelPlacement",
  "generationMetadata",
] as const;
const RUBRIC_VECTORS: readonly RubricVector[] = [
  "V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10",
];
const DEGRADATION_TYPES = [
  "rotate",
  "perspective",
  "glare",
  "low-light",
  "blur",
] as const;
const EXPECTED_FIELD_KEYS = [
  "brandName",
  "classType",
  "abv",
  "netContents",
  "governmentWarning",
] as const;
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Checks `value` is a string in the exact canonical format
 * `Date.prototype.toISOString()` produces (e.g.
 * `"2026-08-11T20:12:08.000Z"`) — the format `imagen.ts` actually writes
 * for `generationMetadata.generatedAt` (`new Date().toISOString()`).
 * Round-tripping through `toISOString()` and comparing to the original
 * string rejects both unparseable values ("unknown") and parseable-but-
 * non-canonical ones (a date with no time, or missing milliseconds) that
 * `isNonEmptyString` alone would let through.
 */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Checks one field against a type predicate and pushes a readable problem
 * message when it fails. Returns whether the field is present and correct,
 * so callers can skip dependent checks on a field that already failed.
 */
function checkField(
  problems: string[],
  where: string,
  obj: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => boolean,
  typeDescription: string,
): boolean {
  if (!(key in obj)) {
    problems.push(`${where}: missing required field "${key}"`);
    return false;
  }
  if (!predicate(obj[key])) {
    problems.push(
      `${where}: field "${key}" must be ${typeDescription}, got ${JSON.stringify(obj[key])}`,
    );
    return false;
  }
  return true;
}

function checkOptionalField(
  problems: string[],
  where: string,
  obj: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => boolean,
  typeDescription: string,
): void {
  if (key in obj && obj[key] !== undefined) {
    if (!predicate(obj[key])) {
      problems.push(
        `${where}: field "${key}" must be ${typeDescription} when present, got ${JSON.stringify(obj[key])}`,
      );
    }
  }
}

function checkEnum<T extends string>(
  problems: string[],
  where: string,
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): void {
  if (!(key in obj)) {
    problems.push(`${where}: missing required field "${key}"`);
    return;
  }
  const value = obj[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    problems.push(
      `${where}: field "${key}" must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
}

function checkVectors(
  problems: string[],
  where: string,
  obj: Record<string, unknown>,
  key: string,
): void {
  if (!(key in obj)) {
    problems.push(`${where}: missing required field "${key}"`);
    return;
  }
  const value = obj[key];
  if (!Array.isArray(value)) {
    problems.push(`${where}: field "${key}" must be an array, got ${JSON.stringify(value)}`);
    return;
  }
  for (const v of value) {
    if (typeof v !== "string" || !(RUBRIC_VECTORS as readonly string[]).includes(v)) {
      problems.push(
        `${where}: field "${key}" contains an invalid vector ${JSON.stringify(v)} — must be one of ${RUBRIC_VECTORS.join(", ")}`,
      );
    }
  }
}

type ParamType = "number" | "string";

/** A `DegradationType`'s required and optional `params` keys, with each key's primitive type. */
interface DegradationParamShape {
  readonly required: Record<string, ParamType>;
  readonly optional?: Record<string, ParamType>;
}

/**
 * Required and optional parameter keys, and their primitive type, per
 * `DegradationType` — matching what `scripts/golden/degrade.ts`'s `apply*`
 * functions actually read (its `params.angleDegrees ?? 25` style defaults
 * are exactly the `optional` keys below). This is a shape check only
 * (present-if-required, right primitive type, no unrecognized key) — the
 * real range checks (opacity in (0,1], sigma in [0.3, 1000], and so on)
 * stay in `degrade.ts`, the schema of record for a transform's own limits.
 * A manifest that names a key with the wrong type, or a key a transform
 * does not read at all, is still a mistake worth catching here, before
 * `build.ts` ever calls sharp.
 */
const DEGRADATION_PARAM_SHAPE: Record<
  (typeof DEGRADATION_TYPES)[number],
  DegradationParamShape
> = {
  rotate: { required: { angleDegrees: "number" } },
  blur: { required: { sigma: "number" } },
  perspective: { required: { shear: "number" } },
  glare: {
    required: { region: "string" },
    optional: { angleDegrees: "number", opacity: "number" },
  },
  "low-light": {
    required: { region: "string", brightnessFactor: "number" },
    // TRO-516 correction C3: optional dynamic-range compression toward
    // mid-gray and deterministic sensor noise, matching
    // `scripts/golden/degrade.ts`'s `applyLowLight` params exactly —
    // absent, a case keeps the original brightness-only behavior.
    optional: { contrastFactor: "number", noiseAmplitude: "number" },
  },
};

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
 * forensic record, not a reproducibility claim (design doc §6/§10).
 * `model`, `resolution`, and `promptVersion` are required non-empty
 * strings; there is no enum to check against here because the model name
 * and resolution are free text describing whatever `imagen.ts` actually
 * used, not a closed set this schema owns. `generatedAt` is narrower: it
 * must be a real ISO-8601 timestamp in `imagen.ts`'s own
 * `new Date().toISOString()` format, not merely a non-empty string —
 * forensic metadata that cannot be parsed as a timestamp is worse than
 * useless in a committed manifest.
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
  checkField(
    problems,
    w,
    raw,
    "generatedAt",
    isIsoTimestamp,
    'an ISO-8601 timestamp matching Date.prototype.toISOString() (e.g. "2026-08-11T20:12:08.000Z")',
  );
}

/**
 * Validates the optional `degradations` list (TRO-497 / LH-004, design doc
 * §3). Absent or an empty array are both fine — most cases carry no
 * degradations. Checks that every entry's `params` object has the required
 * keys its `type` needs, that any optional key present has the right
 * type, and that no other, unrecognized key is present — a closed schema,
 * not just a required-keys check. Also checks order: a `glare` or
 * `low-light` entry cannot follow a `rotate` or `perspective` entry.
 * `degrade.ts`'s `assertMatchesOriginalCanvas` refuses that same
 * combination at build time. A rotate or perspective transform changes
 * the canvas, so `LABEL_REGIONS`'s coordinates no longer point at the
 * right pixels.
 */
function checkDegradations(
  problems: string[],
  where: string,
  raw: unknown,
): void {
  if (!Array.isArray(raw)) {
    problems.push(`${where}: field "degradations" must be an array, got ${JSON.stringify(raw)}`);
    return;
  }

  // Tracks whether an earlier entry in this same list already applied a
  // geometric transform (rotate or perspective). See the ordering note
  // above this function.
  let sawGeometricTransform = false;

  raw.forEach((entry, i) => {
    const w = `${where}.degradations[${i}]`;
    if (!isRecord(entry)) {
      problems.push(`${w}: must be an object`);
      return;
    }
    checkEnum(problems, w, entry, "type", DEGRADATION_TYPES);
    if (!("params" in entry) || !isRecord(entry.params)) {
      problems.push(`${w}: field "params" must be an object`);
      return;
    }

    const type = entry.type;
    if (typeof type !== "string" || !(type in DEGRADATION_PARAM_SHAPE)) {
      return; // Already reported by the checkEnum call above.
    }

    if ((type === "glare" || type === "low-light") && sawGeometricTransform) {
      problems.push(
        `${w}: "${type}" cannot follow a rotate or perspective entry — LABEL_REGIONS no longer matches the transformed image`,
      );
    }
    if (type === "rotate" || type === "perspective") {
      sawGeometricTransform = true;
    }

    const shape = DEGRADATION_PARAM_SHAPE[type as keyof typeof DEGRADATION_PARAM_SHAPE];
    const params = entry.params;

    for (const [key, expectedType] of Object.entries(shape.required)) {
      if (typeof params[key] !== expectedType) {
        problems.push(
          `${w}.params: "${type}" requires "${key}" to be a ${expectedType}, got ${JSON.stringify(params[key])}`,
        );
      }
    }
    for (const [key, expectedType] of Object.entries(shape.optional ?? {})) {
      if (key in params && typeof params[key] !== expectedType) {
        problems.push(
          `${w}.params: "${type}"'s optional "${key}" must be a ${expectedType} when present, got ${JSON.stringify(params[key])}`,
        );
      }
    }
    const allowedKeys = new Set([
      ...Object.keys(shape.required),
      ...Object.keys(shape.optional ?? {}),
    ]);
    for (const key of Object.keys(params)) {
      if (!allowedKeys.has(key)) {
        problems.push(`${w}.params: "${type}" does not accept a "${key}" param`);
      }
    }
  });
}

function checkApplication(problems: string[], where: string, raw: unknown): void {
  if (!isRecord(raw)) {
    problems.push(`${where}: "application" must be an object`);
    return;
  }
  const w = `${where}.application`;
  checkField(problems, w, raw, "brandName", isNonEmptyString, "a non-empty string");
  checkField(problems, w, raw, "classType", isNonEmptyString, "a non-empty string");
  checkOptionalField(problems, w, raw, "abvPercent", isFiniteNumber, "a finite number");
  checkField(problems, w, raw, "netContentsValue", isFiniteNumber, "a finite number");
  checkField(problems, w, raw, "netContentsUnit", isNonEmptyString, "a non-empty string");
}

function checkLabel(problems: string[], where: string, raw: unknown): void {
  if (!isRecord(raw)) {
    problems.push(`${where}: "label" must be an object`);
    return;
  }
  const w = `${where}.label`;
  checkField(problems, w, raw, "brandName", isNonEmptyString, "a non-empty string");
  checkField(problems, w, raw, "classType", isNonEmptyString, "a non-empty string");
  const abvPresentOk = checkField(
    problems,
    w,
    raw,
    "abvPresent",
    isBoolean,
    "a boolean",
  );
  const abvTextOk = checkField(
    problems,
    w,
    raw,
    "abvText",
    (v) => typeof v === "string",
    "a string",
  );
  if (abvTextOk && abvPresentOk && raw.abvPresent === true && !isNonEmptyString(raw.abvText)) {
    problems.push(`${w}: field "abvText" must be non-empty when abvPresent is true`);
  }
  checkOptionalField(problems, w, raw, "abvPercent", isFiniteNumber, "a finite number");
  checkOptionalField(problems, w, raw, "proof", isFiniteNumber, "a finite number");
  checkField(problems, w, raw, "netContentsText", isNonEmptyString, "a non-empty string");
  checkField(problems, w, raw, "netContentsValue", isFiniteNumber, "a finite number");
  checkField(problems, w, raw, "netContentsUnit", isNonEmptyString, "a non-empty string");
  const warningPresentOk = checkField(
    problems,
    w,
    raw,
    "governmentWarningPresent",
    isBoolean,
    "a boolean",
  );
  const warningTextOk = checkField(
    problems,
    w,
    raw,
    "governmentWarningText",
    (v) => typeof v === "string",
    "a string",
  );
  if (
    warningTextOk &&
    warningPresentOk &&
    raw.governmentWarningPresent === true &&
    !isNonEmptyString(raw.governmentWarningText)
  ) {
    problems.push(
      `${w}: field "governmentWarningText" must be non-empty when governmentWarningPresent is true`,
    );
  }
  checkField(
    problems,
    w,
    raw,
    "governmentWarningPrefixAllCaps",
    isBoolean,
    "a boolean",
  );
}

function checkFieldExpectation(
  problems: string[],
  where: string,
  raw: unknown,
): void {
  if (!isRecord(raw)) {
    problems.push(`${where}: must be an object`);
    return;
  }
  checkEnum(problems, where, raw, "verdict", FIELD_VERDICTS);
  checkField(problems, where, raw, "reason", isNonEmptyString, "a non-empty string");
}

function checkExpected(problems: string[], where: string, raw: unknown): void {
  if (!isRecord(raw)) {
    problems.push(`${where}: "expected" must be an object`);
    return;
  }
  const w = `${where}.expected`;
  checkEnum(problems, w, raw, "labelVerdict", LABEL_VERDICTS);

  const labelVerdict = raw.labelVerdict;
  const hasReviewReason = "reviewReason" in raw && raw.reviewReason !== undefined;
  if (labelVerdict === "REVIEW") {
    if (!hasReviewReason) {
      problems.push(
        `${w}: "reviewReason" is required when labelVerdict is REVIEW`,
      );
    } else if (
      typeof raw.reviewReason !== "string" ||
      !(REVIEW_REASONS as readonly string[]).includes(raw.reviewReason)
    ) {
      problems.push(
        `${w}: field "reviewReason" must be one of ${REVIEW_REASONS.join(", ")}, got ${JSON.stringify(raw.reviewReason)}`,
      );
    }
  } else if (hasReviewReason) {
    problems.push(
      `${w}: "reviewReason" must be absent when labelVerdict is not REVIEW (got ${JSON.stringify(labelVerdict)})`,
    );
  }

  if (!("fields" in raw) || !isRecord(raw.fields)) {
    problems.push(`${w}: missing or invalid "fields" object`);
    return;
  }
  const fields = raw.fields;
  for (const key of EXPECTED_FIELD_KEYS) {
    if (!(key in fields)) {
      problems.push(`${w}.fields: missing required field "${key}"`);
      continue;
    }
    checkFieldExpectation(problems, `${w}.fields.${key}`, fields[key]);
  }
}

/** Extracts the filename (without extension) from an image path, e.g. "a/b/c.jpg" -> "c". */
function basenameWithoutExtension(imagePath: string): string {
  const base = imagePath.split("/").pop() ?? imagePath;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

function checkCase(problems: string[], index: number, raw: unknown): void {
  const where = `cases[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${where}: must be an object`);
    return;
  }

  const caseIdOk = checkField(
    problems,
    where,
    raw,
    "caseId",
    isNonEmptyString,
    "a non-empty string",
  );
  const caseLabel = caseIdOk ? `${where} (${raw.caseId as string})` : where;

  checkField(problems, caseLabel, raw, "description", isNonEmptyString, "a non-empty string");
  checkEnum(problems, caseLabel, raw, "category", CATEGORIES);
  checkEnum(problems, caseLabel, raw, "beverageType", BEVERAGE_TYPES);

  const imagePathOk = checkField(
    problems,
    caseLabel,
    raw,
    "imagePath",
    isNonEmptyString,
    "a non-empty string",
  );
  if (imagePathOk) {
    const imagePath = raw.imagePath as string;
    const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
    if (!imagePath.startsWith("golden-set/images/")) {
      problems.push(
        `${caseLabel}: imagePath "${imagePath}" must start with "golden-set/images/"`,
      );
    }
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      problems.push(
        `${caseLabel}: imagePath "${imagePath}" must end in one of ${IMAGE_EXTENSIONS.join(", ")}`,
      );
    }
    if (caseIdOk && basenameWithoutExtension(imagePath) !== raw.caseId) {
      problems.push(
        `${caseLabel}: imagePath basename "${basenameWithoutExtension(imagePath)}" must match caseId "${String(raw.caseId)}"`,
      );
    }
  }

  checkEnum(problems, caseLabel, raw, "provenance", PROVENANCE_VALUES);
  checkField(problems, caseLabel, raw, "verified", (v) => typeof v === "boolean", "a boolean");
  checkVectors(problems, caseLabel, raw, "vectors");
  if (raw.provenance === "ai-generated" && raw.verified !== true) {
    // Design doc §3: an ai-generated image can silently fail to render the
    // exact text its spec claims. The eval harness must not trust one until
    // a human has confirmed it. This is a MANIFEST-level rule, not just a
    // type constraint, so it is checked here rather than only in the type.
    problems.push(
      `${caseLabel}: provenance "ai-generated" requires verified: true before the eval harness may use it (currently ${JSON.stringify(raw.verified)})`,
    );
  }

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

  if ("application" in raw) {
    checkApplication(problems, caseLabel, raw.application);
  } else {
    problems.push(`${caseLabel}: missing required field "application"`);
  }

  if ("label" in raw) {
    checkLabel(problems, caseLabel, raw.label);
  } else {
    problems.push(`${caseLabel}: missing required field "label"`);
  }

  if ("expected" in raw) {
    checkExpected(problems, caseLabel, raw.expected);
  } else {
    problems.push(`${caseLabel}: missing required field "expected"`);
  }

  if ("degradations" in raw && raw.degradations !== undefined) {
    checkDegradations(problems, caseLabel, raw.degradations);
    // A non-empty degradations list only makes sense on a case that admits
    // to being degraded. A "rendered" (clean) or "ai-generated" case
    // claiming a rotate/glare/etc. history is self-contradictory — one or
    // the other field is wrong, and this catches it at manifest-load time
    // instead of at whatever point later code trusts one field over the
    // other.
    if (
      Array.isArray(raw.degradations) &&
      raw.degradations.length > 0 &&
      raw.provenance !== "rendered+degraded"
    ) {
      problems.push(
        `${caseLabel}: "degradations" is non-empty but provenance is ${JSON.stringify(raw.provenance)} — only "rendered+degraded" cases may carry degradations`,
      );
    }
  }

  checkOptionalField(problems, caseLabel, raw, "notes", isNonEmptyString, "a non-empty string");
}

/**
 * Validates a parsed manifest against the golden-set ground-truth schema.
 * Collects every problem before throwing, so one malformed manifest fixes
 * in one pass instead of one error at a time.
 */
export function validateManifest(raw: unknown): GoldenSetManifest {
  const problems: string[] = [];

  if (!isRecord(raw)) {
    throw new GoldenSetValidationError(["manifest root must be an object"]);
  }

  checkField(problems, "manifest", raw, "version", isNonEmptyString, "a non-empty string");

  if (!("cases" in raw) || !Array.isArray(raw.cases)) {
    problems.push('manifest: "cases" must be an array');
    throw new GoldenSetValidationError(problems);
  }

  raw.cases.forEach((c, i) => checkCase(problems, i, c));

  const seenIds = new Map<string, number[]>();
  raw.cases.forEach((c, i) => {
    if (isRecord(c) && isNonEmptyString(c.caseId)) {
      const indices = seenIds.get(c.caseId) ?? [];
      indices.push(i);
      seenIds.set(c.caseId, indices);
    }
  });
  for (const [caseId, indices] of seenIds) {
    if (indices.length > 1) {
      problems.push(
        `manifest: duplicate case ID "${caseId}" at indices ${indices.join(", ")}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new GoldenSetValidationError(problems);
  }

  return raw as unknown as GoldenSetManifest;
}

/**
 * Reads and validates the golden-set manifest from disk. Defaults to the
 * repo's committed `golden-set/manifest.json`; pass an explicit path to
 * validate a different file (used by tooling and tests).
 */
export function loadGoldenSetManifest(
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): GoldenSetManifest {
  const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  return validateManifest(raw);
}

// Re-exported so callers can type-check case shapes without importing
// ./types directly for these two.
export type { GoldenSetCase, GoldenSetManifest };
