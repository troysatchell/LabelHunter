import { describe, expect, it, vi } from "vitest";
import {
  backoffMs,
  decideCapture,
  isRateLimitError,
  parseCoderabbitOutput,
  parsePositiveIntEnv,
  runCapture,
  type CaptureMeta,
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
});
