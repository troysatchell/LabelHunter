/**
 * Acceptance-contract test for the deployed-instance latency artifact
 * (TRO-539 step 5, G6 regression test).
 *
 * TRO-539's own acceptance evidence lists five checks the committed
 * deployed-run artifact must pass. This test reads the COMMITTED file —
 * never re-runs the harness, never spends money — and checks each one
 * directly, so a later edit that silently swaps in a stale, in-process, or
 * fake-model artifact under the same path fails the gate instead of
 * shipping unnoticed.
 *
 * Red before `scripts/latency/results/single-label-verify-url-mode.json`
 * existed (this file, run against `main`: `ENOENT`, no such file). Green
 * once the real deployed run committed it. Both runs recorded in
 * `CHANGES.md`'s TRO-539 entry.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_TIMING_STAGES } from "../../src/app/api/verify/server-timing";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = path.resolve(__dirname, "results/single-label-verify-url-mode.json");

// Commit c5e49f8 wired the warning comparator into the live route at
// 2026-08-11T22:30:19-05:00 == this UTC instant (TRO-539's own ticket
// text and CHANGES.md's TRO-539 entry). The acceptance bar: this run's
// `measuredAt` must be later than this, or it measures the pipeline that
// no longer ships.
const WARNING_COMPARATOR_LANDED_AT = "2026-08-12T03:30:19.000Z";

describe("TRO-539 deployed-instance latency artifact — acceptance contract", () => {
  const raw = readFileSync(ARTIFACT_PATH, "utf8");
  const artifact = JSON.parse(raw) as {
    measuredAt: string;
    pipelineScope: string;
    target: { boundary: string; host: string | null; renderPlan: string | null };
    successfulRuns: number;
    stageBreakdownMs: Record<string, { count: number } | undefined>;
  };

  it("names the warning comparator in pipelineScope, not the old provenance-trap claim", () => {
    expect(artifact.pipelineScope).toContain("government-warning comparator");
    expect(artifact.pipelineScope).not.toContain("LH-020 not merged");
  });

  it("was measured over a real HTTP round-trip, with the host recorded", () => {
    expect(artifact.target.boundary).toBe("http");
    expect(typeof artifact.target.host).toBe("string");
    expect((artifact.target.host ?? "").length).toBeGreaterThan(0);
  });

  it("records the deployed target's Render plan", () => {
    expect(artifact.target.renderPlan).toBe("starter");
  });

  it("was measured after the warning comparator landed in route.ts", () => {
    const measuredAtMs = new Date(artifact.measuredAt).getTime();
    const landedAtMs = new Date(WARNING_COMPARATOR_LANDED_AT).getTime();
    expect(Number.isNaN(measuredAtMs)).toBe(false);
    expect(measuredAtMs).toBeGreaterThan(landedAtMs);
  });

  it("carries a per-stage Server-Timing breakdown for every PRD §3.8 stage", () => {
    for (const stage of SERVER_TIMING_STAGES) {
      const summary = artifact.stageBreakdownMs[stage];
      expect(summary).toBeDefined();
      expect((summary as { count: number }).count).toBeGreaterThan(0);
    }
  });

  it("ran at least one real request successfully", () => {
    expect(artifact.successfulRuns).toBeGreaterThan(0);
  });
});
