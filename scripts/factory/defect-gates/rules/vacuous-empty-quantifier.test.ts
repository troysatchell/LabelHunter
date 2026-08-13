import { describe, expect, it } from "vitest";
import rule from "./vacuous-empty-quantifier";
import type { RuleContext } from "../types";

function check(source: string) {
  const ctx: RuleContext = { files: [], repoRoot: "/repo", registries: {} };
  return rule.checkSource("src/sample.ts", source, ctx);
}

describe("vacuous-empty-quantifier", () => {
  it("flags .every reaching a return decision on an unguarded collection", () => {
    const findings = check(`
      function deriveOutcome(fields: F[]) {
        return { outcome: fields.every(isResolved) ? "resolved" : "partial" };
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("every");
  });

  it("flags .every used directly as an if condition", () => {
    const findings = check(`
      function gate(ids: string[]) {
        if (ids.every(valid)) { return "ok"; }
        return "no";
      }
    `);
    expect(findings).toHaveLength(1);
  });

  it("does not flag when a length guard precedes the quantifier", () => {
    const findings = check(`
      function deriveOutcome(fields: F[]) {
        if (!fields.length) throw new Error("empty");
        return fields.every(isResolved);
      }
    `);
    expect(findings).toEqual([]);
  });

  it("does not flag a non-empty array literal", () => {
    const findings = check(`
      function gate() {
        return [a, b].every(check);
      }
    `);
    expect(findings).toEqual([]);
  });

  it("does not flag a quantifier used only for display", () => {
    const findings = check(`
      function label(items: I[]) {
        const text = items.every(done) ? "all done" : "in progress";
        return text.length;
      }
    `);
    expect(findings).toEqual([]);
  });

  it("flags a bare-statement ternary that chooses a side effect", () => {
    const findings = check(`
      function gate(items: I[]) {
        items.every(p) ? doA() : doB();
      }
    `);
    expect(findings).toHaveLength(1);
  });

  it("reports the enclosing function in the identity, so two call sites differ", () => {
    const findings = check(`
      function one(xs: X[]) { return xs.every(p); }
      function two(xs: X[]) { return xs.every(p); }
    `);
    expect(findings).toHaveLength(2);
    expect(findings[0].identity).not.toBe(findings[1].identity);
  });

  it("flags a quantifier's result assigned to a variable, then returned", () => {
    const findings = check(`
      function gate(xs: X[]) {
        const ok = xs.every(p);
        return ok;
      }
    `);
    expect(findings).toHaveLength(1);
  });

  it("does not flag a quantifier's result assigned to a variable used only for display", () => {
    // Same case as "does not flag a quantifier used only for display"
    // above, restated directly against the one-hop variable read.
    // text.length derives from text. It is not a direct read of text itself.
    const findings = check(`
      function label(items: I[]) {
        const text = items.every(done) ? "all done" : "in progress";
        return text.length;
      }
    `);
    expect(findings).toEqual([]);
  });

  it("flags a quantifier's result assigned to a variable, then returned via object shorthand", () => {
    // TRO-464 / response.ts's real historical shape: `return { outcome, fields };`.
    // Shorthand is a ShorthandPropertyAssignment node. That is a different
    // AST kind than the explicit `{ outcome: outcome }` PropertyAssignment.
    // Both are the same sink — a property assignment, not a transforming
    // expression.
    const findings = check(`
      function deriveOutcome(fields: F[]) {
        const outcome = fields.every(p) ? "resolved" : "needs-human";
        return { outcome, fields };
      }
    `);
    expect(findings).toHaveLength(1);
  });

  it("does not flag a quantifier's result assigned to a variable that is never read again", () => {
    const findings = check(`
      function gate(xs: X[]) {
        const unused = xs.every(p);
        return 42;
      }
    `);
    expect(findings).toEqual([]);
  });

  it("does not flag a seeded .reduce — the seed is the defined answer on empty", () => {
    const findings = check(`
      function total(xs: X[]) {
        return xs.reduce((n, x) => n + x, 0);
      }
    `);
    expect(findings).toEqual([]);
  });

  it("flags an unseeded .reduce — it throws on an empty collection", () => {
    const findings = check(`
      function total(xs: X[]) {
        return xs.reduce((n, x) => n + x);
      }
    `);
    expect(findings).toHaveLength(1);
  });

  it("does not flag .some — a false result is the safe default on empty", () => {
    const findings = check(`
      function gate(xs: X[]) {
        return xs.some(p);
      }
    `);
    expect(findings).toEqual([]);
  });

  it("still flags .every reaching a return — regression guard on the core case", () => {
    const findings = check(`
      function gate(xs: X[]) {
        return xs.every(p);
      }
    `);
    expect(findings).toHaveLength(1);
  });
});
