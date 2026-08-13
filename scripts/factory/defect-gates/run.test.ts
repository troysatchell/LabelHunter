import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocument, changedTsFiles } from "./run";
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

/** Runs a git command in a scratch repo, using an explicit test identity. */
function scratchGit(cwd: string, args: string): string {
  return execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd, encoding: "utf8" }).trim();
}

describe("changedTsFiles", () => {
  it("excludes a deleted path and does not crash on one, but keeps an added path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-run-"));
    try {
      scratchGit(dir, "init -q");
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "add a"');
      const baseSha = scratchGit(dir, "rev-parse HEAD");

      // Branch: delete a.ts (the ENOENT trigger — Critical 1), add b.ts.
      execSync(`rm ${join(dir, "a.ts")}`);
      writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
      scratchGit(dir, "add -A");
      scratchGit(dir, 'commit -q -m "delete a, add b"');

      const changed = changedTsFiles(dir, baseSha);
      expect(changed).not.toContain("a.ts");
      expect(changed).toContain("b.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a modified path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-run-"));
    try {
      scratchGit(dir, "init -q");
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "add a"');
      const baseSha = scratchGit(dir, "rev-parse HEAD");

      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "modify a"');

      expect(changedTsFiles(dir, baseSha)).toEqual(["a.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
