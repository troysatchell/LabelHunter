import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  backoffMs,
  decideCapture,
  diffSince,
  formatCarriedForwardDetail,
  isBoringPath,
  isCaptureMeta,
  isCommentOrBlankLine,
  isDiffBoring,
  isFileChangeBoring,
  isRateLimitError,
  isWorkingTreeDirty,
  MAX_REASONABLE_ATTEMPTS,
  normalizeReviewMode,
  parseCoderabbitOutput,
  parsePositiveIntEnv,
  parseUnifiedDiff,
  planReview,
  runCapture,
  type CaptureMeta,
  type ParsedDiffFile,
  type RunnerResult,
} from "./review-capture";

// TRO-560: gate.sh's review step (G10) fell back to a previous run's findings
// on rc!=0 with no visible signal that the fallback was stale, and threw
// away the real failure reason (TRO-508's comment: the CLI reports its error
// as a JSON line on STDOUT, not stderr — gate.sh pointed readers at an empty
// .err file). These tests cover the extracted decision logic.

// The exact artifact TRO-508's comment on 2026-08-13 quoted verbatim from a
// real rate-limited coderabbit run (`.factory/coderabbit.json`, line 4).
const REAL_RATE_LIMIT_JSONL = [
  '{"type":"review_context"}',
  '{"type":"status","phase":"connecting","status":"connecting_to_review_service"}',
  '{"type":"status","phase":"setup","status":"setting_up"}',
  JSON.stringify({
    type: "error",
    errorType: "rate_limit",
    message: "Rate limit exceeded",
    recoverable: true,
    metadata: { isProUser: true, waitTime: "4 minutes", orgAttributed: true },
  }),
].join("\n");

describe("parseCoderabbitOutput", () => {
  it("counts finding-type lines", () => {
    const text = ['{"type":"finding"}', '{"type":"finding"}', '{"type":"status"}'].join("\n");
    expect(parseCoderabbitOutput(text).findings).toBe(2);
  });

  it("extracts errorType and message from the real TRO-508 rate-limit artifact", () => {
    const parsed = parseCoderabbitOutput(REAL_RATE_LIMIT_JSONL);
    expect(parsed.findings).toBe(0);
    expect(parsed.lastError).not.toBeNull();
    expect(parsed.lastError?.errorType).toBe("rate_limit");
    expect(parsed.lastError?.message).toBe("Rate limit exceeded");
  });

  it("ignores non-JSON lines instead of crashing", () => {
    const text = ["not json at all", '{"type":"finding"}', ""].join("\n");
    expect(() => parseCoderabbitOutput(text)).not.toThrow();
    expect(parseCoderabbitOutput(text).findings).toBe(1);
  });

  it("keeps the LAST error line when more than one is present", () => {
    const text = [
      JSON.stringify({ type: "error", errorType: "rate_limit", message: "first" }),
      JSON.stringify({ type: "error", errorType: "timeout", message: "second" }),
    ].join("\n");
    expect(parseCoderabbitOutput(text).lastError?.message).toBe("second");
  });

  it("returns no error and zero findings for empty output", () => {
    const parsed = parseCoderabbitOutput("");
    expect(parsed.findings).toBe(0);
    expect(parsed.lastError).toBeNull();
  });
});

describe("isRateLimitError", () => {
  it("is false for null", () => {
    expect(isRateLimitError(null)).toBe(false);
  });

  it("is true only for errorType 'rate_limit'", () => {
    expect(isRateLimitError({ errorType: "rate_limit", message: "m", raw: "" })).toBe(true);
    expect(isRateLimitError({ errorType: "timeout", message: "m", raw: "" })).toBe(false);
  });
});

describe("backoffMs", () => {
  it("doubles each attempt starting at baseMs", () => {
    expect(backoffMs(1, 1000, 60000)).toBe(1000);
    expect(backoffMs(2, 1000, 60000)).toBe(2000);
    expect(backoffMs(3, 1000, 60000)).toBe(4000);
  });

  it("never exceeds the cap", () => {
    expect(backoffMs(10, 1000, 8000)).toBe(8000);
  });
});

describe("decideCapture", () => {
  const sha = "d4e5f6a1234567890";
  const oldSha = "a1b2c3d4567890abc";

  it("passes with a fresh count when rc=0 and findings were captured", () => {
    const d = decideCapture({
      rc: 0, timedOut: false,
      parsed: { findings: 3, lastError: null },
      previous: null, currentSha: sha,
    });
    expect(d.status).toBe("pass");
    expect(d.persistFresh).toBe(true);
    expect(d.detail).toContain("3 finding(s)");
  });

  it("passes with 'no findings' when rc=0 and the review found nothing", () => {
    const d = decideCapture({
      rc: 0, timedOut: false,
      parsed: { findings: 0, lastError: null },
      previous: null, currentSha: sha,
    });
    expect(d.status).toBe("pass");
    expect(d.detail).toContain("no findings");
  });

  it("warns 'did not complete' with the real error reason when rc!=0 and there is no fallback", () => {
    const d = decideCapture({
      rc: 1, timedOut: false,
      parsed: { findings: 0, lastError: { errorType: "rate_limit", message: "Rate limit exceeded", raw: "" } },
      previous: null, currentSha: sha,
    });
    expect(d.status).toBe("warn");
    expect(d.persistFresh).toBe(false);
    expect(d.detail).toContain("rate_limit");
    expect(d.detail).toContain("Rate limit exceeded");
    expect(d.detail).not.toContain("see .factory/coderabbit.err");
  });

  it("names the SHA and says the diff has NOT been reviewed when falling back to a DIFFERENT commit's findings", () => {
    const previous: CaptureMeta = { sha: oldSha, capturedAt: "2026-08-13T00:00:00Z", findings: 5 };
    const d = decideCapture({
      rc: 1, timedOut: false,
      parsed: { findings: 0, lastError: { errorType: "rate_limit", message: "Rate limit exceeded", raw: "" } },
      previous, currentSha: sha,
    });
    expect(d.status).toBe("warn");
    expect(d.persistFresh).toBe(false);
    expect(d.detail).toContain("5 finding(s)");
    expect(d.detail).toContain(oldSha.slice(0, 7));
    expect(d.detail).toContain(sha.slice(0, 7));
    expect(d.detail).toContain("has NOT been reviewed");
  });

  it("does NOT claim staleness when the fallback findings were captured at the SAME sha as HEAD", () => {
    const previous: CaptureMeta = { sha, capturedAt: "2026-08-13T00:00:00Z", findings: 5 };
    const d = decideCapture({
      rc: 1, timedOut: false,
      parsed: { findings: 0, lastError: { errorType: "rate_limit", message: "m", raw: "" } },
      previous, currentSha: sha,
    });
    expect(d.detail).not.toContain("has NOT been reviewed");
    expect(d.detail).toContain("still current");
  });

  it("reports a timeout distinctly from a parsed error", () => {
    const d = decideCapture({
      rc: 124, timedOut: true,
      parsed: { findings: 0, lastError: null },
      previous: null, currentSha: sha,
    });
    expect(d.detail).toContain("timed out");
  });

  // Observed for real on 2026-08-13: a full-gate run against this branch hit
  // the CLI's own 360s timeout mid-capture. The killed process had already
  // written 3 finding-type lines to stdout before rc=124 landed. A partial,
  // never-completed capture must not be persisted as if it were real
  // findings — rc!=0 always wins, regardless of what parsed.findings holds.
  it("does NOT persist a partial capture — rc!=0 wins even when some findings were parsed", () => {
    const d = decideCapture({
      rc: 124, timedOut: true,
      parsed: { findings: 3, lastError: null },
      previous: null, currentSha: sha,
    });
    expect(d.status).toBe("warn");
    expect(d.persistFresh).toBe(false);
  });
});

describe("parsePositiveIntEnv", () => {
  it("falls back on an undefined value", () => {
    expect(parsePositiveIntEnv(undefined, 42)).toBe(42);
  });

  it("falls back on an empty or whitespace-only value", () => {
    expect(parsePositiveIntEnv("", 42)).toBe(42);
    expect(parsePositiveIntEnv("   ", 42)).toBe(42);
  });

  it("falls back on a non-numeric value", () => {
    expect(parsePositiveIntEnv("abc", 42)).toBe(42);
  });

  it("falls back on zero — a real misconfiguration, not just a hypothetical", () => {
    expect(parsePositiveIntEnv("0", 42)).toBe(42);
  });

  it("falls back on a negative value", () => {
    expect(parsePositiveIntEnv("-5", 42)).toBe(42);
  });

  it("floors a valid positive fractional value", () => {
    expect(parsePositiveIntEnv("3.7", 42)).toBe(3);
  });

  it("accepts a valid positive integer", () => {
    expect(parsePositiveIntEnv("10", 42)).toBe(10);
  });

  it("falls back on a positive fraction below one — flooring it would return 0", () => {
    expect(parsePositiveIntEnv("0.5", 42)).toBe(42);
  });
});

describe("runCapture", () => {
  const okResult: RunnerResult = { rc: 0, stdout: '{"type":"finding"}\n', stderr: "", timedOut: false };
  const rateLimitResult: RunnerResult = {
    rc: 1,
    stdout: REAL_RATE_LIMIT_JSONL,
    stderr: "",
    timedOut: false,
  };
  const genericFailResult: RunnerResult = { rc: 1, stdout: "", stderr: "boom", timedOut: false };

  it("does not retry on a clean first attempt", () => {
    const runner = vi.fn().mockReturnValue(okResult);
    const sleep = vi.fn();
    const result = runCapture({
      base: "main", currentSha: "sha1", previous: null, runner, sleep,
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result.decision.status).toBe("pass");
  });

  it("retries a rate-limit failure with backoff, then succeeds", () => {
    const runner = vi.fn().mockReturnValueOnce(rateLimitResult).mockReturnValueOnce(okResult);
    const sleep = vi.fn();
    const result = runCapture({
      base: "main", currentSha: "sha1", previous: null, runner, sleep,
      backoffFn: (a) => a * 100,
    });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(result.decision.status).toBe("pass");
  });

  it("bounds the retries — never retries forever on a persistent rate limit", () => {
    const runner = vi.fn().mockReturnValue(rateLimitResult);
    const sleep = vi.fn();
    const result = runCapture({
      base: "main", currentSha: "sha1", previous: null, runner, sleep,
      maxAttempts: 3, backoffFn: (a) => a * 10,
    });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.decision.status).toBe("warn");
  });

  it("does NOT retry a non-rate-limit failure", () => {
    const runner = vi.fn().mockReturnValue(genericFailResult);
    const sleep = vi.fn();
    const result = runCapture({
      base: "main", currentSha: "sha1", previous: null, runner, sleep,
      maxAttempts: 3,
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result.decision.status).toBe("warn");
  });

  it("records one AttemptLog per attempt, preserving the parsed error for diagnostics", () => {
    const runner = vi.fn().mockReturnValueOnce(rateLimitResult).mockReturnValueOnce(okResult);
    const result = runCapture({
      base: "main", currentSha: "sha1", previous: null, runner, sleep: vi.fn(),
    });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].rc).toBe(1);
    expect(result.attempts[0].lastError?.errorType).toBe("rate_limit");
    expect(result.attempts[1].rc).toBe(0);
  });

  it("clamps a zero or negative maxAttempts to at least one real attempt", () => {
    const runner = vi.fn().mockReturnValue(okResult);
    const zero = runCapture({ base: "main", currentSha: "sha1", previous: null, runner, maxAttempts: 0 });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(zero.attempts).toHaveLength(1);

    runner.mockClear();
    const negative = runCapture({ base: "main", currentSha: "sha1", previous: null, runner, maxAttempts: -3 });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(negative.attempts).toHaveLength(1);
  });

  it("falls back to the default attempt count on NaN — Math.max(1, NaN) is NaN, which would loop zero times", () => {
    const runner = vi.fn().mockReturnValue(okResult);
    const result = runCapture({ base: "main", currentSha: "sha1", previous: null, runner, maxAttempts: NaN });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.attempts.length).toBeGreaterThan(0);
  });

  it("falls back to the default attempt count on Infinity — never an unbounded retry loop", () => {
    const runner = vi.fn().mockReturnValue(rateLimitResult);
    const result = runCapture({
      base: "main", currentSha: "sha1", previous: null, runner, sleep: vi.fn(),
      maxAttempts: Infinity, backoffFn: () => 0,
    });
    expect(result.attempts.length).toBeLessThanOrEqual(3);
  });

  it("caps a large but finite maxAttempts at MAX_REASONABLE_ATTEMPTS", () => {
    const runner = vi.fn().mockReturnValue(rateLimitResult);
    const result = runCapture({
      base: "main", currentSha: "sha1", previous: null, runner, sleep: vi.fn(),
      maxAttempts: 1000, backoffFn: () => 0,
    });
    expect(result.attempts.length).toBe(MAX_REASONABLE_ATTEMPTS);
    expect(runner).toHaveBeenCalledTimes(MAX_REASONABLE_ATTEMPTS);
  });
});

describe("isCaptureMeta", () => {
  it("accepts a well-formed CaptureMeta", () => {
    expect(isCaptureMeta({ sha: "abc1234", capturedAt: "2026-08-13T00:00:00Z", findings: 3 })).toBe(true);
  });

  it("accepts a CaptureMeta carrying TRO-548's optional scopedFrom", () => {
    expect(
      isCaptureMeta({ sha: "abc1234", capturedAt: "2026-08-13T00:00:00Z", findings: 3, scopedFrom: "def5678" }),
    ).toBe(true);
    // A record written before this field existed has no scopedFrom key at all — still valid.
    expect(isCaptureMeta({ sha: "abc1234", capturedAt: "2026-08-13T00:00:00Z", findings: 3 })).toBe(true);
  });

  it("rejects a missing sha", () => {
    expect(isCaptureMeta({ capturedAt: "2026-08-13T00:00:00Z", findings: 3 })).toBe(false);
  });

  it("rejects an empty-string sha", () => {
    expect(isCaptureMeta({ sha: "", capturedAt: "2026-08-13T00:00:00Z", findings: 3 })).toBe(false);
  });

  it("rejects a non-numeric findings field", () => {
    expect(isCaptureMeta({ sha: "abc1234", capturedAt: "2026-08-13T00:00:00Z", findings: "3" })).toBe(false);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(isCaptureMeta(null)).toBe(false);
    expect(isCaptureMeta([])).toBe(false);
    expect(isCaptureMeta("abc1234")).toBe(false);
    expect(isCaptureMeta(42)).toBe(false);
  });
});

// TRO-548: gate.sh's review step (G10) re-reviewed the whole branch on
// EVERY run, including rounds whose only change was the previous round's
// own triage prose. TRO-544 measured it directly: 11 gate runs, findings
// regenerating every round (3, 12, 4, 5, 8, 4, 3, 2, 4, 10) even against
// files already triaged, real substance ending at round 12 of 13. Lessons
// rule 31 capped this by orchestrator discipline; these tests cover the
// mechanical cap: skip a re-review when nothing worth reviewing changed,
// and scope CodeRabbit's own diff to what's new otherwise.

describe("normalizeReviewMode", () => {
  it("defaults to carry for undefined, empty, or unrecognized input", () => {
    expect(normalizeReviewMode(undefined)).toBe("carry");
    expect(normalizeReviewMode("")).toBe("carry");
    expect(normalizeReviewMode("bogus")).toBe("carry");
  });

  it("accepts off and full verbatim", () => {
    expect(normalizeReviewMode("off")).toBe("off");
    expect(normalizeReviewMode("full")).toBe("full");
  });
});

describe("isBoringPath", () => {
  it("matches the root CHANGES.md exactly", () => {
    expect(isBoringPath("CHANGES.md")).toBe(true);
  });

  it("does not match a differently-named or nested CHANGES.md", () => {
    expect(isBoringPath("docs/CHANGES.md")).toBe(false);
    expect(isBoringPath("CHANGES.markdown")).toBe(false);
  });

  it("matches any factory/*.jsonl log", () => {
    expect(isBoringPath("factory/scorecard.jsonl")).toBe(true);
    expect(isBoringPath("factory/review-findings.jsonl")).toBe(true);
  });

  it("does not match a factory file that is not .jsonl", () => {
    expect(isBoringPath("factory/config.yaml")).toBe(false);
    expect(isBoringPath("factory/quarantine.json")).toBe(false);
  });

  it("does not match a .jsonl file outside factory/", () => {
    expect(isBoringPath("scripts/factory/data.jsonl")).toBe(false);
  });
});

describe("isCommentOrBlankLine", () => {
  it("is true for blank or whitespace-only lines", () => {
    expect(isCommentOrBlankLine("")).toBe(true);
    expect(isCommentOrBlankLine("   ")).toBe(true);
  });

  it("is true for // and /* ... */ style comment lines", () => {
    expect(isCommentOrBlankLine("// a note")).toBe(true);
    expect(isCommentOrBlankLine("  // indented note")).toBe(true);
    expect(isCommentOrBlankLine("/* block open")).toBe(true);
    expect(isCommentOrBlankLine(" * block continuation")).toBe(true);
    expect(isCommentOrBlankLine(" */")).toBe(true);
  });

  it("is true for # and HTML/markdown comment delimiters", () => {
    expect(isCommentOrBlankLine("# shell or yaml comment")).toBe(true);
    expect(isCommentOrBlankLine("<!-- markdown comment -->")).toBe(true);
  });

  it("is false for a real code line", () => {
    expect(isCommentOrBlankLine("const x = 2;")).toBe(false);
    expect(isCommentOrBlankLine("  return value;")).toBe(false);
  });

  it("is false for a line mixing code and a trailing comment", () => {
    // Starts with code, not a comment marker — real content changed here.
    expect(isCommentOrBlankLine("const x = 2; // was 1")).toBe(false);
  });

  // CodeRabbit finding (first full review, round 1): a bare `#` matched ANY
  // line starting with `#`, including a TS/JS private class field —
  // `#cache = new Map();` IS real code in this repo's own language, and
  // would have silently skipped review. `#` now must be followed by
  // whitespace, `!` (a shebang), or end-of-line.
  it("is false for a TS/JS private class field — # with no space after it", () => {
    expect(isCommentOrBlankLine("#cache = new Map();")).toBe(false);
    expect(isCommentOrBlankLine("#privateMethod() {")).toBe(false);
  });

  it("is still true for a shebang line", () => {
    expect(isCommentOrBlankLine("#!/usr/bin/env node")).toBe(true);
  });

  it("is false for a no-space #comment — the safe direction: an occasional missed skip, never a hidden change", () => {
    expect(isCommentOrBlankLine("#comment")).toBe(false);
  });

  it("is false for a bare * glued to a value with no space — no longer misread as a comment continuation", () => {
    expect(isCommentOrBlankLine("*2")).toBe(false);
  });

  it("documents the known remaining gap: a space-separated multiplication continuation still reads as a JSDoc line", () => {
    // `* 2` is textually identical to a real JSDoc continuation ("* some
    // text"); telling them apart needs block-comment STATE across lines,
    // out of scope for a per-line classifier. Prettier's own line-break
    // style never produces this shape in practice (operators stay at the
    // end of the previous line) — documented here, not silently assumed.
    expect(isCommentOrBlankLine("* 2")).toBe(true);
  });
});

describe("parseUnifiedDiff", () => {
  it("collects +/- content lines per file, prefix stripped", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 111..222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-const x = 1;",
      "+const x = 2;",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/foo.ts");
    expect(files[0].binary).toBe(false);
    expect(files[0].changedLines).toEqual(["const x = 1;", "const x = 2;"]);
  });

  it("splits multiple files in one diff into separate entries", () => {
    const diff = [
      "diff --git a/CHANGES.md b/CHANGES.md",
      "index 1..2 100644",
      "--- a/CHANGES.md",
      "+++ b/CHANGES.md",
      "@@ -1,0 +2 @@",
      "+### TRO-548",
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 3..4 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-// old",
      "+// new",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["CHANGES.md", "src/foo.ts"]);
    expect(files[1].changedLines).toEqual(["// old", "// new"]);
  });

  it("flags a binary file and collects no content lines for it", () => {
    const diff = [
      "diff --git a/image.png b/image.png",
      "index 1..2 100644",
      "Binary files a/image.png and b/image.png differ",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].binary).toBe(true);
    expect(files[0].changedLines).toEqual([]);
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("does not mistake the +++/--- file headers for content lines", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(parseUnifiedDiff(diff)[0].changedLines).toEqual(["x", "y"]);
  });
});

describe("isFileChangeBoring / isDiffBoring", () => {
  const file = (path: string, changedLines: string[], binary = false): ParsedDiffFile => ({
    path,
    binary,
    changedLines,
  });

  it("a boring path is boring regardless of its content", () => {
    expect(isFileChangeBoring(file("CHANGES.md", ["a whole new paragraph of real prose"]))).toBe(true);
    expect(isFileChangeBoring(file("factory/scorecard.jsonl", ['{"ticket":"x"}']))).toBe(true);
  });

  it("a non-boring path is boring only when every changed line is comment/blank", () => {
    expect(isFileChangeBoring(file("src/foo.ts", ["// a", "", "// b"]))).toBe(true);
    expect(isFileChangeBoring(file("src/foo.ts", ["// a", "const x = 2;"]))).toBe(false);
  });

  it("a binary file is never boring, even at a boring-looking path", () => {
    expect(isFileChangeBoring(file("factory/scorecard.jsonl", [], true))).toBe(false);
  });

  it("no changed files at all is boring — nothing to review", () => {
    expect(isDiffBoring([])).toBe(true);
  });

  it("every file must be boring for the whole diff to be boring", () => {
    const boring = [file("CHANGES.md", ["prose"]), file("src/foo.ts", ["// comment"])];
    expect(isDiffBoring(boring)).toBe(true);
    const mixed = [file("CHANGES.md", ["prose"]), file("src/foo.ts", ["const x = 2;"])];
    expect(isDiffBoring(mixed)).toBe(false);
  });
});

describe("planReview", () => {
  const previous: CaptureMeta = { sha: "aaa1111", capturedAt: "2026-08-13T00:00:00Z", findings: 4 };

  it("off mode never runs, regardless of history", () => {
    expect(planReview({ mode: "off", previous, currentSha: "bbb2222", diffSincePrevious: [] }, "main")).toEqual({
      kind: "off",
    });
  });

  it("the first review of a branch always runs full, in carry mode", () => {
    const plan = planReview({ mode: "carry", previous: null, currentSha: "bbb2222", diffSincePrevious: null }, "main");
    expect(plan).toEqual({ kind: "run", baseArgs: ["--base", "main"], scopedFromSha: null });
  });

  it("full mode always runs full, even with prior history", () => {
    const plan = planReview(
      { mode: "full", previous, currentSha: "bbb2222", diffSincePrevious: [] },
      "main",
    );
    expect(plan).toEqual({ kind: "run", baseArgs: ["--base", "main"], scopedFromSha: null });
  });

  it("carry mode at the same SHA as the last review carries forward — nothing changed", () => {
    const plan = planReview(
      { mode: "carry", previous, currentSha: previous.sha, diffSincePrevious: [] },
      "main",
    );
    expect(plan.kind).toBe("carried-forward");
    if (plan.kind === "carried-forward") {
      expect(plan.sha).toBe(previous.sha);
      expect(plan.findings).toBe(previous.findings);
    }
  });

  it("carry mode with a boring diff since the last review carries forward", () => {
    const boringDiff: ParsedDiffFile[] = [{ path: "CHANGES.md", binary: false, changedLines: ["prose"] }];
    const plan = planReview(
      { mode: "carry", previous, currentSha: "bbb2222", diffSincePrevious: boringDiff },
      "main",
    );
    expect(plan.kind).toBe("carried-forward");
  });

  it("carry mode with a real change since the last review scopes to --base-commit", () => {
    const realDiff: ParsedDiffFile[] = [{ path: "src/foo.ts", binary: false, changedLines: ["const x = 2;"] }];
    const plan = planReview(
      { mode: "carry", previous, currentSha: "bbb2222", diffSincePrevious: realDiff },
      "main",
    );
    expect(plan).toEqual({
      kind: "run",
      baseArgs: ["--base-commit", previous.sha],
      scopedFromSha: previous.sha,
    });
  });

  it("carry mode with an uncomputable diff (null) never guesses boring — always runs", () => {
    const plan = planReview(
      { mode: "carry", previous, currentSha: "bbb2222", diffSincePrevious: null },
      "main",
    );
    expect(plan).toEqual({
      kind: "run",
      baseArgs: ["--base-commit", previous.sha],
      scopedFromSha: previous.sha,
    });
  });
});

describe("formatCarriedForwardDetail", () => {
  it("names the carried-forward SHA and reason, per TRO-548's exact wording", () => {
    const detail = formatCarriedForwardDetail({
      kind: "carried-forward",
      sha: "aaa1111222",
      findings: 4,
      reason: "no changes since that review",
    });
    expect(detail).toContain("carried-forward from aaa1111");
    expect(detail).toContain("no changes since that review");
    expect(detail).toContain("4 finding(s)");
  });
});

// CodeRabbit finding (first full review, round 1): the fixture relied on
// repo/environment setup alone to avoid a global commit-signing prompt or a
// global hook interfering with `git commit`. Each git invocation below now
// passes -c overrides so the fixture cannot depend on the host's global git
// config at all. Each `it()` also wraps its body in try/finally so the temp
// directory is removed even when an assertion throws mid-test, not only on
// a clean run.
const GIT_FIXTURE_CONFIG = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "init.templateDir=",
];

function initGitFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "lh-review-scope-"));
  const run = (args: string[]) => execFileSync("git", [...GIT_FIXTURE_CONFIG, ...args], { cwd: dir, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  return dir;
}

function gitFixtureCommit(dir: string, msg: string): string {
  const run = (args: string[]) => execFileSync("git", [...GIT_FIXTURE_CONFIG, ...args], { cwd: dir, encoding: "utf8" });
  run(["add", "-A"]);
  run(["commit", "-q", "-m", msg]);
  return run(["rev-parse", "HEAD"]).trim();
}

describe("diffSince (real git integration)", () => {
  it("classifies a real sequence of boring and real commits correctly end-to-end", () => {
    const dir = initGitFixture();
    try {
      writeFileSync(join(dir, "CHANGES.md"), "# Changes\n");
      writeFileSync(join(dir, "foo.ts"), "export const x = 1;\n// a note\n");
      const c0 = gitFixtureCommit(dir, "c0: initial");

      writeFileSync(join(dir, "CHANGES.md"), "# Changes\n\n### TRO-548\n\nMore prose.\n");
      const c1 = gitFixtureCommit(dir, "c1: CHANGES.md only");
      expect(isDiffBoring(diffSince(dir, c0, c1)!)).toBe(true);

      writeFileSync(join(dir, "foo.ts"), "export const x = 1;\n// an updated note\n");
      const c2 = gitFixtureCommit(dir, "c2: comment-only");
      expect(isDiffBoring(diffSince(dir, c1, c2)!)).toBe(true);

      writeFileSync(join(dir, "foo.ts"), "export const x = 2;\n// an updated note\n");
      const c3 = gitFixtureCommit(dir, "c3: real code change");
      expect(isDiffBoring(diffSince(dir, c2, c3)!)).toBe(false);

      // Across the whole span (c0..c3), the real change still makes it non-boring.
      expect(isDiffBoring(diffSince(dir, c0, c3)!)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null, never a false boring read, when the SHA cannot be resolved", () => {
    const dir = initGitFixture();
    try {
      writeFileSync(join(dir, "CHANGES.md"), "# Changes\n");
      gitFixtureCommit(dir, "c0");
      expect(diffSince(dir, "0000000000000000000000000000000000000000", "HEAD")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isWorkingTreeDirty (real git integration)", () => {
  // CodeRabbit finding (first full review, round 1): planReview's
  // same-SHA carry-forward compares committed SHAs only. It has no
  // visibility into UNCOMMITTED content — a real gap when
  // review-capture.ts runs standalone, outside gate.sh's own full-mode
  // precondition (which already refuses on a dirty tree before G10 is
  // ever reached). main() now checks this directly and treats a dirty
  // tree as "no trustworthy previous capture" — see the dirty-tree branch
  // in main()'s own comment.
  it("is false right after a clean commit", () => {
    const dir = initGitFixture();
    try {
      writeFileSync(join(dir, "a.txt"), "one\n");
      gitFixtureCommit(dir, "c0");
      expect(isWorkingTreeDirty(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is true with an unstaged modification to a tracked file", () => {
    const dir = initGitFixture();
    try {
      writeFileSync(join(dir, "a.txt"), "one\n");
      gitFixtureCommit(dir, "c0");
      writeFileSync(join(dir, "a.txt"), "two\n");
      expect(isWorkingTreeDirty(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is true with a staged-but-uncommitted change", () => {
    const dir = initGitFixture();
    try {
      writeFileSync(join(dir, "a.txt"), "one\n");
      gitFixtureCommit(dir, "c0");
      writeFileSync(join(dir, "a.txt"), "two\n");
      execFileSync("git", [...GIT_FIXTURE_CONFIG, "add", "a.txt"], { cwd: dir });
      expect(isWorkingTreeDirty(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is true with an untracked file present", () => {
    const dir = initGitFixture();
    try {
      writeFileSync(join(dir, "a.txt"), "one\n");
      gitFixtureCommit(dir, "c0");
      writeFileSync(join(dir, "untracked.txt"), "new\n");
      expect(isWorkingTreeDirty(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decideCapture with scopedFromSha", () => {
  it("notes the scoped-since SHA in a fresh pass detail", () => {
    const d = decideCapture({
      rc: 0,
      timedOut: false,
      parsed: { findings: 2, lastError: null },
      previous: null,
      currentSha: "bbb2222",
      scopedFromSha: "aaa1111",
    });
    expect(d.status).toBe("pass");
    expect(d.detail).toContain("scoped since aaa1111");
  });

  it("omits the scoped-since note when this was a full-branch review", () => {
    const d = decideCapture({
      rc: 0,
      timedOut: false,
      parsed: { findings: 0, lastError: null },
      previous: null,
      currentSha: "bbb2222",
    });
    expect(d.detail).not.toContain("scoped since");
  });
});

describe("runCapture with baseArgs", () => {
  it("uses the provided baseArgs instead of the default --base <base>", () => {
    const runner = vi.fn().mockReturnValue({ rc: 0, stdout: "", stderr: "", timedOut: false });
    runCapture({
      base: "main",
      baseArgs: ["--base-commit", "aaa1111"],
      currentSha: "bbb2222",
      previous: null,
      runner,
    });
    expect(runner).toHaveBeenCalledWith(["review", "--agent", "--base-commit", "aaa1111"], expect.any(Number));
  });

  it("falls back to --base <base> when baseArgs is not provided", () => {
    const runner = vi.fn().mockReturnValue({ rc: 0, stdout: "", stderr: "", timedOut: false });
    runCapture({ base: "main", currentSha: "bbb2222", previous: null, runner });
    expect(runner).toHaveBeenCalledWith(["review", "--agent", "--base", "main"], expect.any(Number));
  });

  it("threads scopedFromSha through to the decision detail", () => {
    const runner = vi.fn().mockReturnValue({ rc: 0, stdout: '{"type":"finding"}\n', stderr: "", timedOut: false });
    const result = runCapture({
      base: "main",
      baseArgs: ["--base-commit", "aaa1111"],
      scopedFromSha: "aaa1111",
      currentSha: "bbb2222",
      previous: null,
      runner,
    });
    expect(result.decision.detail).toContain("scoped since aaa1111");
  });
});
