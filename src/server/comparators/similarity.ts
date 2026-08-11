/**
 * A character-level similarity score for the fuzzy brand/class-type
 * comparator (LH-013 / TRO-463, CP-1 §5.3 `AMBIGUOUS_BRAND`'s `>= 0.95` /
 * `< 0.95` table). CP-1 names the threshold; it does not name an algorithm.
 * Normalized Levenshtein (edit) distance is a standard, well-understood
 * choice for "how close are these two short strings" — no ML, no external
 * dependency, and its behavior is easy to explain in a hearing.
 */

/** The classic dynamic-programming edit distance: the minimum number of
 * single-character insertions, deletions, or substitutions to turn `a` into
 * `b`. Operates on JS UTF-16 code units, which is adequate here — both
 * inputs already passed through `normalize.ts`'s NFKC/diacritic-stripping
 * pipeline, so surrogate-pair or combining-mark edge cases do not reach
 * this function in the brand/class comparator's own call path. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          currentRow[j - 1] + 1, // insertion
          previousRow[j] + 1, // deletion
          previousRow[j - 1] + substitutionCost, // substitution
        ),
      );
    }
    previousRow = currentRow;
  }
  return previousRow[b.length];
}

/**
 * `1 - (editDistance / longerLength)` — 1.0 for identical strings, 0.0 when
 * every character differs, and two empty strings are defined as identical
 * (nothing to disagree about).
 */
export function similarity(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLength;
}
