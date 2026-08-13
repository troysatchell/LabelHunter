import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { currentCommitSha, lastCommitTouchingPath } from "./git-provenance";

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
