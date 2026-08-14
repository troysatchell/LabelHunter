import { describe, expect, it } from "vitest";
import { isDirectEntrypoint, sh, validateRuleModule } from "./replay-cli";
import rule from "./rules/vacuous-empty-quantifier";

describe("isDirectEntrypoint", () => {
  it("recognizes a direct .ts invocation (tsx, ts-node)", () => {
    expect(isDirectEntrypoint("/repo/scripts/factory/defect-gates/replay-cli.ts")).toBe(true);
  });

  it("recognizes a compiled .js invocation", () => {
    // A built/bundled CLI runs as .js, not .ts. The old guard checked only
    // the .ts suffix, so a compiled build silently did nothing at all —
    // no error, no output, exit 0.
    expect(isDirectEntrypoint("/repo/dist/scripts/factory/defect-gates/replay-cli.js")).toBe(true);
  });

  it("does not treat a different file as this CLI's entrypoint", () => {
    expect(isDirectEntrypoint("/repo/scripts/factory/defect-gates/run.ts")).toBe(false);
  });

  it("does not treat a filename that merely ends with the same letters as a match", () => {
    // A suffix check (`.endsWith("replay-cli.ts")`) matches
    // "notreplay-cli.ts" too — the file's own basename must equal the
    // entrypoint name exactly, not just share a trailing substring.
    expect(isDirectEntrypoint("/repo/scripts/factory/defect-gates/notreplay-cli.ts")).toBe(
      false,
    );
  });

  it("does not treat an unset argv[1] as an entrypoint", () => {
    expect(isDirectEntrypoint(undefined)).toBe(false);
  });
});

describe("validateRuleModule", () => {
  it("accepts a real rule module and returns it unchanged", () => {
    expect(validateRuleModule(rule, "vacuous-empty-quantifier")).toBe(rule);
  });

  it("names the rule id when the module has no default export at all", () => {
    // replay-cli.ts loads each rule through a dynamic import and casts the
    // result — a rule module with a broken or missing export reaches this
    // check at runtime with nothing the type system caught.
    expect(() => validateRuleModule(undefined, "broken-rule")).toThrow(/broken-rule/);
  });

  it("names the rule id when meta is missing", () => {
    expect(() => validateRuleModule({ checkSource: () => [] }, "broken-rule")).toThrow(
      /broken-rule.*meta/,
    );
  });

  it("names the rule id when meta.replayCorpus is not an array", () => {
    const bad = { meta: { id: "x", replayCorpus: "not-an-array" }, checkSource: () => [] };
    expect(() => validateRuleModule(bad, "broken-rule")).toThrow(/broken-rule.*replayCorpus/);
  });

  it("names the rule id when checkSource is missing", () => {
    const bad = { meta: { id: "x", replayCorpus: [] } };
    expect(() => validateRuleModule(bad, "broken-rule")).toThrow(/broken-rule.*checkSource/);
  });
});

describe("sh", () => {
  const repoRoot = process.cwd();

  it("returns trimmed stdout for a successful git command", () => {
    expect(sh(["rev-parse", "--show-toplevel"], repoRoot)).not.toBe("");
  });

  it("throws with git's own failure detail, naming the command, on a bad subcommand", () => {
    expect(() => sh(["not-a-real-git-subcommand"], repoRoot)).toThrow(
      /git not-a-real-git-subcommand failed/,
    );
  });
});
