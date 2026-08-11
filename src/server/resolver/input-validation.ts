/**
 * Boundary validation for values the resolver's user message embeds
 * (LH-014 / TRO-464, CP-1 §6.3's implementation requirement).
 *
 * The prompt-level delimiting in `serialize.ts` is necessary but not
 * sufficient (CP-1 §6.3): "before any application-form field or
 * extractor-JSON value reaches this template, LH-014 must validate its type
 * and length (an implausibly long 'brand name' is itself a signal,
 * independent of what it contains)". This module is that check. It runs
 * before `user-message.ts` builds anything, and it rejects — it never
 * truncates a too-long value into something that silently fits, because a
 * truncated value is a corrupted one, and a caller building a prompt from a
 * silently-mangled application record is a worse failure than a loud error.
 *
 * Every check below takes `unknown`, not the declared TypeScript type — this
 * function sits at the boundary where a value's shape is only ASSUMED
 * (CLAUDE.md's own standing rule). `ApplicationRecord`/`HaikuExtractionResult`
 * are compile-time promises; a value that crossed a JSON round-trip, a
 * database read, or a hand-built test fixture can violate them at runtime
 * without TypeScript ever seeing it. This module treats every field as
 * genuinely untrusted in shape, not just in content — a non-string where a
 * string is expected, or a non-array `alternates`, is rejected the same way
 * an over-length string is: loudly, before it reaches a paid API call.
 */
import type { ApplicationRecord } from "../router/types";
import type { HaikuExtractionResult } from "../extractor/types";

export class ResolverInputError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Resolver input failed validation (${problems.length} problem(s)):\n` + problems.map((p) => `  - ${p}`).join("\n"));
    this.name = "ResolverInputError";
    this.problems = problems;
  }
}

/**
 * Real brand names, class/type designations, and alcohol/net-contents
 * statements are short — CP-1's own worked examples are all under 60
 * characters. 500 is generous headroom for a legitimate value while still
 * catching a "wall of text" injection payload appended to one.
 */
export const SHORT_FIELD_MAX_LENGTH = 500;

/**
 * The government warning is a full statutory paragraph — CP-1's canonical
 * text (`src/lib/db/seed.ts`'s `CANONICAL_WARNING`) runs a little over 300
 * characters. 3000 comfortably fits that plus formatting noise, while still
 * bounding a pathological payload.
 */
export const LONG_FIELD_MAX_LENGTH = 3000;

/**
 * Validates a string-or-null untrusted field. `null` is a legitimate,
 * documented state (an absent extractor field, CP-1 §3.4) and passes
 * unconditionally. Anything else that is not actually a `string` — a
 * number, an object, `undefined` — is a shape violation: nothing in this
 * repo's types ever declares one of these fields as optional or as
 * something other than `string | null`, so a value reaching here in some
 * other shape means an earlier assumption was wrong, not that this check
 * should quietly coerce or skip it.
 */
function checkLength(value: unknown, path: string, max: number, problems: string[]): void {
  if (value === null) return;
  if (typeof value !== "string") {
    problems.push(
      `${path}: expected a string or null, got ${describeUnknown(value)} — refusing to embed non-string untrusted data in the resolver prompt`,
    );
    return;
  }
  if (value.length > max) {
    problems.push(`${path}: length ${value.length} exceeds the ${max}-character ceiling — refusing to embed it in the resolver prompt`);
  }
}

/** Validates an `alternates` array itself is actually an array before
 * checking each entry — a non-array here (an object, a bare string, `null`)
 * is rejected outright rather than iterated, which would either throw an
 * uncontrolled `TypeError` (`.forEach` on a non-array) or, worse, silently
 * do nothing on a value like a string (arrays and strings both have
 * `.length`, but only an array is iterable the way this check assumes). */
function checkAlternates(value: unknown, path: string, max: number, problems: string[]): void {
  if (!Array.isArray(value)) {
    problems.push(
      `${path}: expected an array, got ${describeUnknown(value)} — refusing to embed non-array untrusted alternates in the resolver prompt`,
    );
    return;
  }
  value.forEach((item, i) => checkLength(item, `${path}[${i}]`, max, problems));
}

/**
 * Validates a numeric untrusted field. `undefined` is a legitimate state
 * only for `alcoholContentPercent` (`ApplicationRecord` marks it optional —
 * CP-1 §5.3's beer/wine ABV-optionality VERIFY cell) and is skipped when
 * `optional` is set; every other numeric field must be present. `NaN` and
 * `Infinity` are real risks, not theoretical ones — `JSON.stringify` silently
 * turns either into the JSON literal `null` with no error, which would
 * corrupt the untrusted-data block's meaning without this check ever firing.
 * This module does not invent a business-rule numeric range (no regulatory
 * citation backs one) — only finiteness and type are checked here.
 */
function checkFiniteNumber(value: unknown, path: string, problems: string[], options: { optional?: boolean } = {}): void {
  if (value === undefined && options.optional) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    problems.push(
      `${path}: expected a finite number, got ${describeUnknown(value)} — refusing to embed a non-finite or non-numeric untrusted value in the resolver prompt`,
    );
  }
}

function describeUnknown(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (typeof value === "object" && value !== null) return "an object";
  return `${typeof value} (${JSON.stringify(value)})`;
}

/**
 * Walks every value the resolver's user message will embed from the
 * application record and the extractor's reading — both untrusted input by
 * construction (CP-1 §6.3) — and collects every problem found, the same
 * "report every problem, not just the first" convention
 * `../extractor/response.ts` uses. Throws `ResolverInputError` if any is found.
 *
 * Every field of `ApplicationRecord` that `user-message.ts`'s
 * `buildApplicationBlock` serializes is checked here — not just
 * `brandName`/`classType` — because every one of them reaches the prompt
 * the same way, through the same `serializeUntrusted` call, and an
 * unchecked field is exactly as reachable by an attacker as a checked one.
 */
export function assertUntrustedInputWithinBounds(input: {
  application: ApplicationRecord;
  extraction: HaikuExtractionResult;
}): void {
  const problems: string[] = [];
  const { application, extraction } = input;

  checkLength(application.brandName, "application.brandName", SHORT_FIELD_MAX_LENGTH, problems);
  checkLength(application.classType, "application.classType", SHORT_FIELD_MAX_LENGTH, problems);
  checkLength(application.beverageType, "application.beverageType", SHORT_FIELD_MAX_LENGTH, problems);
  checkLength(application.netContentsUnit, "application.netContentsUnit", SHORT_FIELD_MAX_LENGTH, problems);
  checkFiniteNumber(application.alcoholContentPercent, "application.alcoholContentPercent", problems, { optional: true });
  checkFiniteNumber(application.netContentsValue, "application.netContentsValue", problems);

  for (const field of ["brand_name", "class_type", "alcohol_content", "net_contents", "beverage_type"] as const) {
    const extracted = extraction[field];
    checkLength(extracted.value, `extraction.${field}.value`, SHORT_FIELD_MAX_LENGTH, problems);
    checkLength(extracted.evidence, `extraction.${field}.evidence`, SHORT_FIELD_MAX_LENGTH, problems);
    checkAlternates(extracted.alternates, `extraction.${field}.alternates`, SHORT_FIELD_MAX_LENGTH, problems);
  }

  checkLength(
    extraction.government_warning.transcription,
    "extraction.government_warning.transcription",
    LONG_FIELD_MAX_LENGTH,
    problems,
  );
  checkLength(extraction.government_warning.evidence, "extraction.government_warning.evidence", LONG_FIELD_MAX_LENGTH, problems);

  if (problems.length > 0) {
    throw new ResolverInputError(problems);
  }
}
