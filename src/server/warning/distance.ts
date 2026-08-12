/**
 * Edit distance for the warning subsystem's own exact-comparison algorithm
 * (LH-020 / TRO-468, CP-2 §3.3 step 6, §5.5).
 *
 * A self-contained copy, not an import from `../comparators/similarity.ts`
 * — CP-1 §Q11 / standing rule 11: the judgment regime (TH-R8) and the exact
 * regime (TH-R9) share no helpers, including a generic algorithm like this
 * one, so the "own component, no shared helpers" property holds with zero
 * exceptions rather than one quietly-accepted one.
 */

/** The classic dynamic-programming edit distance: the minimum number of
 * single-character insertions, deletions, or substitutions to turn `a`
 * into `b`. Operates on JS UTF-16 code units — both sides reaching this
 * function have already passed through `normalizeTransport`/`foldCase`
 * (`wording-compare.ts`), and the canonical string is pure ASCII
 * (`canonical.test.ts`), so no surrogate-pair edge case reaches this
 * function in this module's own call path. */
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
