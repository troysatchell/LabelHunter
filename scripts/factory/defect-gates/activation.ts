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

function git(repoRoot: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

export type PinFacts = { mergeBaseIsAfterActivation: boolean; mainCommitsElapsed: number };

export type PinFactsResult = { ok: true; facts: PinFacts } | { ok: false; error: string };

/**
 * Resolves the two git facts `decidePin` needs.
 *
 * Returns `ok: false` on a real git failure, instead of silently defaulting
 * to "not activated yet." A swallowed failure here reads exactly like a
 * branch cut before the rule existed — `mergeBaseIsAfterActivation: false`
 * — so the rule would run report-only forever, with no signal that
 * anything went wrong. An unknown or rewritten `activatedAt` must surface,
 * not disappear.
 *
 * `git merge-base --is-ancestor` exits 0 for "yes" and 1 for "no" — both
 * are real answers. Any other exit code (128 for an invalid ref, for
 * example) is a git failure, not a "no," and is reported as `ok: false`.
 */
export function resolvePinFacts(
  repoRoot: string,
  baseRef: string,
  activatedAt: string,
): PinFactsResult {
  const mergeBaseResult = git(repoRoot, ["merge-base", "HEAD", baseRef]);
  if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout) {
    return {
      ok: false,
      error: `git merge-base HEAD ${baseRef} failed: ${mergeBaseResult.stderr || "no output"}`,
    };
  }
  const mergeBase = mergeBaseResult.stdout;

  const ancestorResult = git(repoRoot, ["merge-base", "--is-ancestor", activatedAt, mergeBase]);
  if (ancestorResult.status !== 0 && ancestorResult.status !== 1) {
    return {
      ok: false,
      error:
        `git merge-base --is-ancestor ${activatedAt} ${mergeBase} failed: ` +
        `${ancestorResult.stderr || "no output"}`,
    };
  }
  const mergeBaseIsAfterActivation = ancestorResult.status === 0;

  const countResult = git(repoRoot, ["rev-list", "--count", `${activatedAt}..${baseRef}`]);
  if (countResult.status !== 0) {
    return {
      ok: false,
      error:
        `git rev-list --count ${activatedAt}..${baseRef} failed: ${countResult.stderr || "no output"}`,
    };
  }
  const mainCommitsElapsed = Number.parseInt(countResult.stdout, 10);
  if (!Number.isFinite(mainCommitsElapsed)) {
    return {
      ok: false,
      error: `git rev-list --count returned a non-numeric result: "${countResult.stdout}"`,
    };
  }

  return { ok: true, facts: { mergeBaseIsAfterActivation, mainCommitsElapsed } };
}
