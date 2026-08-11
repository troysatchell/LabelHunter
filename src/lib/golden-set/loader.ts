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
  FieldVerdict,
  GoldenSetCase,
  GoldenSetCategory,
  GoldenSetManifest,
  GoldenSetProvenance,
  LabelVerdict,
  ReviewReason,
  RubricVector,
} from "./types";

const DEFAULT_MANIFEST_PATH = path.resolve(
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
];
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

/**
 * Validates the optional `degradations` list (TRO-497 / LH-004, design doc
 * §3). Absent or an empty array are both fine — most cases carry no
 * degradations. `params` is checked only for being an object; each
 * `DegradationType` takes different parameter names, and `degrade.ts` is
 * the schema of record for those, not this loader.
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
  raw.forEach((entry, i) => {
    const w = `${where}.degradations[${i}]`;
    if (!isRecord(entry)) {
      problems.push(`${w}: must be an object`);
      return;
    }
    checkEnum(problems, w, entry, "type", DEGRADATION_TYPES);
    if (!("params" in entry) || !isRecord(entry.params)) {
      problems.push(`${w}: field "params" must be an object`);
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
