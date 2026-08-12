import { describe, expect, it } from "vitest";
import { runRules } from "./engine";
import type { Finding, Rule, RuleContext } from "./types";

function stubRule(id: string, findings: Finding[]): Rule {
  return {
    meta: {
      id,
      version: 1,
      scope: "changeset",
      severity: "fail",
      repairability: "manual",
      registries: [],
      activatedAt: null,
      pinExpiresAfterMainCommits: 25,
      replayCorpus: [],
    },
    check: () => findings,
  };
}

const ctx: RuleContext = { files: [], repoRoot: "/repo", registries: {} };

describe("runRules", () => {
  it("reports pass for a rule that finds nothing", () => {
    const [result] = runRules([stubRule("quiet", [])], ctx);
    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("reports fail for a rule that finds something", () => {
    const finding: Finding = {
      ruleId: "noisy",
      ruleVersion: 1,
      file: "a.ts",
      line: 1,
      identity: "abc",
      message: "boom",
      repairability: "manual",
      exemptedBy: null,
    };
    const [result] = runRules([stubRule("noisy", [finding])], ctx);
    expect(result.status).toBe("fail");
    expect(result.findings).toHaveLength(1);
  });

  it("reports error, never pass, when a rule throws", () => {
    const broken: Rule = {
      ...stubRule("broken", []),
      check: () => {
        throw new Error("rule crashed");
      },
    };
    const [result] = runRules([broken], ctx);
    expect(result.status).toBe("error");
    expect(result.error).toContain("rule crashed");
  });

  it("runs every rule even when one throws", () => {
    const broken: Rule = {
      ...stubRule("broken", []),
      check: () => {
        throw new Error("nope");
      },
    };
    const results = runRules([broken, stubRule("quiet", [])], ctx);
    expect(results.map((r) => r.status)).toEqual(["error", "pass"]);
  });
});
