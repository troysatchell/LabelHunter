import type { Rule, RuleContext, RuleResult } from "./types";

/**
 * Converts a thrown value to a message string, without itself throwing.
 *
 * `String(x)` throws when `x` has no usable conversion — an object made
 * with `Object.create(null)`, or one whose own `toString` throws. That
 * throw would escape `runRules`'s own `catch` block below and abort the
 * whole `.map()`, so one rule's crash would silently discard every other
 * rule's result too. This function must never let that happen.
 */
function safeErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    return "non-Error thrown value could not be converted to a string";
  }
}

/**
 * Runs every rule and returns one result each.
 *
 * A rule that throws produces status "error", never "pass". A crashed rule
 * that read as clean would repeat the exact defect this subsystem exists to
 * answer: absence must never look like cleanliness.
 */
export function runRules(rules: Rule[], ctx: RuleContext): RuleResult[] {
  return rules.map((rule) => {
    try {
      const findings = rule.check(ctx);
      return {
        id: rule.meta.id,
        version: rule.meta.version,
        status: findings.length > 0 ? "fail" : "pass",
        findings,
        error: null,
      };
    } catch (cause) {
      return {
        id: rule.meta.id,
        version: rule.meta.version,
        status: "error",
        findings: [],
        error: safeErrorMessage(cause),
      };
    }
  });
}
