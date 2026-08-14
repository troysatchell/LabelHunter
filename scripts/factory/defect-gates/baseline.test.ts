import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileAtRef, introducedFindings, isMissingPathFailure, preExistingFindings } from "./baseline";
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

  it("throws when the ref itself does not resolve to a commit, instead of reading it as no baseline", () => {
    // A bad BASE_REF (typo, deleted branch, force-pushed-away sha) must
    // surface loudly. Silently returning null here would read exactly like
    // "this file is new on the branch" for every file in the diff.
    expect(() => fileAtRef(repoRoot, "not-a-real-ref-tro-554", "package.json")).toThrow(
      /not-a-real-ref-tro-554/,
    );
  });
});

describe("isMissingPathFailure", () => {
  it("recognizes git's does-not-exist-at-ref message as a missing path", () => {
    expect(isMissingPathFailure("fatal: path 'no/such/file.ts' does not exist in 'HEAD'")).toBe(
      true,
    );
  });

  it("recognizes the exists-on-disk-but-not-in-ref variant", () => {
    expect(
      isMissingPathFailure("fatal: path 'package.json' exists on disk, but not in '0000000'"),
    ).toBe(true);
  });

  it("does not classify an unrelated git failure as a missing path", () => {
    // A corrupt object, a permissions error, a bad tree — none of these
    // mean "the branch added this file." They must not read as one.
    expect(isMissingPathFailure("fatal: unable to read tree object deadbeef")).toBe(false);
  });
});
