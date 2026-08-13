/**
 * G6 red-first test for the Part 2 authorized paid sweep (LH-038 / TRO-543
 * Part 2). Loads the COMMITTED `scripts/eval/results/variance-report.json`
 * artifact straight off disk — a real measured report, not a synthetic
 * fixture (`report-validation.test.ts`'s own `validateVarianceReport` suite
 * already covers the synthetic-fixture shape checks) — and asserts the
 * 32-case x 3-repeat contract Troy authorized on the Linear ticket,
 * 2026-08-13.
 *
 * DELIBERATE COUPLING, STATED OUT LOUD. This test reads a measured artifact
 * by design. It exists to prove the authorized sweep actually ran, at the
 * scope Troy authorized, with a real non-zero measured cost and full
 * provenance — not to re-prove the arithmetic inside `variance-analysis.ts`
 * (the pure-function suite already owns that). Before the sweep ran, this
 * test is RED: the artifact did not exist on disk at all. After a clean
 * `--live --full --repeats=3` sweep is committed, this test is GREEN. If a
 * future change commits a narrower report over this one (fewer cases, fewer
 * repeats, an incomplete sweep), this test goes red again — that IS a real
 * coverage gap, not a false alarm, so it is never weakened to pass a
 * narrower artifact.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateVarianceReport } from "./report-validation";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPORT_PATH = path.resolve(REPO_ROOT, "scripts/eval/results/variance-report.json");

describe("variance-report.json — the TRO-543 Part 2 authorized sweep artifact", () => {
  it("exists as a committed file", () => {
    expect(existsSync(REPORT_PATH)).toBe(true);
  });

  it("covers all 32 golden-set cases, 3 repeats each, with a real measured cost and full provenance", () => {
    const parsed: unknown = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
    const report = validateVarianceReport(parsed, REPORT_PATH);

    // N = 32 -- the full golden set, Troy's authorized scope. Not the
    // 8-case DEFAULT_SAMPLE_CASE_IDS smoke sample (args.ts).
    expect(report.caseIds).toHaveLength(32);
    expect(report.requestedFull).toBe(true);
    expect(report.summary.caseCount).toBe(32);

    // K = 3 repeats -- exactly what Troy authorized. Not MAX_REPEATS (10),
    // and not silently narrowed to fewer.
    expect(report.repeats).toBe(3);
    expect(report.summary.nominalRepeats).toBe(3);

    // A clean, complete sweep: every one of the 32 cases finished all 3
    // repeats, so the headline stability and accuracy figures rest on the
    // full population, not a partial one (standing rule: uncertain beats
    // wrong).
    expect(report.summary.incompleteCaseCount).toBe(0);
    expect(report.runs).toHaveLength(32 * 3);
    expect(report.failures).toHaveLength(0);

    // Real measured cost. Never a fabricated or zero placeholder
    // (CLAUDE.md: "never fabricate a number").
    expect(report.totalCostUsd).toBeGreaterThan(0);

    // Exact model IDs, matching the cascade's own exported constants -- not
    // a placeholder string.
    expect(report.haikuModel).toBe("claude-haiku-4-5");
    expect(report.sonnetModel).toBe("claude-sonnet-5");

    // Provenance: commit SHA and manifest content hash, both present
    // (TH-R19 discipline -- a measured number is worthless without knowing
    // which code and which golden set produced it).
    expect(report.commitSha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(report.manifestContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof report.measuredAt).toBe("string");
    expect(Number.isNaN(new Date(report.measuredAt).getTime())).toBe(false);
  });
});
