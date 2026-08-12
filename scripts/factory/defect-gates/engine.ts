import type { Rule, RuleContext, RuleResult } from "./types";

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
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
}
