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
 * for every beverage type. Alcohol content is required for spirits; CP-1
 * marks it **VERIFY** for beer and wine — TTB may make the alcohol
 * statement optional for some beer and wine products, but CP-1 does not
 * commit to the exact rule (§5.3: "The mechanism is settled here; the
 * values are not"). LH-013 verifies the real rule against ttb.gov and
 * corrects this table; this ticket implements the mechanism only.
 */
export const REQUIRED_FIELD_TABLE: Record<BeverageType, Record<RouterFieldKey, FieldRequirement>> = {
  beer: {
    brand_name: "required",
    class_type: "required",
    alcohol_content: "verify",
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
