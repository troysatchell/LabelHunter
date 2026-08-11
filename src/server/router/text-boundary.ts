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

/**
 * NFC-composes, casefolds, and collapses whitespace. Deliberately does not
 * strip diacritics (an accented and unaccented spelling stay distinct — see
 * the file comment).
 *
 * The NFC step (PR #8 review) is NOT diacritic folding — it does not merge
 * an accented and an unaccented spelling. It merges two ENCODINGS of the
 * SAME accented spelling: a precomposed letter (one codepoint, e.g. U+00E9
 * for "é") and its canonically equivalent decomposed form (a base letter
 * plus a separate combining mark, e.g. U+0065 + U+0301). Unicode defines
 * these as the identical text; without this call, `"José"` (precomposed)
 * and `"José"` (decomposed) produced DIFFERENT normalized strings and
 * could not word-boundary-match each other, even though both spell the
 * identical word — verified directly:
 * `"é".normalize("NFC") === "é"` is `true`. This runs before
 * `\p{M}` ever matters (below): NFC composes away most combining-mark
 * sequences that have a precomposed equivalent, but not all Unicode
 * sequences do, so the `\p{M}` lookaround stays necessary for the residual
 * cases NFC does not merge (TRO-504 item 1).
 *
 * It DOES fold German ß to "ss" (TRO-504 item 2): `toLowerCase()` alone
 * leaves ß untouched, so a value read as "STRASSE" (German's all-caps
 * convention has traditionally had no uppercase ß) would not word-boundary-
 * match evidence spelled "Straße" without this. This is a targeted, single-
 * character-class fix, not general Unicode case folding.
 */
export function normalizeForBoundaryMatch(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[ßẞ]/g, "ss")
    .trim()
    .replace(/\s+/g, " ");
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
 *
 * It also includes `\p{M}` (combining marks) alongside `\p{L}\p{N}`
 * (TRO-504 item 1). Without it, an NFD-decomposed accented word — a base
 * letter followed by a separate combining-mark codepoint, e.g. "e" + U+0301
 * COMBINING ACUTE ACCENT for "é" — reads as ending right after the base
 * letter: the combining mark is neither `\p{L}` nor `\p{N}`, so the
 * lookahead sees "not a letter" and wrongly calls that a word boundary. An
 * unaccented value like "Jose" would then falsely pass as supported by
 * evidence that actually reads the accented word "José" — the two are
 * different spellings, and this check exists to catch exactly that kind of
 * near-miss, not wave it through. Adding `\p{M}` makes a combining mark
 * count as still part of the same word, so the boundary test correctly
 * fails there instead.
 */
export function evidenceSupportsTextValue(value: string, evidence: string): boolean {
  const normalizedValue = normalizeForBoundaryMatch(value);
  if (normalizedValue.length === 0) return false;
  const normalizedEvidence = normalizeForBoundaryMatch(evidence);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escapeRegExp(normalizedValue)}(?![\\p{L}\\p{N}\\p{M}])`, "u");
  return pattern.test(normalizedEvidence);
}
