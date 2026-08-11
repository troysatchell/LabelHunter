/**
 * A minimal word-boundary text check, for the CP-1 §4.4 rule 2 anti-
 * hallucination override only (evidence must support the value at a word
 * boundary, not merely as a substring — `normalize("45")` is a substring of
 * `normalize("145")`).
 *
 * This is NOT LH-013's real normalization pipeline (CP-1 §5.3
 * `AMBIGUOUS_BRAND`): Unicode NFKC, casefold, apostrophe folding, diacritic
 * stripping, and punctuation dropping, in that fixed order, feeding a fuzzy
 * similarity score. That pipeline decides MATCH vs REVIEW for judgment
 * fields. This one only answers a narrower question — "does the evidence
 * contain this exact word" — as a cheap hallucination check, and never
 * decides a field's verdict on its own.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Casefold and collapse whitespace. Deliberately does not fold apostrophes
 * or strip diacritics — see the file comment. */
export function normalizeForBoundaryMatch(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * True when `normalize(value)` appears in `normalize(evidence)` with a
 * non-alphanumeric character (or a string edge) on both sides — a plain
 * substring check would let `"tom"` match inside `"tomintoul"`. An empty
 * `value` never matches; there is nothing to support.
 *
 * Uses lookaround, not `\b`: `\b`'s boundary depends on the CHARACTER AT
 * THE EDGE OF THE PATTERN ITSELF, so a value ending in punctuation (a
 * government warning transcription ends in a period) puts a non-word
 * character on both sides of that `\b` and it never matches, even for an
 * exact, legitimate reading. Lookaround checks the character OUTSIDE the
 * match instead, which is the actual question this override asks.
 *
 * The lookaround uses Unicode letter/number property escapes (`\p{L}`,
 * `\p{N}`, with the `u` flag), not `[a-z0-9]` — an ASCII-only class would
 * fail to exclude an accented letter (a brand like "José") from the
 * boundary, either missing a real hallucination or rejecting a genuine
 * read. This still is not diacritic folding (a genuinely accented and an
 * unaccented spelling stay distinct) — that stays LH-013's job.
 */
export function evidenceSupportsTextValue(value: string, evidence: string): boolean {
  const normalizedValue = normalizeForBoundaryMatch(value);
  if (normalizedValue.length === 0) return false;
  const normalizedEvidence = normalizeForBoundaryMatch(evidence);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(normalizedValue)}(?![\\p{L}\\p{N}])`, "u");
  return pattern.test(normalizedEvidence);
}
