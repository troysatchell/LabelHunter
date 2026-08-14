import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocument, changedTsFiles, formatReportLines } from "./run";
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

  it("throws a named error when a result's rule id has no matching pin decision", () => {
    // A missing pins entry previously threw a bare "Cannot read properties
    // of undefined (reading 'mode')" with no rule id attached — this names
    // the rule so the real cause (a caller bug, not a git failure) is
    // obvious immediately.
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "pass", findings: [], error: null },
    ];
    expect(() =>
      buildDocument({
        results, baselines: { r: [] }, pins: {},
        baseRef: "main", baseSha: "s", mergeBase: "m",
      }),
    ).toThrow(/no pin decision for rule 'r'/);
  });
});

describe("formatReportLines", () => {
  it("prints nothing for a clean pass with no findings", () => {
    const doc = buildDocument({
      results: [{ id: "r", version: 1, status: "pass", findings: [], error: null }],
      baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(formatReportLines(doc)).toEqual([]);
  });

  it("prints the rule's own error detail for a rule with status error", () => {
    // Previously, a rule that errored with no introduced findings (the pin
    // resolution failure path, not a findings-based failure) printed
    // nothing at all — exit code 1 with a blank report, and no clue why.
    const doc = buildDocument({
      results: [{ id: "r", version: 1, status: "error", findings: [], error: "boom: pin unresolved" }],
      baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    const lines = formatReportLines(doc);
    expect(lines.some((l) => l.includes("boom: pin unresolved"))).toBe(true);
    expect(lines.some((l) => l.includes("r"))).toBe(true);
  });

  it("still prints each introduced finding alongside an error rule's own detail", () => {
    const doc = buildDocument({
      results: [
        { id: "r", version: 1, status: "error", findings: [finding("new")], error: "boom" },
      ],
      baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    const lines = formatReportLines(doc);
    expect(lines.some((l) => l.includes("boom"))).toBe(true);
    expect(lines.some((l) => l.includes("src/a.ts:1"))).toBe(true);
  });
});

/**
 * Runs a git command in a scratch repo, using an explicit test identity.
 *
 * Argv, not a shell string — the same discipline `run.ts`'s own `sh` helper
 * documents: a shell string hands metacharacters in any argument to
 * `/bin/sh -c`, where a commit message containing a quote or `$(...)` would
 * be parsed, not passed through literally.
 */
function scratchGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.error?.message || `exit code ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout ?? "").trim();
}

describe("changedTsFiles", () => {
  it("excludes a deleted path and does not crash on one, but keeps an added path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-run-"));
    try {
      scratchGit(dir, ["init", "-q"]);
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      scratchGit(dir, ["add", "a.ts"]);
      scratchGit(dir, ["commit", "-q", "-m", "add a"]);
      const baseSha = scratchGit(dir, ["rev-parse", "HEAD"]);

      // Branch: delete a.ts (the ENOENT trigger — Critical 1), add b.ts.
      rmSync(join(dir, "a.ts"));
      writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
      scratchGit(dir, ["add", "-A"]);
      scratchGit(dir, ["commit", "-q", "-m", "delete a, add b"]);

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
      scratchGit(dir, ["init", "-q"]);
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      scratchGit(dir, ["add", "a.ts"]);
      scratchGit(dir, ["commit", "-q", "-m", "add a"]);
      const baseSha = scratchGit(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      scratchGit(dir, ["add", "a.ts"]);
      scratchGit(dir, ["commit", "-q", "-m", "modify a"]);

      expect(changedTsFiles(dir, baseSha)).toEqual(["a.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
