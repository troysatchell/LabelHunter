import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileAtRef } from "./baseline";
import type { Rule } from "./types";

export interface LedgerRow {
  ticket: string;
  pr?: string;
  file: string;
  disposition: string;
  category: string;
  summary: string;
}

export interface ReplayOutcome {
  ticket: string;
  resolved: boolean;
  hit: boolean;
}

export interface ReplayReport {
  total: number;
  resolvable: number;
  unresolvable: number;
  hits: number;
  recall: number;
}

function git(repoRoot: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
}

/**
 * Finds the commit that fixed a ledger row.
 *
 * The ledger records ticket, pr, and file, but no commit SHA. Measured
 * 2026-08-12: only 163 of 406 retained rows carry a pr. The ticket-id grep is
 * therefore the fallback, not the exception.
 */
export function resolveFixCommit(repoRoot: string, row: LedgerRow): string | null {
  if (row.pr) {
    const merge = git(repoRoot, [
      "log",
      "--format=%H",
      "-n",
      "1",
      "--grep",
      `Merge pull request #${row.pr}`,
    ]);
    if (merge.status === 0 && merge.stdout) return merge.stdout;
  }
  const byTicket = git(repoRoot, ["log", "--format=%H", "-n", "1", "--grep", row.ticket]);
  if (byTicket.status === 0 && byTicket.stdout) return byTicket.stdout;
  return null;
}

export function summariseReplay(outcomes: ReplayOutcome[]): ReplayReport {
  const resolvable = outcomes.filter((o) => o.resolved).length;
  const hits = outcomes.filter((o) => o.resolved && o.hit).length;
  return {
    total: outcomes.length,
    resolvable,
    unresolvable: outcomes.length - resolvable,
    hits,
    recall: resolvable === 0 ? 0 : hits / resolvable,
  };
}

/**
 * Runs a rule against the tree as it stood BEFORE each fix, and records
 * whether the rule would have caught it.
 */
export function replayRule(
  repoRoot: string,
  rule: Rule,
  rows: LedgerRow[],
): {
  outcomes: ReplayOutcome[];
  report: ReplayReport;
} {
  const outcomes: ReplayOutcome[] = rows.map((row) => {
    const fix = resolveFixCommit(repoRoot, row);
    if (!fix) return { ticket: row.ticket, resolved: false, hit: false };
    const before = `${fix}^1`;
    const text = fileAtRef(repoRoot, before, row.file);
    if (text === null) return { ticket: row.ticket, resolved: false, hit: false };
    const withSource = rule as unknown as {
      checkSource?: (f: string, t: string, c: unknown) => unknown[];
    };
    const found = withSource.checkSource
      ? withSource.checkSource(row.file, text, { files: [], repoRoot, registries: {} })
      : [];
    return { ticket: row.ticket, resolved: true, hit: found.length > 0 };
  });
  return { outcomes, report: summariseReplay(outcomes) };
}

export function loadLedger(path: string): LedgerRow[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerRow);
}
