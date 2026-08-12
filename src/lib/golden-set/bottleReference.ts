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
