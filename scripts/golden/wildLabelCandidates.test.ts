/**
 * Tests for the wild-label candidate staging file (LH-027 / TRO-530):
 * `golden-set/wild-labels/candidates.json` and its loader
 * (`wildLabelEval.ts`'s `loadWildLabelCandidates`). See
 * `golden-set/wild-labels/README.md` for why these 5 cases are staged
 * here rather than in `golden-set/manifest.json`.
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../src/lib/golden-set/loader";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import { loadWildLabelCandidates } from "./wildLabelEval";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REAL_CANDIDATES_PATH = path.resolve(REPO_ROOT, "golden-set/wild-labels/candidates.json");

describe("loadWildLabelCandidates — the real committed file", () => {
  it("loads the real candidates.json with no error", () => {
    expect(() => loadWildLabelCandidates(REAL_CANDIDATES_PATH)).not.toThrow();
  });

  it("has about 5 cases, per the ticket", () => {
    const cases = loadWildLabelCandidates(REAL_CANDIDATES_PATH);
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases.length).toBeLessThanOrEqual(6);
  });

  it("keeps every case provenance ai-generated and verified false", () => {
    for (const c of loadWildLabelCandidates(REAL_CANDIDATES_PATH)) {
      expect(c.provenance, c.caseId).toBe("ai-generated");
      expect(c.verified, c.caseId).toBe(false);
    }
  });

  it("has a real, non-empty committed image for every case", () => {
    for (const c of loadWildLabelCandidates(REAL_CANDIDATES_PATH)) {
      const fullPath = path.resolve(REPO_ROOT, c.imagePath);
      expect(existsSync(fullPath), `${c.caseId}: expected a file at ${c.imagePath}`).toBe(true);
      expect(statSync(fullPath).size, c.caseId).toBeGreaterThan(0);
    }
  });

  it("is otherwise schema-shaped like a real GoldenSetCase (verified + imagePath patched to their post-fold-in values for this check ONLY, never written to disk)", () => {
    // validateManifest's own hard rule (loader.ts's checkCase, tested at
    // loader.test.ts) refuses to load ANY manifest containing an
    // unverified ai-generated case -- by design (see this directory's
    // README.md). That rule is exactly why these 5 cases live here and not
    // in golden-set/manifest.json. imagePath is staged at
    // golden-set/wild-labels/ for the same documented reason (README.md's
    // fold-in step 1 renames it to golden-set/images/ at fold-in time). To
    // still get real schema-shape assurance on every OTHER field, this
    // test clones each case with both values patched to what fold-in will
    // actually produce, runs the clone through the real validator, and
    // discards it -- candidates.json itself, and loadWildLabelCandidates's
    // own return value, are never touched.
    const patched: GoldenSetCase[] = loadWildLabelCandidates(REAL_CANDIDATES_PATH).map((c) => ({
      ...c,
      verified: true,
      imagePath: c.imagePath.replace("golden-set/wild-labels/", "golden-set/images/"),
    }));
    expect(() => validateManifest({ version: "1.0.0", cases: patched })).not.toThrow();
  });

  it("gives every case a non-empty governmentWarningText transcription", () => {
    for (const c of loadWildLabelCandidates(REAL_CANDIDATES_PATH)) {
      expect(c.label.governmentWarningText.length, c.caseId).toBeGreaterThan(0);
    }
  });

  it("varies category across the set -- not every case is the same defect type", () => {
    const categories = new Set(loadWildLabelCandidates(REAL_CANDIDATES_PATH).map((c) => c.category));
    expect(categories.size).toBeGreaterThan(1);
  });

  it("includes at least one non-PASS case -- ground truth flows from the image, so a real generation defect is expected, not required to be hidden", () => {
    const verdicts = loadWildLabelCandidates(REAL_CANDIDATES_PATH).map((c) => c.expected.labelVerdict);
    expect(verdicts.some((v) => v !== "PASS")).toBe(true);
  });
});

describe("loadWildLabelCandidates — error handling", () => {
  const tempFiles: string[] = [];
  function writeTempFile(content: unknown): string {
    const dir = mkdtempSync(path.join(tmpdir(), "wild-label-candidates-test-"));
    tempFiles.push(dir);
    const file = path.join(dir, "candidates.json");
    writeFileSync(file, JSON.stringify(content));
    return file;
  }

  function cleanup(): void {
    for (const dir of tempFiles.splice(0)) rmSync(dir, { recursive: true, force: true });
  }

  it("throws a clear error when the file has no cases array", () => {
    const file = writeTempFile({ note: "x" });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/does not have a "cases" array/);
    } finally {
      cleanup();
    }
  });

  it("throws a clear error when cases is empty", () => {
    const file = writeTempFile({ cases: [] });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/zero cases/);
    } finally {
      cleanup();
    }
  });

  // A malformed cases[] entry must produce THIS file's own clear,
  // wildLabelEval-prefixed error -- not a raw TypeError from reading
  // .caseId (or similar) off something that isn't the shape it's assumed
  // to be (CodeRabbit finding, round 3; lessons.md rule 13: "validate at
  // the boundary where a value's shape is only assumed, not guaranteed").
  it("throws a clear error when a cases[] entry is null", () => {
    const file = writeTempFile({ cases: [null] });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/wildLabelEval:.*must be an object/);
    } finally {
      cleanup();
    }
  });

  it("throws a clear error when a cases[] entry is not an object", () => {
    const file = writeTempFile({ cases: ["not-a-case"] });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/wildLabelEval:.*must be an object/);
    } finally {
      cleanup();
    }
  });

  it("throws a clear error when a cases[] entry has no string caseId", () => {
    const file = writeTempFile({
      cases: [{ provenance: "ai-generated", verified: false, imagePath: "golden-set/wild-labels/case-43-odd-typography-wild-highcontrast-gin.png" }],
    });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/must have a string caseId/);
    } finally {
      cleanup();
    }
  });

  it("throws a clear error when a cases[] entry has no string imagePath", () => {
    const file = writeTempFile({ cases: [{ caseId: "x", provenance: "ai-generated", verified: false }] });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/must have a string imagePath/);
    } finally {
      cleanup();
    }
  });

  it("throws when a case's provenance is not ai-generated", () => {
    const file = writeTempFile({ cases: [{ caseId: "x", provenance: "rendered", verified: false, imagePath: "golden-set/images/case-01-clean-match-spirits.jpg" }] });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/expected "ai-generated"/);
    } finally {
      cleanup();
    }
  });

  it("throws when a case is verified: true -- that case belongs in the real manifest, not this staging file", () => {
    const file = writeTempFile({ cases: [{ caseId: "x", provenance: "ai-generated", verified: true, imagePath: "golden-set/images/case-01-clean-match-spirits.jpg" }] });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/belongs in golden-set\/manifest\.json/);
    } finally {
      cleanup();
    }
  });

  it("throws when a case's imagePath does not resolve to a real file", () => {
    const file = writeTempFile({ cases: [{ caseId: "x", provenance: "ai-generated", verified: false, imagePath: "golden-set/wild-labels/does-not-exist.png" }] });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/no file at/);
    } finally {
      cleanup();
    }
  });

  it("throws when a case is missing required manifest fields (application/label/expected/category/etc.) -- full schema validation, not just the ad hoc checks", () => {
    // Passes every ad hoc check above (provenance, verified, imagePath) but
    // is missing almost every other GoldenSetCase field. The loader must
    // still catch this via the real, shared validateManifest -- the same
    // technique wildLabelCandidates.test.ts's own schema-shape test uses
    // (verified/imagePath patched to their post-fold-in values) -- rather
    // than silently returning a malformed case a real, paid runOneCase
    // call would then be handed (CodeRabbit finding, round 2).
    const file = writeTempFile({
      cases: [
        {
          caseId: "x",
          provenance: "ai-generated",
          verified: false,
          imagePath: "golden-set/wild-labels/case-43-odd-typography-wild-highcontrast-gin.png",
        },
      ],
    });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/missing required field/);
    } finally {
      cleanup();
    }
  });

  it("rejects an absolute imagePath, before ever touching the filesystem", () => {
    const file = writeTempFile({
      cases: [{ caseId: "x", provenance: "ai-generated", verified: false, imagePath: "/etc/passwd" }],
    });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/must be a relative path/);
    } finally {
      cleanup();
    }
  });

  it("rejects an imagePath that resolves outside golden-set/wild-labels/, even when the target file is real", () => {
    // golden-set/images/case-01-clean-match-spirits.jpg is a real, committed
    // file -- this proves the containment check fires even when the escape
    // target genuinely exists, not only on a missing-file path.
    const file = writeTempFile({
      cases: [
        {
          caseId: "x",
          provenance: "ai-generated",
          verified: false,
          imagePath: "golden-set/wild-labels/../images/case-01-clean-match-spirits.jpg",
        },
      ],
    });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/resolves outside golden-set\/wild-labels/);
    } finally {
      cleanup();
    }
  });

  it("rejects an imagePath that names a real directory, not a file", () => {
    // golden-set/wild-labels/results/ is a real, committed directory.
    const file = writeTempFile({
      cases: [{ caseId: "x", provenance: "ai-generated", verified: false, imagePath: "golden-set/wild-labels/results" }],
    });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/non-empty regular file/);
    } finally {
      cleanup();
    }
  });

  it("rejects an imagePath that names a real, empty (zero-byte) file", () => {
    // A unique mkdtempSync directory INSIDE golden-set/wild-labels/ (not a
    // fixed filename directly in the real staging directory) so a failed
    // cleanup or a concurrent test run can never collide with, or leave a
    // stray file alongside, this repo's real committed candidates
    // (CodeRabbit finding, round 2).
    const emptyFileDir = mkdtempSync(path.resolve(REPO_ROOT, "golden-set/wild-labels", ".tro-530-test-"));
    const emptyFilePath = path.join(emptyFileDir, "empty.png");
    writeFileSync(emptyFilePath, Buffer.alloc(0));
    const file = writeTempFile({
      cases: [
        {
          caseId: "x",
          provenance: "ai-generated",
          verified: false,
          imagePath: path.relative(REPO_ROOT, emptyFilePath),
        },
      ],
    });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/non-empty regular file/);
    } finally {
      rmSync(emptyFileDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("throws on a duplicate caseId", () => {
    const shared = {
      provenance: "ai-generated",
      verified: false,
      // Must resolve inside golden-set/wild-labels/ -- a real, committed
      // file there -- so the first "dup" entry passes every per-case check
      // (including the containment check) and the loop actually reaches
      // the second entry, where the duplicate-ID check is the thing under
      // test here.
      imagePath: "golden-set/wild-labels/case-43-odd-typography-wild-highcontrast-gin.png",
    };
    const file = writeTempFile({ cases: [{ caseId: "dup", ...shared }, { caseId: "dup", ...shared }] });
    try {
      expect(() => loadWildLabelCandidates(file)).toThrow(/duplicate caseId/);
    } finally {
      cleanup();
    }
  });
});
