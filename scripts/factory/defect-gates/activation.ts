import { spawnSync } from "node:child_process";

export interface PinInput {
  activatedAt: string | null;
  mergeBaseIsAfterActivation: boolean;
  mainCommitsElapsed: number | null;
  expiresAfter: number;
}

export interface PinDecision extends PinInput {
  mode: "blocking" | "report-only";
}

/**
 * Decides whether a newly blocking rule applies to this branch.
 *
 * A branch cut before the rule existed runs report-only, so the rule does not
 * retroactively fail work written before it. The exemption dissolves by
 * itself: merge-base only moves forward, and the factory already requires
 * every branch to merge origin/main before landing. The expiry bounds the
 * case where a branch never syncs.
 */
export function decidePin(input: PinInput): PinDecision {
  const { activatedAt, mergeBaseIsAfterActivation, mainCommitsElapsed, expiresAfter } = input;
  if (activatedAt === null) return { ...input, mode: "blocking" };
  if (mergeBaseIsAfterActivation) return { ...input, mode: "blocking" };
  if (mainCommitsElapsed !== null && mainCommitsElapsed > expiresAfter) {
    return { ...input, mode: "blocking" };
  }
  return { ...input, mode: "report-only" };
}

function git(repoRoot: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
}

/** Resolves the two git facts decidePin needs. */
export function resolvePinFacts(
  repoRoot: string,
  baseRef: string,
  activatedAt: string,
): { mergeBaseIsAfterActivation: boolean; mainCommitsElapsed: number } {
  const mergeBase = git(repoRoot, ["merge-base", "HEAD", baseRef]).stdout;
  const isAncestor = git(repoRoot, [
    "merge-base",
    "--is-ancestor",
    activatedAt,
    mergeBase,
  ]).status === 0;
  const counted = git(repoRoot, ["rev-list", "--count", `${activatedAt}..${baseRef}`]);
  const elapsed = counted.status === 0 ? Number.parseInt(counted.stdout, 10) : 0;
  return {
    mergeBaseIsAfterActivation: isAncestor,
    mainCommitsElapsed: Number.isFinite(elapsed) ? elapsed : 0,
  };
}
