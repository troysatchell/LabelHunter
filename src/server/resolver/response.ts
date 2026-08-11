/**
 * Parses and validates the Sonnet resolver's API response, then enforces the
 * judges-only-brand/class rule (LH-014 / TRO-464, CP-1 §6.4/§6.5).
 *
 * Two passes, deliberately kept separate:
 *
 * 1. Shape validation (`validateResolverResult`) — same convention as
 *    `../extractor/response.ts`: walk the parsed JSON, collect every shape
 *    problem in one pass (wrong type, bad enum value, missing property),
 *    throw `ResolverResponseError` naming all of them, never just the first.
 *    This pass alone would still let a `government_warning` entry carry a
 *    schema-legal `RESOLVED_MATCH` — the schema (CP-1 open question 12) does
 *    not forbid it.
 *
 * 2. Business-rule derivation (`deriveResolvedFields`) — looks up exactly
 *    the fields the caller flagged (never fields the model volunteered an
 *    opinion on but nobody asked about — CP-1 §6.2 rule 6), and for the
 *    three correction fields (`alcohol_content`, `net_contents`,
 *    `government_warning`) discards the raw `disposition`'s
 *    RESOLVED_MATCH/RESOLVED_MISMATCH judgment entirely — `types.ts`'s
 *    `CorrectionFieldResolution` has no property that could carry it. What
 *    survives is `needsHuman`, because "I cannot read this" (CP-1 §6.2 rule
 *    7) is real signal, not a forbidden opinion.
 *
 * `overall` is always recomputed from the derived fields (CP-1 §6.4: "The
 * router recomputes it rather than trusting it") — the raw response's own
 * `overall` is validated for shape only and then discarded.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  FlaggedField,
  RawResolverField,
  RawResolverResponse,
  ResolvedFieldResult,
  ResolverDisposition,
  ResolverField,
  ResolverJudgedField,
  ResolverResolution,
} from "./types";

/** Thrown when an API response is refused, incomplete, or does not match the resolver schema. */
export class ResolverResponseError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Resolver response failed validation (${problems.length} problem(s)):\n` + problems.map((p) => `  - ${p}`).join("\n"));
    this.name = "ResolverResponseError";
    this.problems = problems;
  }
}

const RESOLVER_FIELD_VALUES: readonly ResolverField[] = [
  "brand_name",
  "class_type",
  "alcohol_content",
  "net_contents",
  "government_warning",
  "beverage_type",
];
const DISPOSITION_VALUES: readonly ResolverDisposition[] = ["RESOLVED_MATCH", "RESOLVED_MISMATCH", "NEEDS_HUMAN"];
const OVERALL_VALUES = ["RESOLVED", "NEEDS_HUMAN"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** Same collect-every-problem convention as `../extractor/response.ts`'s `ValidationContext`. */
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

  arr(value: unknown, path: string): unknown[] {
    if (Array.isArray(value)) return value;
    this.note(path, `expected an array, got ${describeType(value)}`);
    return [];
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

  enumOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
      return value as T;
    }
    this.note(path, `expected one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
    return allowed[0];
  }
}

function parseRawField(ctx: ValidationContext, value: unknown, path: string): RawResolverField {
  const obj = ctx.record(value, path);
  return {
    field: ctx.enumOf(obj.field, RESOLVER_FIELD_VALUES, `${path}.field`),
    disposition: ctx.enumOf(obj.disposition, DISPOSITION_VALUES, `${path}.disposition`),
    corrected_value: ctx.nullableStr(obj.corrected_value, `${path}.corrected_value`),
    evidence: ctx.str(obj.evidence, `${path}.evidence`),
    reason: ctx.str(obj.reason, `${path}.reason`),
    confidence: ctx.num(obj.confidence, `${path}.confidence`),
  };
}

/**
 * Validates an already-`JSON.parse`d value against the resolver schema shape
 * and returns a typed result. Throws `ResolverResponseError` listing every
 * problem found. Shape only — see the module doc comment for why the
 * business-rule pass (`deriveResolvedFields`) is separate.
 */
export function validateResolverResult(value: unknown): RawResolverResponse {
  const ctx = new ValidationContext();
  const obj = ctx.record(value, "$");
  const result: RawResolverResponse = {
    overall: ctx.enumOf(obj.overall, OVERALL_VALUES, "$.overall"),
    fields: ctx.arr(obj.fields, "$.fields").map((item, i) => parseRawField(ctx, item, `$.fields[${i}]`)),
  };
  if (ctx.problems.length > 0) {
    throw new ResolverResponseError(ctx.problems);
  }
  return result;
}

function isJudgedField(field: string): field is ResolverJudgedField {
  return field === "brand_name" || field === "class_type";
}

/**
 * Looks up exactly the caller-flagged fields in the raw response and
 * enforces CP-1 §6.5's judges-only-brand/class rule while doing it. Throws
 * `ResolverResponseError` when a flagged field has no matching entry, or
 * more than one — never guesses which entry to trust (CP-1's own "validate
 * at the boundary... reject, never clamp" rule).
 */
export function deriveResolvedFields(raw: RawResolverResponse, flaggedFields: FlaggedField[]): ResolverResolution {
  const problems: string[] = [];
  const fields: ResolvedFieldResult[] = [];

  for (const flagged of flaggedFields) {
    const matches = raw.fields.filter((entry) => entry.field === flagged.field);
    if (matches.length === 0) {
      problems.push(`no response entry for flagged field "${flagged.field}"`);
      continue;
    }
    if (matches.length > 1) {
      problems.push(`${matches.length} response entries for flagged field "${flagged.field}" — expected exactly one`);
      continue;
    }
    const entry = matches[0];

    if (isJudgedField(flagged.field)) {
      fields.push({
        kind: "judged",
        field: flagged.field,
        disposition: entry.disposition,
        correctedValue: entry.corrected_value,
        evidence: entry.evidence,
        reason: entry.reason,
        confidence: entry.confidence,
      });
    } else {
      // CP-1 §6.5: code re-decides alcohol_content / net_contents /
      // government_warning. `entry.disposition`'s RESOLVED_MATCH /
      // RESOLVED_MISMATCH is a judgment this field is never allowed to
      // carry forward — it is read here only to test for NEEDS_HUMAN
      // (a real "cannot read this" signal, CP-1 §6.2 rule 7) and then
      // dropped. `CorrectionFieldResolution` has no property that could
      // hold a MATCH/MISMATCH opinion, so there is nothing downstream that
      // could accidentally consume it.
      fields.push({
        kind: "correction",
        field: flagged.field,
        needsHuman: entry.disposition === "NEEDS_HUMAN",
        correctedValue: entry.corrected_value,
        evidence: entry.evidence,
        reason: entry.reason,
        confidence: entry.confidence,
      });
    }
  }

  if (problems.length > 0) {
    throw new ResolverResponseError(problems);
  }

  const outcome = fields.every((field) => (field.kind === "judged" ? field.disposition !== "NEEDS_HUMAN" : !field.needsHuman))
    ? "resolved"
    : "needs-human";

  return { outcome, fields };
}

/**
 * Parses and validates a raw Anthropic API response into a resolved,
 * business-rule-enforced result. Throws `ResolverResponseError` when the
 * response was refused, stopped early, carries no text block, is not valid
 * JSON, does not match the schema, or does not answer every flagged field
 * exactly once.
 */
export function parseResolverResponse(message: Anthropic.Message, flaggedFields: FlaggedField[]): ResolverResolution {
  if (message.stop_reason === "refusal") {
    throw new ResolverResponseError([
      "response was refused (stop_reason: refusal) — see message.stop_details for the category",
    ]);
  }
  if (message.stop_reason !== "end_turn") {
    throw new ResolverResponseError([
      `response stopped early (stop_reason: ${String(message.stop_reason)}) — it may be truncated or incomplete`,
    ]);
  }

  const textBlock = message.content.find((block): block is Anthropic.TextBlock => block.type === "text");
  if (!textBlock) {
    throw new ResolverResponseError(["response has no text content block"]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ResolverResponseError([`response text is not valid JSON: ${detail}`]);
  }

  const raw = validateResolverResult(parsed);
  return deriveResolvedFields(raw, flaggedFields);
}
