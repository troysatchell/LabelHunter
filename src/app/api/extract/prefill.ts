/**
 * Maps a Haiku extraction to the verify form's prefill shape (TRO-576).
 * Pure and unit-testable: label text in, form values out.
 *
 * Parsing reuses the comparators' own grammars (`parseAbv`,
 * `parseNetContents`) — the exact readers the verify comparison itself
 * trusts. This module never invents a second parser for the same text.
 *
 * No confidence threshold gates the prefill. The extractor already
 * answers `value: null` for a field it cannot read, and the form marks
 * every prefilled value "Read from your photo" until the agent edits it.
 * The human confirms; a threshold here would be an invented metric
 * deciding silently what the agent gets to see.
 */
import { BEVERAGE_TYPES } from "../../../lib/db/enums";
import { abvAsPercent, parseAbv } from "../../../server/comparators/abv";
import { parseNetContents } from "../../../server/comparators/net-contents";
import type { HaikuExtractionResult } from "../../../server/extractor/types";
import type { ExtractPrefillFields, ExtractSuccessResponse } from "./types";

export const UNREADABLE_MESSAGE =
  "LabelHunter could not read this photo clearly. Fill in the fields yourself.";

/** The comparator's lowercase units, mapped to the form's own option
 * spellings (`NET_CONTENTS_UNIT_OPTIONS`, `../verify/types.ts`). */
const DISPLAY_UNIT: Record<string, string> = {
  ml: "mL",
  l: "L",
  "fl oz": "fl oz",
};

function readableText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const EMPTY_FIELDS: ExtractPrefillFields = {
  beverageType: null,
  brandName: null,
  classType: null,
  alcoholContentPercent: null,
  netContentsValue: null,
  netContentsUnit: null,
};

export function mapExtractionToPrefill(extraction: HaikuExtractionResult): ExtractSuccessResponse {
  if (extraction.image_quality.legible === "no") {
    return { outcome: "unreadable", message: UNREADABLE_MESSAGE, fields: EMPTY_FIELDS };
  }

  // Beverage type: exact match against the radio values only. The prompt
  // constrains the extractor to "beer, wine, or spirits", but a free-text
  // drift ("sparkling wine") must never silently pick a radio — `null`
  // leaves the choice to the agent.
  const beverageRaw = readableText(extraction.beverage_type.value)?.toLowerCase() ?? null;
  const beverageType =
    beverageRaw !== null && (BEVERAGE_TYPES as readonly string[]).includes(beverageRaw) ? beverageRaw : null;

  // ABV: the label states text ("45% Alc./Vol. (90 Proof)"); the form
  // wants one number. Same grammar and proof-halving the comparator uses.
  // A number outside the input's own 0-100 bounds is dropped, not
  // clamped — a misread must not become a plausible-looking value.
  const abvText = readableText(extraction.alcohol_content.value);
  const abvParsed = abvText !== null ? abvAsPercent(parseAbv(abvText)) : null;
  const alcoholContentPercent = abvParsed !== null && abvParsed >= 0 && abvParsed <= 100 ? abvParsed : null;

  // Net contents: "750 mL" -> value + the form's unit spelling. A number
  // with an unrecognized unit prefills nothing — half a quantity is worse
  // than an empty field.
  const netText = readableText(extraction.net_contents.value);
  const netParsed = netText !== null ? parseNetContents(netText) : null;
  const netUnit = netParsed ? (DISPLAY_UNIT[netParsed.unit] ?? null) : null;

  return {
    outcome: "prefill",
    message: null,
    fields: {
      beverageType,
      brandName: readableText(extraction.brand_name.value),
      classType: readableText(extraction.class_type.value),
      alcoholContentPercent,
      netContentsValue: netParsed !== null && netUnit !== null ? netParsed.value : null,
      netContentsUnit: netUnit,
    },
  };
}
