/**
 * Word-level diff for the government-warning display (TRO-582).
 *
 * The reviewer's job on a warning row is "which words differ from the
 * statute?" — and until this ticket the card handed them two 40-word
 * blobs to compare by eye (TH-R3 fails that for everyone, not only the
 * 73-year-old benchmark). This module answers the question mechanically:
 * a longest-common-subsequence alignment over whitespace-split tokens,
 * marking the tokens of the ACTUAL text that do not align with the
 * required text.
 *
 * Display-only. The verdict never comes from here — the comparator
 * (`src/server/warning/`) owns the judgment, with its own normalization
 * and near-miss rules. This diff deliberately compares the raw strings
 * the reviewer actually sees, so what is marked is what is visible.
 */

export interface DiffToken {
  text: string;
  /** True when this token of the actual text does not align with the
   * required text — a changed or inserted word. */
  differs: boolean;
}

/** Case- and trailing-punctuation-insensitive token equality: "General,"
 * aligns with "General" and "GOVERNMENT" aligns with "Government". The
 * marks land on WORD differences only, on purpose. A casing violation is
 * already carried by the comparator's caps check and its reason line
 * ("must print in capital letters") — marking every token of a
 * title-case warning as different would bury the wording signal this
 * diff exists to surface. */
function tokensEqual(a: string, b: string): boolean {
  const strip = (t: string) => t.toLowerCase().replace(/[.,;:!?()"'“”‘’]+$/g, "");
  return strip(a) === strip(b);
}

/**
 * Aligns `actual` against `required` and returns `actual`'s tokens with
 * each marked as aligned (`differs: false`) or not (`differs: true`).
 * Whitespace is collapsed; the caller renders tokens joined by single
 * spaces.
 */
export function diffWords(required: string, actual: string): DiffToken[] {
  const requiredTokens = required.split(/\s+/).filter(Boolean);
  const actualTokens = actual.split(/\s+/).filter(Boolean);

  // Standard LCS table over tokens. Sizes here are ~40x40 — trivial.
  const m = requiredTokens.length;
  const n = actualTokens.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = tokensEqual(requiredTokens[i], actualTokens[j])
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const result: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (tokensEqual(requiredTokens[i], actualTokens[j])) {
      result.push({ text: actualTokens[j], differs: false });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++; // a required word the actual text dropped — nothing to mark here
    } else {
      result.push({ text: actualTokens[j], differs: true });
      j++;
    }
  }
  while (j < n) {
    result.push({ text: actualTokens[j], differs: true });
    j++;
  }
  return result;
}
