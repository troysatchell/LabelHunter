/**
 * Regression tests for the TRO-559 artifact write-path guard. Uses a real
 * temp directory (`mkdtempSync`/`rmSync`) per case rather than mocking
 * `node:fs` — the same pattern `scripts/golden/verify.test.ts` and
 * `variance.ts`'s own `mkdtemp` usage already establish in this repo — so
 * the assertions are about real file bytes on disk, not about which fs
 * functions got called.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArtifactGuardArgs, resolveGuardedOutputPath, writeGuardedJsonArtifact } from "./artifact-guard";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "artifact-guard-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeGuardedJsonArtifact", () => {
  it("writes and round-trips content on a fresh default path", () => {
    const repoRoot = makeTempDir();
    const defaultPath = path.join(repoRoot, "results", "artifact.json");

    const written = writeGuardedJsonArtifact({
      repoRoot,
      defaultPath,
      guard: { out: null, force: false },
      content: { n: 1 },
    });

    expect(written).toBe(defaultPath);
    expect(JSON.parse(readFileSync(defaultPath, "utf8"))).toEqual({ n: 1 });
  });

  it(
    "TRO-559 regression: a second no-flag write refuses to overwrite the first, and leaves the " +
      "first write's content untouched (proves it did not partially clobber before throwing)",
    () => {
      const repoRoot = makeTempDir();
      const defaultPath = path.join(repoRoot, "results", "artifact.json");

      writeGuardedJsonArtifact({ repoRoot, defaultPath, guard: { out: null, force: false }, content: { n: 1 } });

      expect(() =>
        writeGuardedJsonArtifact({ repoRoot, defaultPath, guard: { out: null, force: false }, content: { n: 2 } }),
      ).toThrow(/refusing to overwrite/);

      expect(JSON.parse(readFileSync(defaultPath, "utf8"))).toEqual({ n: 1 });
    },
  );

  it("--out=<path> writes a second, separate file and leaves the original default-path file untouched", () => {
    const repoRoot = makeTempDir();
    const defaultPath = path.join(repoRoot, "results", "artifact.json");
    const outPath = path.join(repoRoot, "results", "artifact-comparison.json");

    writeGuardedJsonArtifact({ repoRoot, defaultPath, guard: { out: null, force: false }, content: { n: 1 } });
    const written = writeGuardedJsonArtifact({
      repoRoot,
      defaultPath,
      guard: { out: outPath, force: false },
      content: { n: 2 },
    });

    expect(written).toBe(outPath);
    expect(JSON.parse(readFileSync(defaultPath, "utf8"))).toEqual({ n: 1 });
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({ n: 2 });
  });

  it("--force deliberately overwrites the default path", () => {
    const repoRoot = makeTempDir();
    const defaultPath = path.join(repoRoot, "results", "artifact.json");

    writeGuardedJsonArtifact({ repoRoot, defaultPath, guard: { out: null, force: false }, content: { n: 1 } });
    const written = writeGuardedJsonArtifact({
      repoRoot,
      defaultPath,
      guard: { out: null, force: true },
      content: { n: 2 },
    });

    expect(written).toBe(defaultPath);
    expect(JSON.parse(readFileSync(defaultPath, "utf8"))).toEqual({ n: 2 });
  });
});

describe("resolveGuardedOutputPath", () => {
  it("does not create a file — pure path logic plus one existsSync check", () => {
    const repoRoot = makeTempDir();
    const defaultPath = path.join(repoRoot, "results", "artifact.json");

    const resolved = resolveGuardedOutputPath({ repoRoot, defaultPath, guard: { out: null, force: false } });

    expect(resolved).toBe(defaultPath);
    expect(existsSync(resolved)).toBe(false);
  });
});

describe("parseArtifactGuardArgs", () => {
  it("defaults to { out: null, force: false } on empty argv", () => {
    expect(parseArtifactGuardArgs([])).toEqual({ guard: { out: null, force: false }, rest: [] });
  });

  it("parses --out=<path>", () => {
    expect(parseArtifactGuardArgs(["--out=results/foo.json"])).toEqual({
      guard: { out: "results/foo.json", force: false },
      rest: [],
    });
  });

  it("parses --force", () => {
    expect(parseArtifactGuardArgs(["--force"])).toEqual({ guard: { out: null, force: true }, rest: [] });
  });

  it("parses --out and --force together, in either order", () => {
    expect(parseArtifactGuardArgs(["--out=results/foo.json", "--force"])).toEqual({
      guard: { out: "results/foo.json", force: true },
      rest: [],
    });
    expect(parseArtifactGuardArgs(["--force", "--out=results/foo.json"])).toEqual({
      guard: { out: "results/foo.json", force: true },
      rest: [],
    });
  });

  it("leaves unrecognized flags in rest, for a caller-specific parser to handle", () => {
    expect(parseArtifactGuardArgs(["--live", "--force", "--full"])).toEqual({
      guard: { out: null, force: true },
      rest: ["--live", "--full"],
    });
  });

  it("rejects --out passed more than once", () => {
    expect(() => parseArtifactGuardArgs(["--out=a.json", "--out=b.json"])).toThrow(/--out may be passed at most once/);
  });
});
