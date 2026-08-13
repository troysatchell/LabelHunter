import { describe, expect, it } from "vitest";
import { buildDocument } from "./run";
import type { Finding, RuleResult } from "./types";

function finding(identity: string): Finding {
  return {
    ruleId: "r", ruleVersion: 1, file: "src/a.ts", line: 1, identity,
    message: "m", repairability: "assisted", exemptedBy: null,
  };
}

const pin = {
  activatedAt: null, mergeBaseIsAfterActivation: true,
  mainCommitsElapsed: null, expiresAfter: 25, mode: "blocking" as const,
};

describe("buildDocument", () => {
  it("marks a rule failed when the branch introduced a finding", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "fail", findings: [finding("new")], error: null },
    ];
    const doc = buildDocument({
      results, baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].status).toBe("fail");
    expect(doc.rules[0].introduced).toHaveLength(1);
    expect(doc.exitCode).toBe(1);
  });

  it("does not fail on a pre-existing finding", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "fail", findings: [finding("old")], error: null },
    ];
    const doc = buildDocument({
      results, baselines: { r: [finding("old")] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].status).toBe("pass");
    expect(doc.rules[0].preExisting).toBe(1);
    expect(doc.exitCode).toBe(0);
  });

  it("does not fail a report-only rule, and records why", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "fail", findings: [finding("new")], error: null },
    ];
    const doc = buildDocument({
      results, baselines: { r: [] },
      pins: { r: { ...pin, mode: "report-only", activatedAt: "abc", mergeBaseIsAfterActivation: false } },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].mode).toBe("report-only");
    expect(doc.rules[0].introduced).toHaveLength(1);
    expect(doc.exitCode).toBe(0);
  });

  it("fails the gate when a rule errored", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "error", findings: [], error: "boom" },
    ];
    const doc = buildDocument({
      results, baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].status).toBe("error");
    expect(doc.exitCode).toBe(1);
  });
});
