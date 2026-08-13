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
 * by design. What it actually proves: the COMMITTED FILE, on disk right
 * now, records the authorized 32-case x 3-repeat scope, a positive total
 * cost, and full provenance (model IDs, commit SHA, manifest hash) — the
 * shape and values `variance.ts` writes after a real, live, `--full
 * --repeats=3` sweep. It does NOT independently confirm that a live API
 * call produced this file — a hand-edited JSON matching this shape would
 * pass too. That confirmation lives outside a unit test: the sweep's own
 * console log, the independently-recomputed manifest hash noted in this
 * ticket's `CHANGES.md` entry, and Troy's authorization record. This test's
 * real job is narrower and still valuable: catch a future commit that
 * silently narrows or corrupts the artifact this ticket produced. Not to
 * re-prove the arithmetic inside `variance-analysis.ts` (the pure-function
 * suite already owns that). Before the sweep ran, this test was RED: the
 * artifact did not exist on disk at all. After the sweep's report was
 * committed, this test went GREEN. If a future change commits a narrower
 * report over this one (fewer cases, fewer repeats, an incomplete sweep),
 * this test goes red again — that IS a real coverage gap, not a false
 * alarm, so it is never weakened to pass a narrower artifact.
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
    // 8-case DEFAULT_SAMPLE_CASE_IDS smoke sample (args.ts). Distinct, not
    // just 32 in length -- a duplicate case ID could still satisfy a bare
    // length check while covering fewer than 32 real cases.
    expect(report.caseIds).toHaveLength(32);
    const caseIdSet = new Set(report.caseIds);
    expect(caseIdSet.size).toBe(32);
    expect(report.requestedFull).toBe(true);
    expect(report.summary.caseCount).toBe(32);
    // summary.perCase carries one row per case -- the SAME 32 case IDs
    // caseIds names, not merely a same-sized but different set. A row-count
    // match alone cannot catch two collections that each have 32 entries
    // but disagree on which 32.
    expect(report.summary.perCase).toHaveLength(32);
    const perCaseIdSet = new Set(report.summary.perCase.map((c) => c.caseId));
    expect(perCaseIdSet).toEqual(caseIdSet);

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

    // Every case ran repeats 1, 2, and 3 -- exactly once each. This checks
    // the real distribution of runs.json, independent of
    // incompleteCaseCount (which is computed FROM this same data by
    // variance-analysis.ts -- a bug shared between the writer and this
    // check would not show up as a mismatch there).
    const repeatIndexesByCase = new Map<string, number[]>();
    for (const run of report.runs) {
      const existing = repeatIndexesByCase.get(run.caseId) ?? [];
      existing.push(run.repeatIndex);
      repeatIndexesByCase.set(run.caseId, existing);
    }
    expect(repeatIndexesByCase.size).toBe(32);
    // Same caseIdSet the summary.perCase check above uses -- runs.json's
    // own case IDs must be the SAME 32, not just 32 of some other set.
    expect(new Set(repeatIndexesByCase.keys())).toEqual(caseIdSet);
    for (const [caseId, indexes] of repeatIndexesByCase) {
      expect(indexes.slice().sort((a, b) => a - b), `case ${caseId}`).toEqual([1, 2, 3]);
    }

    // Real measured cost. Never a fabricated or zero placeholder
    // (CLAUDE.md: "never fabricate a number").
    expect(report.totalCostUsd).toBeGreaterThan(0);

    // Exact model IDs -- literal strings on purpose, not
    // HAIKU_EXTRACTOR_MODEL/SONNET_RESOLVER_MODEL imported from src/server.
    // Importing them would make this assertion tautological against
    // exactly the regression it should catch: if either constant's own
    // value ever drifted (a wrong edit, an accidental downgrade), a
    // same-constant comparison would silently drift with it and still
    // pass. The literal string independently confirms the artifact records
    // the real, intended model.
    expect(report.haikuModel).toBe("claude-haiku-4-5");
    expect(report.sonnetModel).toBe("claude-sonnet-5");

    // Provenance: commit SHA and manifest content hash, both present
    // (TH-R19 discipline -- a measured number is worthless without knowing
    // which code and which golden set produced it). manifestContentHash is
    // typed string | null (validateVarianceReport allows a hash-less report
    // by design) -- check it is actually a string before the regex match,
    // so a null here fails on a clear "must be present" assertion instead
    // of a confusing regex-on-null error.
    expect(report.commitSha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(typeof report.manifestContentHash).toBe("string");
    expect(report.manifestContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof report.measuredAt).toBe("string");
    expect(Number.isNaN(new Date(report.measuredAt).getTime())).toBe(false);
  });
});
