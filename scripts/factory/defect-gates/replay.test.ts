import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import type { LedgerRow } from "./replay";
import {
  replayRule,
  resolveFixCandidates,
  resolveFixCommit,
  selectCorpusRows,
  summariseReplay,
} from "./replay";
import rule from "./rules/vacuous-empty-quantifier";

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

describe("resolveFixCandidates", () => {
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

describe("replayRule", () => {
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
});
