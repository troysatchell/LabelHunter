/**
 * Git commit provenance for the eval harness's committed artifacts (TRO-561,
 * extending TRO-543 / LH-038's own `currentCommitSha` — moved here so
 * `variance.ts`'s baseline-establishing path can use both this function AND
 * `lastCommitTouchingPath` below from one shared module, instead of
 * duplicating a second inline git call).
 *
 * TWO DIFFERENT FAILURE POLICIES, on purpose:
 *
 *   - `currentCommitSha` is best-effort, matching `variance.ts`'s own prior
 *     behavior: "never a reason to abandon an already-paid-for sweep's
 *     results" (this file's git history). A `variance-report.json`'s own
 *     `commitSha` field is provenance evidence, not something worth losing a
 *     real, paid sweep over.
 *   - `lastCommitTouchingPath` THROWS on failure. It has exactly one caller:
 *     the baseline-band-establishing path (`variance.ts`'s
 *     `--establish-baseline`), where TRO-561's own text calls the corpus SHA
 *     "a design requirement, not decoration." A baseline band with a
 *     fabricated or missing golden-set commit SHA is worse than no baseline
 *     at all (CLAUDE.md: "never fabricate a number" — a SHA is identifying
 *     data, not a number, but the same discipline applies) — fail loudly
 *     instead of writing one.
 */
import { execFileSync } from "node:child_process";

/** Best-effort `git rev-parse HEAD` — returns `"unknown"` (with a printed
 * warning) rather than throwing. See this file's own module comment for
 * why this function, specifically, stays lenient. */
export function currentCommitSha(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (cause) {
    console.warn(`git-provenance: could not read the current commit SHA: ${cause instanceof Error ? cause.message : String(cause)}`);
    return "unknown";
  }
}

/**
 * The most recent commit (reachable from HEAD) that touched
 * `relativePath` — `git log -1 --format=%H -- <relativePath>`. Throws when
 * the git command itself fails, OR when it succeeds with empty output (no
 * commit in this branch's history has ever touched the path — a caller
 * bug, not a legitimate "no provenance" answer for a path that is supposed
 * to exist). See this file's own module comment for why this function,
 * unlike `currentCommitSha`, never falls back to `"unknown"`.
 */
export function lastCommitTouchingPath(repoRoot: string, relativePath: string): string {
  let sha: string;
  try {
    sha = execFileSync("git", ["log", "-1", "--format=%H", "--", relativePath], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (cause) {
    throw new Error(
      `git-provenance: could not determine the last commit touching "${relativePath}": ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (sha.length === 0) {
    throw new Error(`git-provenance: no commit in this branch's history touches "${relativePath}" — nothing to record as its provenance.`);
  }
  return sha;
}
