/**
 * Wire types for `POST /api/extract` (TRO-576) — the extract-only endpoint
 * behind the verify form's auto-fill. The response is a form-shaped
 * prefill, not the raw extraction: the server does all parsing (ABV text
 * to a number, net contents to value + unit), so the client applies values
 * without interpreting label text.
 *
 * Error kinds reuse the verify route's vocabulary on purpose — one word,
 * one meaning, across both endpoints. `EXTRACTION` here means the Haiku
 * call itself failed; an image the extractor read but found illegible is
 * NOT an error — it is the `"unreadable"` outcome below, a designed state
 * (TH-R20).
 */

export const EXTRACT_ERROR_KINDS = [
  "VALIDATION",
  "IMAGE",
  "EXTRACTION",
  "SERVICE",
  "RATE_LIMITED",
  "BUDGET_EXHAUSTED",
] as const;

export type ExtractErrorKind = (typeof EXTRACT_ERROR_KINDS)[number];

export interface ExtractErrorResponse {
  error: { kind: ExtractErrorKind; message: string };
}

/** The prefill values for the verify form's five inputs. A `null` field
 * means the extractor could not read that field — the form leaves it
 * alone. Never a guess: an unreadable field stays empty for the agent. */
export interface ExtractPrefillFields {
  /** One of the form's radio values ("beer" | "wine" | "spirits"), or
   * `null` when the extractor's reading matches none of them. */
  beverageType: string | null;
  brandName: string | null;
  classType: string | null;
  /** Parsed to a number the ABV input accepts (0-100), via the same
   * `parseAbv`/`abvAsPercent` grammar the comparator uses. */
  alcoholContentPercent: number | null;
  /** Parsed via the comparator's own `parseNetContents` grammar. */
  netContentsValue: number | null;
  /** One of the form's unit options ("mL" | "L" | "fl oz"). */
  netContentsUnit: string | null;
}

export interface ExtractSuccessResponse {
  /** `"prefill"`: the photo was readable; `fields` carries whatever the
   * extractor read. `"unreadable"`: the extractor judged the photo
   * illegible; every field is `null` and `message` says so in plain
   * words. Both are 200s — an unreadable photo is a designed outcome,
   * not a failure of this endpoint. */
  outcome: "prefill" | "unreadable";
  /** Set only for `"unreadable"`. */
  message: string | null;
  fields: ExtractPrefillFields;
}
