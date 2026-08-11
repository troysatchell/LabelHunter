/**
 * The production field comparators (LH-013 / TRO-463, CP-1 §5.3, TH-R8,
 * TH-R11) — the ONE import site the verify pipeline (LH-015 / TRO-465, in
 * flight on a sibling branch) wires into the router's `routeLabel`
 * (`../router/index.ts`) in place of `../router/test-support.ts`'s
 * placeholder comparators.
 *
 *   import { productionComparators } from "@/server/comparators";
 *   routeLabel(extraction, application, productionComparators, warningResult, preprocessing);
 *
 * `government_warning` has no comparator here — it is LH-020's own
 * CP-2-gated subsystem (`../router/types.ts`'s `WarningComparatorResult`),
 * deliberately kept out of this module: CP-1 §2.3/§Q11 keeps the judgment
 * regime (this file) and the exact regime (the warning) apart in code, with
 * no shared helpers between them.
 */
import type { FieldComparators } from "../router/types";
import { compareAbv } from "./abv";
import { compareBrandOrClass } from "./brand";
import { compareNetContents } from "./net-contents";

export const productionComparators: FieldComparators = {
  brand_name: compareBrandOrClass,
  class_type: compareBrandOrClass,
  alcohol_content: compareAbv,
  net_contents: compareNetContents,
};

export { normalizeForFuzzyMatch } from "./normalize";
export { levenshteinDistance, similarity } from "./similarity";
export { BRAND_CLASS_MATCH_THRESHOLD, compareBrandOrClass } from "./brand";
export { abvAsPercent, compareAbv, parseAbv, proofMatchesPercent, type ParsedAbv } from "./abv";
export {
  compareNetContents,
  convertNetContentsToMl,
  NET_CONTENTS_COMPARE_TOLERANCE_FRACTION,
  normalizeNetContentsUnit,
  parseNetContents,
  type NetContentsUnit,
  type ParsedNetContents,
} from "./net-contents";
