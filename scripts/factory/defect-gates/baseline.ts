import { spawnSync } from "node:child_process";
import type { Finding } from "./types";

/**
 * Reads one file's content at a git ref, without touching the working tree.
 *
 * This is the discipline gate.sh already uses for the quarantine baseline:
 * `git show BASE_REF:` and never the branch copy, so an agent cannot
 * whitelist its own breakage. It also avoids `git stash`, which is banned in
 * factory worktrees because refs/stash is shared across them.
 *
 * Returns null when the file does not exist at that ref — a file the branch
 * added. Its baseline contribution is then correctly empty.
 */
export function fileAtRef(
  repoRoot: string,
  ref: string,
  repoRelativePath: string,
): string | null {
  const result = spawnSync("git", ["show", `${ref}:${repoRelativePath}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

/** Counts how many times each identity appears. */
function countByIdentity(findings: Finding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.identity, (counts.get(f.identity) ?? 0) + 1);
  return counts;
}

/**
 * H \ B, compared as a multiset — these fail the gate.
 *
 * A plain Set comparison treats identity as either present or absent. A
 * function with one existing violation that grows a second, structurally
 * identical one then reports zero introduced findings — the second copy
 * matches the same Set entry as the first. This decrements one baseline
 * occurrence per matched head finding instead, so a surplus occurrence is
 * correctly counted as introduced.
 */
export function introducedFindings(head: Finding[], base: Finding[]): Finding[] {
  const remaining = countByIdentity(base);
  const introduced: Finding[] = [];
  for (const f of head) {
    const n = remaining.get(f.identity) ?? 0;
    if (n > 0) {
      remaining.set(f.identity, n - 1);
    } else {
      introduced.push(f);
    }
  }
  return introduced;
}

/** H ∩ B, compared as a multiset — matched occurrences only, reported never failed. */
export function preExistingFindings(head: Finding[], base: Finding[]): Finding[] {
  const remaining = countByIdentity(base);
  const preExisting: Finding[] = [];
  for (const f of head) {
    const n = remaining.get(f.identity) ?? 0;
    if (n > 0) {
      remaining.set(f.identity, n - 1);
      preExisting.push(f);
    }
  }
  return preExisting;
}
