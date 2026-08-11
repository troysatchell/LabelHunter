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
 */

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

function checkLength(value: string | null, path: string, max: number, problems: string[]): void {
  if (value !== null && value.length > max) {
    problems.push(`${path}: length ${value.length} exceeds the ${max}-character ceiling — refusing to embed it in the resolver prompt`);
  }
}

function checkAlternates(values: string[], path: string, max: number, problems: string[]): void {
  values.forEach((value, i) => checkLength(value, `${path}[${i}]`, max, problems));
}

/**
 * Walks every string the resolver's user message will embed from the
 * application record and the extractor's reading — both untrusted input by
 * construction (CP-1 §6.3) — and collects every length problem found, the
 * same "report every problem, not just the first" convention
 * `../extractor/response.ts` uses. Throws `ResolverInputError` if any is found.
 */
export function assertUntrustedInputWithinBounds(input: {
  application: { brandName: string; classType: string };
  extraction: {
    brand_name: { value: string | null; evidence: string; alternates: string[] };
    class_type: { value: string | null; evidence: string; alternates: string[] };
    alcohol_content: { value: string | null; evidence: string; alternates: string[] };
    net_contents: { value: string | null; evidence: string; alternates: string[] };
    beverage_type: { value: string | null; evidence: string; alternates: string[] };
    government_warning: { transcription: string | null; evidence: string };
  };
}): void {
  const problems: string[] = [];

  checkLength(input.application.brandName, "application.brandName", SHORT_FIELD_MAX_LENGTH, problems);
  checkLength(input.application.classType, "application.classType", SHORT_FIELD_MAX_LENGTH, problems);

  for (const field of ["brand_name", "class_type", "alcohol_content", "net_contents", "beverage_type"] as const) {
    const extracted = input.extraction[field];
    checkLength(extracted.value, `extraction.${field}.value`, SHORT_FIELD_MAX_LENGTH, problems);
    checkLength(extracted.evidence, `extraction.${field}.evidence`, SHORT_FIELD_MAX_LENGTH, problems);
    checkAlternates(extracted.alternates, `extraction.${field}.alternates`, SHORT_FIELD_MAX_LENGTH, problems);
  }

  checkLength(
    input.extraction.government_warning.transcription,
    "extraction.government_warning.transcription",
    LONG_FIELD_MAX_LENGTH,
    problems,
  );
  checkLength(
    input.extraction.government_warning.evidence,
    "extraction.government_warning.evidence",
    LONG_FIELD_MAX_LENGTH,
    problems,
  );

  if (problems.length > 0) {
    throw new ResolverInputError(problems);
  }
}
