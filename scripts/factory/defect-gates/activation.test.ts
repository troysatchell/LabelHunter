import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decidePin, resolvePinFacts } from "./activation";

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

/** Runs a git command in a scratch repo, using an explicit test identity. */
function scratchGit(cwd: string, args: string): string {
  return execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd, encoding: "utf8" }).trim();
}

describe("resolvePinFacts", () => {
  it("resolves real facts on the success path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-activation-"));
    try {
      scratchGit(dir, "init -q");
      writeFileSync(join(dir, "a.ts"), "1\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "root"');
      const activatedAt = scratchGit(dir, "rev-parse HEAD");

      writeFileSync(join(dir, "a.ts"), "2\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "second"');
      writeFileSync(join(dir, "a.ts"), "3\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "third"');
      const baseSha = scratchGit(dir, "rev-parse HEAD");

      const result = resolvePinFacts(dir, baseSha, activatedAt);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.facts.mergeBaseIsAfterActivation).toBe(true);
      expect(result.facts.mainCommitsElapsed).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports ok:false, not a silent report-only default, when activatedAt is unresolvable", () => {
    // The failure this guards against: an unknown or rewritten activatedAt
    // must surface as an error, never quietly collapse to
    // mergeBaseIsAfterActivation: false (permanent report-only, no signal).
    const dir = mkdtempSync(join(tmpdir(), "dg-activation-"));
    try {
      scratchGit(dir, "init -q");
      writeFileSync(join(dir, "a.ts"), "1\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "root"');
      const baseSha = scratchGit(dir, "rev-parse HEAD");

      const result = resolvePinFacts(dir, baseSha, "0000000000000000000000000000000000000000");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.error).toContain("is-ancestor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports ok:false when baseRef itself does not resolve", () => {
    const dir = mkdtempSync(join(tmpdir(), "dg-activation-"));
    try {
      scratchGit(dir, "init -q");
      writeFileSync(join(dir, "a.ts"), "1\n");
      scratchGit(dir, "add a.ts");
      scratchGit(dir, 'commit -q -m "root"');
      const activatedAt = scratchGit(dir, "rev-parse HEAD");

      const result = resolvePinFacts(dir, "no-such-ref", activatedAt);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.error).toContain("merge-base");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
