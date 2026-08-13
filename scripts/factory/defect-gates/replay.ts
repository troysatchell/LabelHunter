import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileAtRef } from "./baseline";
import type { ReplayCorpusEntry, Rule } from "./types";

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

/**
 * Lists every commit that touched this row's file and names its ticket in
 * its own message, oldest first.
 *
 * A single "most recent match" guess often lands on the wrong commit. It
 * might be a merge commit whose parent predates the whole PR. It might be
 * a later bookkeeping commit dated after the real fix. This lists every
 * candidate instead. `replayRule` can then test the rule against each
 * pre-fix snapshot in turn. It does not need to know which one was the
 * real fix.
 */
export function resolveFixCandidates(repoRoot: string, row: LedgerRow): string[] {
  const result = git(repoRoot, [
    "log",
    "--format=%H",
    "--reverse",
    "--grep",
    row.ticket,
    "--",
    row.file,
  ]);
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split("\n").filter(Boolean);
}

/**
 * Selects the ledger rows a rule declares itself calibrated against.
 *
 * A corpus entry names one row by ticket, file, and a distinctive summary
 * substring — the ledger has no stable row id. Throws when an entry
 * matches no row, so a stale entry cannot silently shrink the corpus.
 */
export function selectCorpusRows(rows: LedgerRow[], corpus: ReplayCorpusEntry[]): LedgerRow[] {
  return corpus.map((entry) => {
    const match = rows.find(
      (row) =>
        row.ticket === entry.ticket &&
        row.file === entry.file &&
        row.summary.includes(entry.summaryIncludes),
    );
    if (!match) {
      throw new Error(
        `replayCorpus entry not found in ledger: ${entry.ticket} ${entry.file} "${entry.summaryIncludes}"`,
      );
    }
    return match;
  });
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
 *
 * A row may have several candidate fixing commits (see
 * `resolveFixCandidates`). The row counts as a hit when the rule fires at
 * any candidate's pre-fix snapshot. The real question is whether the rule
 * would have caught the defect while it was present. It does not matter
 * which commit history later assigned as "the" fix. A row is unresolvable
 * only when no candidate's parent contains the file.
 */
export function replayRule(
  repoRoot: string,
  rule: Rule,
  rows: LedgerRow[],
): {
  outcomes: ReplayOutcome[];
  report: ReplayReport;
} {
  const withSource = rule as unknown as {
    checkSource?: (f: string, t: string, c: unknown) => unknown[];
  };
  const outcomes: ReplayOutcome[] = rows.map((row) => {
    const candidates = resolveFixCandidates(repoRoot, row);
    let resolved = false;
    let hit = false;
    for (const fix of candidates) {
      const before = `${fix}^1`;
      const text = fileAtRef(repoRoot, before, row.file);
      if (text === null) continue;
      resolved = true;
      const found = withSource.checkSource
        ? withSource.checkSource(row.file, text, { files: [], repoRoot, registries: {} })
        : [];
      if (found.length > 0) {
        hit = true;
        break;
      }
    }
    return { ticket: row.ticket, resolved, hit };
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
