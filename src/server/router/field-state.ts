/**
 * `FieldState` — one field's condition after the §4.4 overrides, in the
 * uniform shape the rest of the router routes on. Building this once, per
 * field, keeps the field-shape difference between the government warning
 * (no `value`, has `present`) and the other four fields (`value`, no
 * `present`) contained to one place instead of leaking into every rule.
 */
import type { FieldRequirement } from "./required-fields";
import type { RouterFieldKey } from "./types";

export interface FieldState {
  field: RouterFieldKey;
  requirement: FieldRequirement;
  required: boolean;
  /** Sanitized value after the §4.4 overrides. Always `null` for
   * `government_warning` — it has no `value` (CP-1 §3.4); check `present`
   * instead. */
  value: string | null;
  /** Only meaningful for `government_warning`. `null` for every other
   * field. */
  present: boolean | null;
  evidence: string;
  /** Sanitized confidence after the §4.4 overrides. */
  confidence: number;
  overrideRejected: boolean;
}

/**
 * Field-shape-aware absence check (CP-1 §5.3, `MISSING_REQUIRED_FIELD`). A
 * uniform `value === null` check would never fire for `government_warning`,
 * since that field has no `value` at all — `undefined === null` is `false`
 * in TypeScript, so the check would silently pass a warning the router
 * never actually examined. This checks the field-appropriate predicate:
 * `present === null || present === false` for the warning, `value === null`
 * for everything else.
 */
export function isFieldAbsent(state: FieldState): boolean {
  if (state.field === "government_warning") {
    return state.present === null || state.present === false;
  }
  return state.value === null;
}
