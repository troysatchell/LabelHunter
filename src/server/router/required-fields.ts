/**
 * The required-field-by-beverage-type table (CP-1 §5.3, `MISSING_REQUIRED_FIELD`).
 */
import type { BeverageType, RouterFieldKey } from "./types";

/**
 * `"verify"` marks a cell CP-1 does not settle. Kept as its own value,
 * distinct from `"required"` / `"not_required"`, so the ambiguity stays
 * visible in code instead of being silently resolved one way or the other.
 * See `isFieldRequired` for how the router routes on it today.
 */
export type FieldRequirement = "required" | "not_required" | "verify";

/**
 * Brand, class/type, net contents, and the government warning are required
 * for every beverage type. Alcohol content is required for spirits.
 *
 * **Beer — verified, VERIFY closed.** 27 CFR 7.65(a): "Alcohol content ...
 * may be stated on any malt beverage label, unless prohibited by State
 * law." Federally, an ABV statement on a malt beverage label is optional,
 * not required — this system models the federal (TTB/COLA) rule only, not
 * state law, matching PRD §2's scope. `not_required`, cited.
 *
 * **Wine — verified, still `verify`, and here is why it cannot become a
 * plain boolean.** 27 CFR 4.36(a): mandatory for wine over 14% ABV;
 * optional for wine at or under 14% ABV ONLY WHEN the class/type
 * designation "table wine" or "light wine" appears on the brand label. The
 * real rule is conditional on the wine's OWN ABV value and its class/type
 * wording — `FieldRequirement` is a flat per-beverage-type cell, with no
 * way to express "required unless X and Y both hold" without a bigger
 * schema change than this ticket's scope. Kept as `verify` (which
 * `isFieldRequired` reads as required — CP-1 §5.3's own fail-safe pattern):
 * a table wine that omits the statement gets flagged for a human to check,
 * which is a safe outcome, not a wrong one. Closing this fully is a
 * follow-up, not a LH-013 deliverable — the conditional rule itself is now
 * verified and cited, even though the mechanism to encode it is not built.
 */
export const REQUIRED_FIELD_TABLE: Record<BeverageType, Record<RouterFieldKey, FieldRequirement>> = {
  beer: {
    brand_name: "required",
    class_type: "required",
    alcohol_content: "not_required",
    net_contents: "required",
    government_warning: "required",
  },
  wine: {
    brand_name: "required",
    class_type: "required",
    alcohol_content: "verify",
    net_contents: "required",
    government_warning: "required",
  },
  spirits: {
    brand_name: "required",
    class_type: "required",
    alcohol_content: "required",
    net_contents: "required",
    government_warning: "required",
  },
};

/**
 * Whether `requirement` counts as required for the `MISSING_REQUIRED_FIELD`
 * check. A `"verify"` cell is not a confirmed regulatory answer, but the
 * router still needs one boolean to route on today. It treats `"verify"` as
 * required — the fail-safe choice, matching this same document's own
 * pattern elsewhere (CP-1 §5.3 `AMBIGUOUS_ABV`: "a default of zero fails
 * safe: nothing is silently accepted before the real value is verified").
 * Do not read a `true` result here as a settled TTB position.
 */
export function isFieldRequired(requirement: FieldRequirement): boolean {
  return requirement !== "not_required";
}
