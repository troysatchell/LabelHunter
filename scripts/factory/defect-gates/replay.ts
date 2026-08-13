import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileAtRef } from "./baseline";
import type { Finding, ReplayCorpusEntry, Rule } from "./types";

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
  /**
   * The ledger row's own file. A ticket alone does not name a row — one
   * ticket can carry several calibration rows, one per file, and without
   * this field their outcomes are indistinguishable in the written
   * artifact.
   */
  file: string;
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
  // Rule is typed with a required checkSource, but replay-cli.ts loads a
  // rule module through a dynamic import and an `as unknown as Rule` cast
  // — the type system cannot verify that cast at runtime. Fail loudly and
  // by name here, rather than let a missing method surface later as a
  // generic "not a function" error with no rule id attached.
  if (typeof rule.checkSource !== "function") {
    throw new Error(`rule ${rule.meta.id} has no checkSource; replay cannot measure recall`);
  }
  const outcomes: ReplayOutcome[] = rows.map((row) => {
    const candidates = resolveFixCandidates(repoRoot, row);
    let resolved = false;
    let hit = false;
    for (const fix of candidates) {
      const before = `${fix}^1`;
      const text = fileAtRef(repoRoot, before, row.file);
      if (text === null) continue;
      resolved = true;
      let found: Finding[];
      try {
        found = rule.checkSource(row.file, text, { files: [], repoRoot, registries: {} });
      } catch {
        // One historical snapshot failing to parse (a syntax the current
        // TypeScript version rejects, a shape the rule does not expect)
        // makes only that candidate unusable. It must not abort replay
        // for the remaining candidates or the remaining rows.
        continue;
      }
      if (found.length > 0) {
        hit = true;
        break;
      }
    }
    return { ticket: row.ticket, file: row.file, resolved, hit };
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
