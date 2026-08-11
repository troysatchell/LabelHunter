/**
 * Tests for the latency harness's cleanup control flow (TRO-471 / LH-031).
 * Every dependency here is a fake closure — no real filesystem removal, no
 * real database pool, no live call. Regression coverage for a real PR
 * review finding: an `rm()` failure must not propagate past cleanup and
 * skip the harness's own report-writing code.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanupScratchDirAndPool } from "./cleanup";

describe("cleanupScratchDirAndPool", () => {
  it("reports scratchDirCleanupError as null on a clean removal", async () => {
    const removeScratchDir = vi.fn().mockResolvedValue(undefined);
    const closePool = vi.fn().mockResolvedValue(undefined);

    const outcome = await cleanupScratchDirAndPool(removeScratchDir, closePool);

    expect(outcome.scratchDirCleanupError).toBeNull();
    expect(closePool).toHaveBeenCalledTimes(1);
  });

  it("never throws when removeScratchDir rejects — the caller must still reach its report", async () => {
    const removeScratchDir = vi.fn().mockRejectedValue(new Error("EACCES: permission denied"));
    const closePool = vi.fn().mockResolvedValue(undefined);

    // The regression this guards: a version of this function that just
    // re-threw removeScratchDir's error would make this line itself throw,
    // failing the test with an unhandled rejection — not a normal assertion
    // failure. Awaiting it directly, with no try/catch here, is the point.
    const outcome = await cleanupScratchDirAndPool(removeScratchDir, closePool);

    expect(outcome.scratchDirCleanupError).toBe("EACCES: permission denied");
  });

  it("still closes the pool even when removeScratchDir rejects", async () => {
    const removeScratchDir = vi.fn().mockRejectedValue(new Error("disk error"));
    const closePool = vi.fn().mockResolvedValue(undefined);

    await cleanupScratchDirAndPool(removeScratchDir, closePool);

    // An open pool keeps the Node event loop alive — this is the property
    // that matters, not just "no error was thrown".
    expect(closePool).toHaveBeenCalledTimes(1);
  });

  it("wraps a non-Error rejection into a string, same as the rest of this harness", async () => {
    const removeScratchDir = vi.fn().mockRejectedValue("a plain string rejection");
    const closePool = vi.fn().mockResolvedValue(undefined);

    const outcome = await cleanupScratchDirAndPool(removeScratchDir, closePool);

    expect(outcome.scratchDirCleanupError).toBe("a plain string rejection");
  });

  it("calls removeScratchDir before closePool on the happy path", async () => {
    const order: string[] = [];
    const removeScratchDir = vi.fn().mockImplementation(async () => {
      order.push("remove");
    });
    const closePool = vi.fn().mockImplementation(async () => {
      order.push("close");
    });

    await cleanupScratchDirAndPool(removeScratchDir, closePool);

    expect(order).toEqual(["remove", "close"]);
  });
});
