import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import type { LedgerRow } from "./replay";
import { replayRule, resolveFixCandidates, selectCorpusRows, summariseReplay } from "./replay";
import rule from "./rules/vacuous-empty-quantifier";
import type { Rule } from "./types";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

// resolveFixCandidates and replayRule below replay REAL commit history for
// two specific tickets (TRO-511, TRO-464) in this repo, not a synthetic
// scratch repo — that is the point: they prove the harness against actual
// git archaeology. A shallow checkout truncates that history, which would
// fail every assertion below for an environment reason, not a code bug.
// Skip with a named reason instead of a confusing failure; a full clone
// (this repo's normal state, and CI's `fetch-depth: 0`) always runs them.
const isShallowRepo =
  execSync("git rev-parse --is-shallow-repository", { cwd: repoRoot, encoding: "utf8" }).trim() ===
  "true";

describe("summariseReplay", () => {
  it("computes recall over resolvable rows only", () => {
    const report = summariseReplay([
      { ticket: "A", file: "a.ts", resolved: true, hit: true },
      { ticket: "B", file: "b.ts", resolved: true, hit: false },
      { ticket: "C", file: "c.ts", resolved: false, hit: false },
    ]);
    expect(report.resolvable).toBe(2);
    expect(report.hits).toBe(1);
    expect(report.recall).toBeCloseTo(0.5);
    expect(report.unresolvable).toBe(1);
  });

  it("reports zero recall rather than dividing by zero", () => {
    const report = summariseReplay([{ ticket: "A", file: "a.ts", resolved: false, hit: false }]);
    expect(report.recall).toBe(0);
    expect(report.resolvable).toBe(0);
  });
});

describe.skipIf(isShallowRepo)("resolveFixCandidates", () => {
  it("lists every commit touching the file that names the ticket, oldest first", () => {
    const shas = resolveFixCandidates(repoRoot, {
      ticket: "TRO-511",
      file: "src/server/single-label-resolve/claim.ts",
      disposition: "fixed",
      category: "c",
      summary: "s",
    });
    // Measured on this repo 2026-08-12: three commits touch claim.ts and
    // name TRO-511 in their own message.
    expect(shas.length).toBeGreaterThanOrEqual(2);
    for (const sha of shas) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // git log --reverse lists the oldest commit first. Confirm ordering by
    // asking git which of the first two commits is the ancestor.
    if (shas.length >= 2) {
      const order = execSync(`git merge-base --is-ancestor ${shas[0]} ${shas[1]} && echo yes || echo no`, {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      expect(order).toBe("yes");
    }
  });

  it("returns an empty list when no commit touches the file and names the ticket", () => {
    const shas = resolveFixCandidates(repoRoot, {
      ticket: "TRO-000000",
      file: "src/x.ts",
      disposition: "fixed",
      category: "c",
      summary: "s",
    });
    expect(shas).toEqual([]);
  });
});

describe("selectCorpusRows", () => {
  const rows: LedgerRow[] = [
    { ticket: "TRO-1", file: "a.ts", disposition: "fixed", category: "c", summary: "the first bug, about widgets" },
    { ticket: "TRO-1", file: "b.ts", disposition: "fixed", category: "c", summary: "a second, unrelated bug" },
    { ticket: "TRO-2", file: "a.ts", disposition: "fixed", category: "c", summary: "a different ticket, same file" },
  ];

  it("picks the row matching ticket, file, and a summary substring", () => {
    const picked = selectCorpusRows(rows, [
      { ticket: "TRO-1", file: "a.ts", summaryIncludes: "widgets" },
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0].summary).toBe("the first bug, about widgets");
  });

  it("throws when a corpus entry matches no ledger row", () => {
    expect(() =>
      selectCorpusRows(rows, [{ ticket: "TRO-9", file: "z.ts", summaryIncludes: "nothing" }]),
    ).toThrow(/TRO-9/);
  });
});

describe.skipIf(isShallowRepo)("replayRule", () => {
  it("counts a hit when any candidate snapshot triggers the rule, not only the most recent one", () => {
    // Measured on this repo 2026-08-12: the most recent commit naming
    // TRO-464 and touching queue.ts is not the fix. Its own parent does
    // not hold the unguarded quantifier. An earlier candidate's parent does.
    const rows: LedgerRow[] = [
      {
        ticket: "TRO-464",
        file: "src/server/resolver/queue.ts",
        disposition: "fixed",
        category: "boundary-validation",
        summary: "isResolverResolution accepted a stored row with fields: []",
      },
    ];
    const { outcomes } = replayRule(repoRoot, rule, rows);
    expect(outcomes[0].resolved).toBe(true);
    expect(outcomes[0].hit).toBe(true);
  });

  it("marks a row unresolvable only when no candidate's parent contains the file", () => {
    const rows: LedgerRow[] = [
      {
        ticket: "TRO-000000",
        file: "src/x.ts",
        disposition: "fixed",
        category: "c",
        summary: "s",
      },
    ];
    const { outcomes } = replayRule(repoRoot, rule, rows);
    expect(outcomes[0].resolved).toBe(false);
    expect(outcomes[0].hit).toBe(false);
  });

  it("throws immediately, naming the rule, when checkSource is missing", () => {
    // Simulates the one path the Rule type cannot guard: replay-cli.ts
    // loads a rule module through a dynamic import and casts it to Rule.
    // A malformed module reaches replayRule at runtime with no checkSource
    // at all, despite the type saying it must have one.
    const bareRule = { ...rule, checkSource: undefined } as unknown as Rule;
    expect(() => replayRule(repoRoot, bareRule, [])).toThrow(/vacuous-empty-quantifier/);
  });

  it("treats a candidate whose checkSource throws as unusable, and keeps trying the rest", () => {
    let calls = 0;
    const flaky: Rule = {
      ...rule,
      checkSource: (f, t, c) => {
        calls += 1;
        if (calls === 1) throw new Error("simulated parse failure on this snapshot");
        return rule.checkSource(f, t, c);
      },
    };
    const rows: LedgerRow[] = [
      {
        ticket: "TRO-464",
        file: "src/server/resolver/queue.ts",
        disposition: "fixed",
        category: "boundary-validation",
        summary: "isResolverResolution accepted a stored row with fields: []",
      },
    ];
    const { outcomes } = replayRule(repoRoot, flaky, rows);
    expect(calls).toBeGreaterThan(1);
    expect(outcomes[0].resolved).toBe(true);
    expect(outcomes[0].hit).toBe(true);
  });
});
