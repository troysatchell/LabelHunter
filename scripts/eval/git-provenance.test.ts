import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { assertPathTreeClean, currentCommitSha, lastCommitTouchingPath } from "./git-provenance";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const mockExecFileSync = vi.mocked(execFileSync);

describe("currentCommitSha", () => {
  it("returns the trimmed output of git rev-parse HEAD", () => {
    mockExecFileSync.mockReturnValueOnce("deadbeefcafe\n" as unknown as ReturnType<typeof execFileSync>);
    expect(currentCommitSha("/repo")).toBe("deadbeefcafe");
    expect(mockExecFileSync).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], { cwd: "/repo", encoding: "utf8" });
  });

  it("returns \"unknown\" and warns, never throws, when the git command fails", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("not a git repository");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(currentCommitSha("/repo")).toBe("unknown");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not read the current commit SHA"));
    warn.mockRestore();
  });
});

describe("lastCommitTouchingPath", () => {
  it("returns the trimmed output of git log -1 --format=%H -- <path>", () => {
    mockExecFileSync.mockReturnValueOnce("cafed00d\n" as unknown as ReturnType<typeof execFileSync>);
    expect(lastCommitTouchingPath("/repo", "golden-set")).toBe("cafed00d");
    expect(mockExecFileSync).toHaveBeenCalledWith("git", ["log", "-1", "--format=%H", "--", "golden-set"], {
      cwd: "/repo",
      encoding: "utf8",
    });
  });

  it("throws when the git command fails — no silent \"unknown\" fallback (TRO-561: the corpus SHA is a design requirement, not decoration)", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("not a git repository");
    });
    expect(() => lastCommitTouchingPath("/repo", "golden-set")).toThrow(/could not determine the last commit/);
  });

  it("throws when the command succeeds with empty output — no history has ever touched the path", () => {
    mockExecFileSync.mockReturnValueOnce("\n" as unknown as ReturnType<typeof execFileSync>);
    expect(() => lastCommitTouchingPath("/repo", "golden-set")).toThrow(/no commit in this branch's history touches/);
  });
});

describe("assertPathTreeClean", () => {
  it("does not throw when `git status --porcelain -- <path>` reports no changes", () => {
    mockExecFileSync.mockReturnValueOnce("" as unknown as ReturnType<typeof execFileSync>);
    expect(() => assertPathTreeClean("/repo", "golden-set")).not.toThrow();
    expect(mockExecFileSync).toHaveBeenCalledWith("git", ["status", "--porcelain", "--", "golden-set"], {
      cwd: "/repo",
      encoding: "utf8",
    });
  });

  it(
    "throws — TRO-564 regression: a recorded provenance SHA must not outrun an uncommitted " +
      "change — when the path has a modified tracked file",
    () => {
      mockExecFileSync.mockReturnValueOnce(" M golden-set/images/case-01.jpg\n" as unknown as ReturnType<typeof execFileSync>);
      expect(() => assertPathTreeClean("/repo", "golden-set")).toThrow(/golden-set.*uncommitted change/);
    },
  );

  it("throws when the path has an untracked file", () => {
    mockExecFileSync.mockReturnValueOnce("?? golden-set/images/case-99-new.jpg\n" as unknown as ReturnType<typeof execFileSync>);
    expect(() => assertPathTreeClean("/repo", "golden-set")).toThrow(/uncommitted change/);
  });

  it("throws when the git command itself fails", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("not a git repository");
    });
    expect(() => assertPathTreeClean("/repo", "golden-set")).toThrow(/could not check whether "golden-set" is clean/);
  });
});
