/**
 * Shared test fixtures for the resolver test suites (LH-014 / TRO-464).
 *
 * Not a `*.test.ts` file itself — vitest only collects files matching that
 * pattern, so this module carries no test cases and never runs on its own
 * (same convention as `../extractor/test-support.ts` and
 * `../router/test-support.ts`).
 *
 * Reuses the router's own `makeApplication`/`makeExtraction` fixtures
 * (`../router/test-support.ts`) rather than hand-rolling new ones — both
 * tickets describe the same underlying label, and drift between two
 * hand-maintained copies would be its own bug. The escalation itself (a
 * `LabelRouterResult` with two flagged fields) mirrors CP-1 §6.3's own
 * worked example: an internally-contradictory ABV statement
 * ("45% Alc./Vol. (100 Proof)") and a warning transcription disagreement.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { makeMockMessage as makeExtractorMockMessage } from "../extractor/test-support";
import { makeApplication, makeExtraction } from "../router/test-support";
import type { ApplicationRecord, FieldResultRow, LabelRouterResult } from "../router/types";
import type { FlaggedField, PreprocessedLabelImage, RawResolverResponse, ResolverInput } from "./types";

/** A minimal, type-correct base64 image — never a real photo in the unit suite. */
export const IMAGE: PreprocessedLabelImage = { data: "ZmFrZS1pbWFnZQ==", mediaType: "image/jpeg" };

/** Builds a minimal, type-correct `Anthropic.Message`, defaulting to the
 * resolver's model — reuses the extractor's builder (same shape) rather
 * than duplicating it, then overrides `model`. */
export function makeMockMessage(text: string, overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return makeExtractorMockMessage(text, { model: "claude-sonnet-5", ...overrides });
}

/** The application `makeExtraction()`'s default values read as a clean
 * match against — see `../router/test-support.ts`. */
export function makeResolverApplication(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return makeApplication(overrides);
}

/** The five router field rows for a label escalated on AMBIGUOUS_ABV
 * (rank 5) and WARNING_MISMATCH (rank 4, so it wins the headline). Matches
 * CP-1 §6.3's own worked example. */
export function makeRouterResult(overrides: Partial<LabelRouterResult> = {}): LabelRouterResult {
  const rows: FieldResultRow[] = [
    {
      field: "brand_name",
      verdict: "MATCH",
      labelValue: "Old Tom Distillery",
      applicationValue: "Old Tom Distillery",
      evidence: "OLD TOM DISTILLERY",
      confidence: 0.95,
      reason: "Matches the application.",
      resolvedBy: null,
      reviewReason: null,
    },
    {
      field: "class_type",
      verdict: "MATCH",
      labelValue: "Straight Bourbon Whiskey",
      applicationValue: "Straight Bourbon Whiskey",
      evidence: "STRAIGHT BOURBON WHISKEY",
      confidence: 0.94,
      reason: "Matches the application.",
      resolvedBy: null,
      reviewReason: null,
    },
    {
      field: "alcohol_content",
      verdict: "NEEDS_REVIEW",
      labelValue: "45% Alc./Vol. (100 Proof)",
      applicationValue: 45,
      evidence: "45% Alc./Vol. (100 Proof)",
      confidence: 0.9,
      reason: "A reviewer must check the alcohol content against the label.",
      resolvedBy: null,
      reviewReason: "AMBIGUOUS_ABV",
    },
    {
      field: "net_contents",
      verdict: "MATCH",
      labelValue: "750 mL",
      applicationValue: "750 mL",
      evidence: "750 mL",
      confidence: 0.98,
      reason: "Matches the application.",
      resolvedBy: null,
      reviewReason: null,
    },
    {
      field: "government_warning",
      verdict: "NEEDS_REVIEW",
      labelValue: "GOVERNMENT WARNING: (1) ...",
      applicationValue: "the statutory warning text (27 CFR part 16)",
      evidence: "GOVERNMENT WARNING: (1) ...",
      confidence: 0.91,
      reason: "The government warning needs a closer look.",
      resolvedBy: null,
      reviewReason: "WARNING_MISMATCH",
    },
  ];
  return { labelVerdict: "REVIEW", headlineReason: "WARNING_MISMATCH", fields: rows, ...overrides };
}

/** The two flagged fields for `makeRouterResult()`'s default escalation. */
export function makeFlaggedFields(overrides: Partial<FlaggedField>[] = []): FlaggedField[] {
  const defaults: FlaggedField[] = [
    {
      field: "alcohol_content",
      reviewReason: "AMBIGUOUS_ABV",
      trigger:
        "The label states 45% and 100 proof. Proof should be twice the percentage. " +
        "2 x 45 = 90, not 100. The label contradicts itself, or the earlier reading is wrong.",
    },
    {
      field: "government_warning",
      reviewReason: "WARNING_MISMATCH",
      trigger: "The vision transcription and the OCR transcription of the warning block do not agree.",
    },
  ];
  if (overrides.length === 0) return defaults;
  return defaults.map((field, i) => ({ ...field, ...overrides[i] }));
}

/** A full `ResolverInput`, ready to hand to `buildResolverRequestParams` or `resolveEscalatedLabel`. */
export function makeResolverInput(overrides: Partial<ResolverInput> = {}): ResolverInput {
  return {
    verificationId: 1,
    image: IMAGE,
    extraction: makeExtraction({
      alcohol_content: {
        value: "45% Alc./Vol. (100 Proof)",
        evidence: "45% Alc./Vol. (100 Proof)",
        confidence: 0.9,
        alternates: [],
      },
    }),
    application: makeResolverApplication(),
    router: makeRouterResult(),
    flaggedFields: makeFlaggedFields(),
    ...overrides,
  };
}

/** A well-formed resolver response body, schema-conformant, answering both
 * of `makeFlaggedFields()`'s default fields. */
export const WELL_FORMED_RESOLVER_BODY: RawResolverResponse = {
  overall: "RESOLVED",
  fields: [
    {
      field: "alcohol_content",
      disposition: "RESOLVED_MATCH",
      corrected_value: "45% Alc./Vol. (90 Proof)",
      evidence: "45% Alc./Vol. (90 Proof)",
      reason: "At full resolution, the proof numeral reads 90, not 100 — a misread on the first pass.",
      confidence: 0.93,
    },
    {
      field: "government_warning",
      disposition: "RESOLVED_MATCH",
      corrected_value:
        "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic " +
        "beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic " +
        "beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
      evidence:
        "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic " +
        "beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic " +
        "beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
      reason: "Re-transcribed the warning block at full resolution.",
      confidence: 0.97,
    },
  ],
};
