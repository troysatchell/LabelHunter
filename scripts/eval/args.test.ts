import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import {
  DEFAULT_REPEATS,
  DEFAULT_SAMPLE_ACTUAL_REVIEW_REASONS,
  DEFAULT_SAMPLE_CASE_IDS,
  MAX_CASES,
  MAX_REPEATS,
  parseEvalArgs,
  parseVarianceArgs,
  resolveCaseIds,
  validateCheckArgs,
  validateVarianceArgs,
} from "./args";
import { validateEvalReport } from "./report-validation";

describe("parseEvalArgs", () => {
  it("defaults to cheap mode: live=false, full=false, no case, no baseline update", () => {
    expect(parseEvalArgs([])).toEqual({ live: false, full: false, caseId: null, updateBaseline: false });
  });

  it("parses --live alone", () => {
    expect(parseEvalArgs(["--live"])).toEqual({ live: true, full: false, caseId: null, updateBaseline: false });
  });

  it("parses --live --full", () => {
    expect(parseEvalArgs(["--live", "--full"])).toEqual({
      live: true,
      full: true,
      caseId: null,
      updateBaseline: false,
    });
  });

  it("parses --live --case=<id>", () => {
    expect(parseEvalArgs(["--live", "--case=case-01-clean-match-spirits"])).toEqual({
      live: true,
      full: false,
      caseId: "case-01-clean-match-spirits",
      updateBaseline: false,
    });
  });

  it("parses --live --update-baseline", () => {
    expect(parseEvalArgs(["--live", "--update-baseline"])).toEqual({
      live: true,
      full: false,
      caseId: null,
      updateBaseline: true,
    });
  });

  it("skips a literal -- token (pnpm's argv-forwarding quirk)", () => {
    expect(parseEvalArgs(["--", "--live"])).toEqual({ live: true, full: false, caseId: null, updateBaseline: false });
  });

  it("throws on an unrecognized argument", () => {
    expect(() => parseEvalArgs(["--bogus"])).toThrow(/unrecognized argument "--bogus"/);
  });

  it("throws when --full and --case=<id> are combined", () => {
    expect(() => parseEvalArgs(["--live", "--full", "--case=case-01-clean-match-spirits"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("does NOT itself require --live to accompany --full/--case/--update-baseline (that is check.ts's own rule — see validateCheckArgs below)", () => {
    expect(parseEvalArgs(["--full"])).toEqual({ live: false, full: true, caseId: null, updateBaseline: false });
    expect(parseEvalArgs(["--update-baseline"])).toEqual({ live: false, full: false, caseId: null, updateBaseline: true });
  });
});

describe("validateCheckArgs", () => {
  it("passes for cheap mode (no flags)", () => {
    expect(() => validateCheckArgs(parseEvalArgs([]))).not.toThrow();
  });

  it("passes for a valid --live run", () => {
    expect(() => validateCheckArgs(parseEvalArgs(["--live", "--full"]))).not.toThrow();
  });

  it("throws when --update-baseline is passed without --live", () => {
    expect(() => validateCheckArgs(parseEvalArgs(["--update-baseline"]))).toThrow(/--update-baseline requires --live/);
  });

  it("throws when --full is passed without --live", () => {
    expect(() => validateCheckArgs(parseEvalArgs(["--full"]))).toThrow(/only affect a --live run/);
  });

  it("throws when --case=<id> is passed without --live", () => {
    expect(() => validateCheckArgs(parseEvalArgs(["--case=case-01-clean-match-spirits"]))).toThrow(/only affect a --live run/);
  });
});

describe("resolveCaseIds", () => {
  const manifestIds = ["case-01-clean-match-spirits", "case-02-clean-match-beer-no-abv", "case-03-clean-match-wine"];

  it("returns the default sample when neither --full nor --case is set, regardless of the manifest passed in", () => {
    const args = parseEvalArgs(["--live"]);
    // Deliberately passing manifestIds (which shares none of DEFAULT_SAMPLE_CASE_IDS)
    // rather than DEFAULT_SAMPLE_CASE_IDS itself — the default-sample branch
    // does not filter against the manifest at all, and asserting that
    // against a genuinely different list proves it, rather than a
    // tautological self-comparison.
    expect(resolveCaseIds(args, manifestIds)).toEqual([...DEFAULT_SAMPLE_CASE_IDS]);
  });

  it("returns every manifest case ID when --full is set", () => {
    const args = parseEvalArgs(["--live", "--full"]);
    expect(resolveCaseIds(args, manifestIds)).toEqual(manifestIds);
  });

  it("returns exactly the named case when --case=<id> is set", () => {
    const args = parseEvalArgs(["--live", "--case=case-02-clean-match-beer-no-abv"]);
    expect(resolveCaseIds(args, manifestIds)).toEqual(["case-02-clean-match-beer-no-abv"]);
  });

  it("throws when --case=<id> names a case the manifest does not have", () => {
    const args = parseEvalArgs(["--live", "--case=case-99-does-not-exist"]);
    expect(() => resolveCaseIds(args, manifestIds)).toThrow(/not a golden-set case ID/);
  });

  it("throws when the resolved sample exceeds MAX_CASES", () => {
    const tooMany = Array.from({ length: MAX_CASES + 1 }, (_, i) => `case-${i}`);
    const args = parseEvalArgs(["--live", "--full"]);
    expect(() => resolveCaseIds(args, tooMany)).toThrow(/exceeds the \d+-case safety cap/);
  });
});

// TRO-541 / LH-036 — this suite makes the default sample's own coverage
// claim machine-checkable, against the committed evidence artifact,
// instead of leaving it as unverified prose.
// `DEFAULT_SAMPLE_ACTUAL_REVIEW_REASONS` (`args.ts`) is documentation the
// file's own module comment reads FROM. This suite keeps that
// documentation honest as the committed report changes. It deliberately
// reads the real, committed `results/eval-report.json` — no live API
// call, no mock — so a rewritten map that drifts from measured reality
// fails loudly here (standing rule 2: never fabricate a number). Do NOT
// assert on `args.ts`'s source text (the ticket's own "Do NOT"). Only the
// exported constant's VALUES are checked, against the report's own
// VALUES.
describe("DEFAULT_SAMPLE_ACTUAL_REVIEW_REASONS", () => {
  const REPORT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "results/eval-report.json");
  const report = validateEvalReport(JSON.parse(readFileSync(REPORT_PATH, "utf8")), REPORT_PATH);

  it("matches the committed report's router-stage actualReviewReason for every DEFAULT_SAMPLE_CASE_IDS case", () => {
    for (const caseId of DEFAULT_SAMPLE_CASE_IDS) {
      const row = report.cases.find((c) => c.caseId === caseId);
      if (!row) {
        throw new Error(`eval-report.json (${REPORT_PATH}) has no case row for sample case "${caseId}"`);
      }
      expect(DEFAULT_SAMPLE_ACTUAL_REVIEW_REASONS[caseId]).toBe(row.routerVerdict.actualReviewReason);
    }
  });

  it("every DEFAULT_SAMPLE_CASE_IDS entry exists in the real golden-set manifest", () => {
    const manifest = loadGoldenSetManifest();
    const manifestIds = new Set(manifest.cases.map((c) => c.caseId));
    for (const caseId of DEFAULT_SAMPLE_CASE_IDS) {
      expect(manifestIds.has(caseId)).toBe(true);
    }
  });
});

// LH-038 / TRO-543 — the variance runner's own CLI layer, added on top of
// parseEvalArgs/resolveCaseIds without touching either (this ticket's own
// "reuse, do not build a second path" rule, generalized to the arg parser).
describe("parseVarianceArgs", () => {
  it("defaults repeats to DEFAULT_REPEATS and every parseEvalArgs field to its own default", () => {
    expect(parseVarianceArgs([])).toEqual({
      live: false,
      full: false,
      caseId: null,
      updateBaseline: false,
      repeats: DEFAULT_REPEATS,
      repeatsExplicit: false,
    });
  });

  it("parses --repeats=<k> as a number, and marks it explicit", () => {
    expect(parseVarianceArgs(["--live", "--repeats=3"])).toEqual({
      live: true,
      full: false,
      caseId: null,
      updateBaseline: false,
      repeats: 3,
      repeatsExplicit: true,
    });
  });

  it("marks repeatsExplicit true even when the explicit value equals DEFAULT_REPEATS (PR review finding: value equality cannot stand in for presence)", () => {
    const args = parseVarianceArgs(["--live", `--repeats=${DEFAULT_REPEATS}`]);
    expect(args.repeats).toBe(DEFAULT_REPEATS);
    expect(args.repeatsExplicit).toBe(true);
  });

  it("combines --repeats=<k> with --case=<id>, both taking effect", () => {
    const args = parseVarianceArgs(["--live", "--case=case-17-glare-front-label", "--repeats=1"]);
    expect(args.caseId).toBe("case-17-glare-front-label");
    expect(args.repeats).toBe(1);
  });

  it("combines --repeats=<k> with --full, both taking effect", () => {
    const args = parseVarianceArgs(["--live", "--full", "--repeats=2"]);
    expect(args.full).toBe(true);
    expect(args.repeats).toBe(2);
  });

  it("skips a literal -- token the same way parseEvalArgs does", () => {
    expect(parseVarianceArgs(["--", "--live", "--repeats=2"])).toEqual({
      live: true,
      full: false,
      caseId: null,
      updateBaseline: false,
      repeats: 2,
      repeatsExplicit: true,
    });
  });

  it("throws when --repeats is passed more than once", () => {
    expect(() => parseVarianceArgs(["--live", "--repeats=2", "--repeats=3"])).toThrow(/--repeats may be passed at most once/);
  });

  it("throws on --repeats=0", () => {
    expect(() => parseVarianceArgs(["--live", "--repeats=0"])).toThrow(/--repeats must be a positive integer, got 0/);
  });

  it("throws when --repeats exceeds MAX_REPEATS", () => {
    expect(() => parseVarianceArgs(["--live", `--repeats=${MAX_REPEATS + 1}`])).toThrow(/exceeds the \d+-repeat safety cap/);
  });

  it("accepts --repeats=MAX_REPEATS exactly (the cap is inclusive)", () => {
    expect(parseVarianceArgs(["--live", `--repeats=${MAX_REPEATS}`]).repeats).toBe(MAX_REPEATS);
  });

  it("rejects a non-numeric --repeats value as an unrecognized argument (it never matches the --repeats flag, so parseEvalArgs sees and rejects it)", () => {
    expect(() => parseVarianceArgs(["--live", "--repeats=abc"])).toThrow(/unrecognized argument "--repeats=abc"/);
  });

  it("still throws on an unrelated unrecognized argument", () => {
    expect(() => parseVarianceArgs(["--live", "--bogus"])).toThrow(/unrecognized argument "--bogus"/);
  });
});

describe("validateVarianceArgs", () => {
  it("passes for cheap mode (no flags)", () => {
    expect(() => validateVarianceArgs(parseVarianceArgs([]))).not.toThrow();
  });

  it("passes for a valid --live run with --full and --repeats", () => {
    expect(() => validateVarianceArgs(parseVarianceArgs(["--live", "--full", "--repeats=3"]))).not.toThrow();
  });

  it("passes for a valid --live run with --case and --repeats=1 (the mechanical-proof shape)", () => {
    expect(() =>
      validateVarianceArgs(parseVarianceArgs(["--live", "--case=case-01-clean-match-spirits", "--repeats=1"])),
    ).not.toThrow();
  });

  it("throws when --repeats=<k> (non-default) is passed without --live", () => {
    expect(() => validateVarianceArgs(parseVarianceArgs(["--repeats=3"]))).toThrow(/only affect a --live run/);
  });

  it("throws when --repeats=<DEFAULT_REPEATS> is explicitly passed without --live (PR review finding: an explicit value equal to the default must not silently pass validation)", () => {
    expect(() => validateVarianceArgs(parseVarianceArgs([`--repeats=${DEFAULT_REPEATS}`]))).toThrow(/only affect a --live run/);
  });

  it("throws when --full is passed without --live", () => {
    expect(() => validateVarianceArgs(parseVarianceArgs(["--full"]))).toThrow(/only affect a --live run/);
  });

  it("throws when --case=<id> is passed without --live", () => {
    expect(() => validateVarianceArgs(parseVarianceArgs(["--case=case-01-clean-match-spirits"]))).toThrow(/only affect a --live run/);
  });

  it("rejects --update-baseline outright, even with --live — this runner has no baseline", () => {
    expect(() => validateVarianceArgs(parseVarianceArgs(["--live", "--update-baseline"]))).toThrow(
      /--update-baseline is not supported by the variance runner/,
    );
  });
});
