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

/** H \ B — violations this branch introduced. These fail the gate. */
export function introducedFindings(head: Finding[], base: Finding[]): Finding[] {
  const baseline = new Set(base.map((f) => f.identity));
  return head.filter((f) => !baseline.has(f.identity));
}

/** H ∩ B — violations that already existed. These are reported, never failed. */
export function preExistingFindings(head: Finding[], base: Finding[]): Finding[] {
  const baseline = new Set(base.map((f) => f.identity));
  return head.filter((f) => baseline.has(f.identity));
}
