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
  /** True for a synthesized token holding required words the actual text
   * OMITS with no replacement (`text` carries the missing words). An
   * omission is a violation a reviewer cannot see in the actual text
   * alone — without this, a warning that silently drops a clause would
   * show zero marks (CodeRabbit finding, TRO-582 review round 1).
   * Substitutions do NOT produce one: the inserted word's own mark
   * already points at the spot, and doubling it with a missing-words
   * indicator would bury the signal in noise. */
  omitted?: boolean;
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
  // Required words dropped since the last emitted token. Whether they
  // surface as an omission marker depends on what comes next: an aligned
  // word (pure deletion — emit the marker) or an inserted word
  // (substitution — the insertion's own mark carries the signal).
  let pendingOmission: string[] = [];

  function flushOmissionBefore(nextDiffers: boolean) {
    // Emitted only before an ALIGNED word (or at the end): a pure
    // deletion. Before an inserted word the run is a substitution, and
    // the insertion's own mark carries the signal — the run is dropped.
    if (pendingOmission.length > 0 && !nextDiffers) {
      result.push({ text: pendingOmission.join(" "), differs: true, omitted: true });
    }
    pendingOmission = [];
  }

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (tokensEqual(requiredTokens[i], actualTokens[j])) {
      flushOmissionBefore(false);
      result.push({ text: actualTokens[j], differs: false });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      pendingOmission.push(requiredTokens[i]);
      i++;
    } else {
      flushOmissionBefore(true);
      result.push({ text: actualTokens[j], differs: true });
      j++;
    }
  }
  while (j < n) {
    flushOmissionBefore(true);
    result.push({ text: actualTokens[j], differs: true });
    j++;
  }
  while (i < m) {
    pendingOmission.push(requiredTokens[i]);
    i++;
  }
  // A trailing omission has no following insertion to represent it — a
  // truncated warning (the common real case: a dropped final clause)
  // must surface.
  flushOmissionBefore(false);
  return result;
}
