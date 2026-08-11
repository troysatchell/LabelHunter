/**
 * Tests for the latency harness's exit-code decision (TRO-471 / LH-031).
 * Pure function, synthetic inputs only — no live call, no network.
 */
import { describe, expect, it } from "vitest";
import { computeExitCode } from "./exit-status";

const CLEAN: Parameters<typeof computeExitCode>[0] = {
  successfulCount: 20,
  failedCount: 0,
  cleanupFailureCount: 0,
  scratchDirCleanupError: null,
  closePoolError: null,
};

describe("computeExitCode", () => {
  it("returns 0 when every run succeeded and nothing needs cleanup follow-up", () => {
    expect(computeExitCode(CLEAN)).toBe(0);
  });

  it("returns 1 when no run succeeded", () => {
    expect(computeExitCode({ ...CLEAN, successfulCount: 0, failedCount: 20 })).toBe(1);
  });

  it("returns 1 when some runs failed even though others succeeded", () => {
    expect(computeExitCode({ ...CLEAN, successfulCount: 15, failedCount: 5 })).toBe(1);
  });

  it("returns 1 on an application-row cleanup failure", () => {
    expect(computeExitCode({ ...CLEAN, cleanupFailureCount: 1 })).toBe(1);
  });

  it("returns 1 on a scratch-directory cleanup error", () => {
    expect(computeExitCode({ ...CLEAN, scratchDirCleanupError: "EACCES" })).toBe(1);
  });

  it("returns 1 on a pool-close error", () => {
    expect(computeExitCode({ ...CLEAN, closePoolError: "pool already ended" })).toBe(1);
  });
});
