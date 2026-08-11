import { describe, expect, it } from "vitest";
import type { CorrectionFieldResolution, JudgedFieldResolution, ResolverJudgedField } from "./types";

/**
 * Compile-time proof of CP-1 §6.5's judges-only-brand/class rule. These
 * functions are never called at runtime — `pnpm typecheck` is what checks
 * them. Each `@ts-expect-error` line requires an actual type error on the
 * next statement or TypeScript itself fails the build with "Unused
 * '@ts-expect-error' directive" (on by default, no config needed) — so this
 * is a real, enforced assertion, not a comment nobody checks.
 */
function _typeOnly_illegalJudgedConstruction(): void {
  const illegal: JudgedFieldResolution = {
    kind: "judged",
    // @ts-expect-error -- government_warning is a correction field, not a judged one; cannot assign to JudgedFieldResolution['field']
    field: "government_warning",
    disposition: "RESOLVED_MATCH",
    correctedValue: null,
    evidence: "",
    reason: "",
    confidence: 1,
  };
  void illegal;
}

function _typeOnly_illegalCorrectionConstruction(): void {
  const illegal: CorrectionFieldResolution = {
    kind: "correction",
    // @ts-expect-error -- brand_name is a judged field; cannot assign to CorrectionFieldResolution['field']
    field: "brand_name",
    needsHuman: false,
    correctedValue: null,
    evidence: "",
    reason: "",
    confidence: 1,
  };
  void illegal;
}

function _typeOnly_correctionFieldHasNoDisposition(): void {
  const resolution: CorrectionFieldResolution = {
    kind: "correction",
    field: "alcohol_content",
    needsHuman: false,
    correctedValue: "45%",
    evidence: "45%",
    reason: "",
    confidence: 1,
  };
  // @ts-expect-error — CorrectionFieldResolution has no `disposition`
  // property; nothing downstream can read a MATCH/MISMATCH opinion off it.
  const opinion = resolution.disposition;
  void opinion;
}

describe("ResolverJudgedField / ResolverCorrectionField — no overlap", () => {
  it("is exactly the two TH-R8 judgment fields", () => {
    // A `Record<ResolverJudgedField, true>` map, not `toEqual` against a
    // second identical array literal — the earlier version compared one
    // literal to an equally-hand-written copy of itself, so it would still
    // pass even if `ResolverJudgedField` gained or lost a member. This map
    // fails `pnpm typecheck` (a missing or an extra property) if that ever
    // happens, which an `expect` on two literals cannot do.
    const exhaustive: Record<ResolverJudgedField, true> = { brand_name: true, class_type: true };
    expect(Object.keys(exhaustive).sort()).toEqual(["brand_name", "class_type"]);
  });
});
