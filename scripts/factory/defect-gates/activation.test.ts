import { describe, expect, it } from "vitest";
import { decidePin } from "./activation";

describe("decidePin", () => {
  it("is blocking when the rule has no activation commit yet", () => {
    // A rule before activation cannot retroactively block anything, so the
    // pin is irrelevant and the caller's own severity governs.
    const d = decidePin({
      activatedAt: null,
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: null,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("blocking");
  });

  it("is blocking when the merge-base already contains the activation commit", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: true,
      mainCommitsElapsed: 3,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("blocking");
  });

  it("is report-only when the branch predates activation", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 3,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("report-only");
  });

  it("is blocking once main has advanced past the expiry, even if the branch predates activation", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 26,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("blocking");
  });

  it("is report-only exactly at the expiry boundary", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 25,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("report-only");
  });

  it("carries the diagnostics needed to report the pin", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 7,
      expiresAfter: 25,
    });
    expect(d).toMatchObject({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 7,
      expiresAfter: 25,
    });
  });
});
