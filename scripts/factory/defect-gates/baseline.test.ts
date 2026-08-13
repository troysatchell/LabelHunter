import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileAtRef, introducedFindings, preExistingFindings } from "./baseline";
import type { Finding } from "./types";

function finding(identity: string): Finding {
  return {
    ruleId: "r",
    ruleVersion: 1,
    file: "src/a.ts",
    line: 1,
    identity,
    message: "m",
    repairability: "manual",
    exemptedBy: null,
  };
}

describe("introducedFindings", () => {
  it("returns findings absent from the baseline", () => {
    const head = [finding("new"), finding("old")];
    const base = [finding("old")];
    expect(introducedFindings(head, base).map((f) => f.identity)).toEqual(["new"]);
  });

  it("returns nothing when every finding pre-exists", () => {
    const head = [finding("old")];
    const base = [finding("old")];
    expect(introducedFindings(head, base)).toEqual([]);
  });

  it("returns every finding when the baseline is empty", () => {
    const head = [finding("a"), finding("b")];
    expect(introducedFindings(head, []).map((f) => f.identity)).toEqual(["a", "b"]);
  });

  it("ignores a baseline finding that HEAD has fixed", () => {
    const head: Finding[] = [];
    const base = [finding("gone")];
    expect(introducedFindings(head, base)).toEqual([]);
  });

  it("counts a surplus occurrence as introduced, not a Set membership check", () => {
    // The function already had one "dup" violation (in base). The branch
    // adds a second, structurally identical one (head has two). A Set
    // comparison would report zero introduced — both match the same entry.
    const head = [finding("dup"), finding("dup")];
    const base = [finding("dup")];
    expect(introducedFindings(head, base)).toHaveLength(1);
    expect(preExistingFindings(head, base)).toHaveLength(1);
  });
});

describe("preExistingFindings", () => {
  it("returns findings present in both", () => {
    const head = [finding("new"), finding("old")];
    const base = [finding("old")];
    expect(preExistingFindings(head, base).map((f) => f.identity)).toEqual(["old"]);
  });
});

describe("fileAtRef", () => {
  const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

  it("reads a tracked file at HEAD", () => {
    const content = fileAtRef(repoRoot, "HEAD", "package.json");
    expect(content).toContain('"name"');
  });

  it("returns null for a path that does not exist at the ref", () => {
    expect(fileAtRef(repoRoot, "HEAD", "no/such/file.ts")).toBeNull();
  });
});
