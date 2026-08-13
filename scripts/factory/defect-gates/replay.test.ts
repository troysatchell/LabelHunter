import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { resolveFixCommit, summariseReplay } from "./replay";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

describe("resolveFixCommit", () => {
  it("finds a commit by ticket id when no pr is recorded", () => {
    const sha = resolveFixCommit(repoRoot, {
      ticket: "TRO-511",
      file: "src/x.ts",
      disposition: "fixed",
      category: "c",
      summary: "s",
    });
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("returns null for a ticket that appears in no commit", () => {
    const sha = resolveFixCommit(repoRoot, {
      ticket: "TRO-000000",
      file: "src/x.ts",
      disposition: "fixed",
      category: "c",
      summary: "s",
    });
    expect(sha).toBeNull();
  });
});

describe("summariseReplay", () => {
  it("computes recall over resolvable rows only", () => {
    const report = summariseReplay([
      { ticket: "A", resolved: true, hit: true },
      { ticket: "B", resolved: true, hit: false },
      { ticket: "C", resolved: false, hit: false },
    ]);
    expect(report.resolvable).toBe(2);
    expect(report.hits).toBe(1);
    expect(report.recall).toBeCloseTo(0.5);
    expect(report.unresolvable).toBe(1);
  });

  it("reports zero recall rather than dividing by zero", () => {
    const report = summariseReplay([{ ticket: "A", resolved: false, hit: false }]);
    expect(report.recall).toBe(0);
    expect(report.resolvable).toBe(0);
  });
});
