/**
 * Parses and validates the Haiku extractor's API response (LH-011 / TRO-461).
 *
 * A well-formed response maps straight onto `HaikuExtractionResult`
 * (`types.ts`). A malformed one — a refusal, a truncated response, text that
 * is not valid JSON, or JSON that does not match the schema shape — fails
 * loudly with `HaikuExtractionError`, never silently. This module reports
 * every problem it finds in one pass, not just the first, the same
 * convention `src/lib/golden-set/loader.ts` uses for manifest validation.
 *
 * This module only checks *shape*. It does not apply the Validation
 * Router's deterministic overrides (CP-1 §4.4 — evidence-substring checks,
 * confidence-range rejection). Extraction and comparison are different
 * tickets (LH-011 vs LH-012/013); a low `confidence` or a `null` `value` is
 * a normal, valid extraction result here, not a validation failure.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ExtractedField,
  ExtractedGovernmentWarning,
  ExtractedImageQuality,
  HaikuExtractionResult,
  ImageLegibility,
  ImageQualityIssue,
  WarningBoldness,
  WarningPrefixCasing,
} from "./types";

/** Thrown when an API response is refused, incomplete, or does not match the extraction schema. */
export class HaikuExtractionError extends Error {
  /** Every problem found, not just the first. */
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Haiku extraction response failed validation (${problems.length} problem(s)):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
    this.name = "HaikuExtractionError";
    this.problems = problems;
  }
}

const IMAGE_LEGIBILITY_VALUES: readonly ImageLegibility[] = ["yes", "partial", "no"];
const IMAGE_QUALITY_ISSUE_VALUES: readonly ImageQualityIssue[] = [
  "glare",
  "blur",
  "rotation",
  "low_light",
  "cropped",
  "obstructed",
  "low_resolution",
  "none",
];
const WARNING_PREFIX_CASING_VALUES: readonly WarningPrefixCasing[] = [
  "ALL_CAPS",
  "TITLE_CASE",
  "OTHER",
  "NOT_VISIBLE",
];
const WARNING_BOLDNESS_VALUES: readonly WarningBoldness[] = ["true", "false", "uncertain"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Collects every shape problem found while walking a parsed value, instead
 * of throwing on the first one. Each `noteX` method records a problem and
 * returns a placeholder so the walk can keep going and find the rest.
 */
class ValidationContext {
  readonly problems: string[] = [];

  private note(path: string, detail: string): void {
    this.problems.push(`${path}: ${detail}`);
  }

  record(value: unknown, path: string): Record<string, unknown> {
    if (isRecord(value)) return value;
    this.note(path, `expected an object, got ${describeType(value)}`);
    return {};
  }

  str(value: unknown, path: string): string {
    if (typeof value === "string") return value;
    this.note(path, `expected a string, got ${describeType(value)}`);
    return "";
  }

  nullableStr(value: unknown, path: string): string | null {
    if (value === null) return null;
    return this.str(value, path);
  }

  num(value: unknown, path: string): number {
    if (typeof value === "number") return value;
    this.note(path, `expected a number, got ${describeType(value)}`);
    return 0;
  }

  bool(value: unknown, path: string): boolean {
    if (typeof value === "boolean") return value;
    this.note(path, `expected a boolean, got ${describeType(value)}`);
    return false;
  }

  enumOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
      return value as T;
    }
    this.note(path, `expected one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
    return allowed[0];
  }

  strArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) {
      this.note(path, `expected an array, got ${describeType(value)}`);
      return [];
    }
    return value.map((item, i) => this.str(item, `${path}[${i}]`));
  }

  enumArray<T extends string>(value: unknown, allowed: readonly T[], path: string): T[] {
    if (!Array.isArray(value)) {
      this.note(path, `expected an array, got ${describeType(value)}`);
      return [];
    }
    return value.map((item, i) => this.enumOf(item, allowed, `${path}[${i}]`));
  }
}

function parseField(ctx: ValidationContext, value: unknown, path: string): ExtractedField {
  const obj = ctx.record(value, path);
  return {
    value: ctx.nullableStr(obj.value, `${path}.value`),
    evidence: ctx.str(obj.evidence, `${path}.evidence`),
    confidence: ctx.num(obj.confidence, `${path}.confidence`),
    alternates: ctx.strArray(obj.alternates, `${path}.alternates`),
  };
}

function parseImageQuality(
  ctx: ValidationContext,
  value: unknown,
  path: string,
): ExtractedImageQuality {
  const obj = ctx.record(value, path);
  return {
    legible: ctx.enumOf(obj.legible, IMAGE_LEGIBILITY_VALUES, `${path}.legible`),
    issues: ctx.enumArray(obj.issues, IMAGE_QUALITY_ISSUE_VALUES, `${path}.issues`),
    confidence: ctx.num(obj.confidence, `${path}.confidence`),
  };
}

function parseGovernmentWarning(
  ctx: ValidationContext,
  value: unknown,
  path: string,
): ExtractedGovernmentWarning {
  const obj = ctx.record(value, path);
  const formatting = ctx.record(obj.formatting, `${path}.formatting`);
  return {
    present: ctx.bool(obj.present, `${path}.present`),
    transcription: ctx.nullableStr(obj.transcription, `${path}.transcription`),
    prefix_casing: ctx.enumOf(
      obj.prefix_casing,
      WARNING_PREFIX_CASING_VALUES,
      `${path}.prefix_casing`,
    ),
    formatting: {
      bold: ctx.enumOf(formatting.bold, WARNING_BOLDNESS_VALUES, `${path}.formatting.bold`),
    },
    evidence: ctx.str(obj.evidence, `${path}.evidence`),
    confidence: ctx.num(obj.confidence, `${path}.confidence`),
  };
}

/**
 * Validates an already-`JSON.parse`d value against the extraction schema
 * shape and returns a typed result. Throws `HaikuExtractionError` listing
 * every problem found — never returns a partially-valid result.
 */
export function validateExtractionResult(value: unknown): HaikuExtractionResult {
  const ctx = new ValidationContext();
  const obj = ctx.record(value, "$");
  const result: HaikuExtractionResult = {
    image_quality: parseImageQuality(ctx, obj.image_quality, "$.image_quality"),
    brand_name: parseField(ctx, obj.brand_name, "$.brand_name"),
    class_type: parseField(ctx, obj.class_type, "$.class_type"),
    alcohol_content: parseField(ctx, obj.alcohol_content, "$.alcohol_content"),
    net_contents: parseField(ctx, obj.net_contents, "$.net_contents"),
    beverage_type: parseField(ctx, obj.beverage_type, "$.beverage_type"),
    government_warning: parseGovernmentWarning(
      ctx,
      obj.government_warning,
      "$.government_warning",
    ),
  };
  if (ctx.problems.length > 0) {
    throw new HaikuExtractionError(ctx.problems);
  }
  return result;
}

/**
 * Parses and validates a raw Anthropic API response into a typed extraction
 * result. Throws `HaikuExtractionError` when the response was refused,
 * stopped early, carries no text block, is not valid JSON, or does not
 * match the schema.
 */
export function parseExtractionResponse(message: Anthropic.Message): HaikuExtractionResult {
  if (message.stop_reason === "refusal") {
    throw new HaikuExtractionError([
      "response was refused (stop_reason: refusal) — see message.stop_details for the category",
    ]);
  }
  if (message.stop_reason !== "end_turn") {
    throw new HaikuExtractionError([
      `response stopped early (stop_reason: ${String(message.stop_reason)}) — ` +
        "it may be truncated or incomplete",
    ]);
  }

  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (!textBlock) {
    throw new HaikuExtractionError(["response has no text content block"]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new HaikuExtractionError([`response text is not valid JSON: ${detail}`]);
  }

  return validateExtractionResult(parsed);
}
