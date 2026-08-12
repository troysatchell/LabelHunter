/**
 * Extraction accuracy: did Haiku read a label's fields correctly, field by
 * field, against the golden set's ground-truth `label` block (LH-030 /
 * TRO-470, TH-R17)?
 *
 * This is a DIFFERENT question from verdict accuracy (`verdict-scoring.ts`):
 * a case can have a perfectly correct extraction and still route to REVIEW
 * (a degraded photo the router correctly flags), or a wrong extraction that
 * happens to still land on the right verdict. Scoring them with one
 * function would hide exactly the regression this ticket's brief warns
 * about — a regression in one can hide behind health in the other — so
 * they are two files with two independent scorers.
 *
 * Every comparison below reuses the SAME pure parsing/normalizing functions
 * the real Validation Router uses (`../../src/server/comparators/*`,
 * `../../src/server/warning/normalize.ts`) — never a second, hand-rolled
 * text comparison that could quietly drift from what "correct" means in
 * production.
 */
import {
  abvAsPercent,
  convertNetContentsToMl,
  normalizeForFuzzyMatch,
  normalizeNetContentsUnit,
  parseAbv,
  parseNetContents,
} from "../../src/server/comparators";
import type { HaikuExtractionResult } from "../../src/server/extractor/types";
import { foldCase, normalizeTransport } from "../../src/server/warning/normalize";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import type { ExtractionCaseScore, ExtractionFieldScore } from "./types";

/** A tiny float-rounding allowance for "the same number, restated" — the
 * same reasoning as `../../src/server/router/field-resolution.ts`'s
 * `SAME_VALUE_EPSILON`, reused here rather than re-derived, since it
 * answers the identical question ("45" vs "45.0"). */
const ABV_EPSILON = 0.05;

function scoreBrandName(caseSpec: GoldenSetCase, extraction: HaikuExtractionResult): ExtractionFieldScore {
  const expected = caseSpec.label.brandName;
  const actualRaw = extraction.brand_name.value;
  const correct = actualRaw !== null && normalizeForFuzzyMatch(actualRaw) === normalizeForFuzzyMatch(expected);
  return {
    field: "brandName",
    correct,
    expected,
    actual: actualRaw ?? "(not read)",
    detail: correct
      ? "Haiku read the brand name correctly."
      : `Haiku read "${actualRaw ?? "(nothing)"}"; the label prints "${expected}".`,
  };
}

function scoreClassType(caseSpec: GoldenSetCase, extraction: HaikuExtractionResult): ExtractionFieldScore {
  const expected = caseSpec.label.classType;
  const actualRaw = extraction.class_type.value;
  const correct = actualRaw !== null && normalizeForFuzzyMatch(actualRaw) === normalizeForFuzzyMatch(expected);
  return {
    field: "classType",
    correct,
    expected,
    actual: actualRaw ?? "(not read)",
    detail: correct
      ? "Haiku read the class/type correctly."
      : `Haiku read "${actualRaw ?? "(nothing)"}"; the label prints "${expected}".`,
  };
}

/**
 * Scores ABV by PARSED VALUE, not printed text — `parseAbv` (the router's
 * own grammar) reads a percent out of whatever Haiku's raw string says, so
 * "45% Alc./Vol. (90 Proof)" and "45.0 percent" score the same when both
 * name the golden set's own `abvPercent`. This asks "did Haiku read the
 * right number," not "did Haiku copy the exact same words" — a stricter,
 * more useful question for TH-R17's "read the fields right."
 */
function scoreAbv(caseSpec: GoldenSetCase, extraction: HaikuExtractionResult): ExtractionFieldScore {
  const label = caseSpec.label;
  const actualRaw = extraction.alcohol_content.value;

  if (!label.abvPresent) {
    const correct = actualRaw === null;
    return {
      field: "abv",
      correct,
      expected: "(no ABV statement on the label)",
      actual: actualRaw ?? "(not read)",
      detail: correct
        ? "Haiku correctly read no ABV statement."
        : `Haiku read "${actualRaw}"; the label has no ABV statement.`,
    };
  }

  const expectedPercent = label.abvPercent;
  if (expectedPercent === undefined) {
    // Manifest data error (abvPresent true with no abvPercent) — the loader
    // schema already requires this pairing; treat as unscoreable rather
    // than fabricate a comparison against `undefined`.
    return {
      field: "abv",
      correct: false,
      expected: "(golden-set case has abvPresent=true with no abvPercent)",
      actual: actualRaw ?? "(not read)",
      detail: "Golden-set case data error: abvPresent is true but abvPercent is missing.",
    };
  }

  if (actualRaw === null) {
    return {
      field: "abv",
      correct: false,
      expected: `${expectedPercent}%`,
      actual: "(not read)",
      detail: `Haiku read no ABV statement; the label states ${expectedPercent}%.`,
    };
  }

  const parsed = parseAbv(actualRaw);
  const actualPercent = abvAsPercent(parsed);
  const correct = actualPercent !== null && Math.abs(actualPercent - expectedPercent) <= ABV_EPSILON;
  return {
    field: "abv",
    correct,
    expected: `${expectedPercent}%`,
    actual: actualPercent !== null ? `${actualPercent}%` : `"${actualRaw}" (unparseable)`,
    detail: correct
      ? "Haiku read the correct ABV."
      : `Haiku read "${actualRaw}" (parsed as ${actualPercent !== null ? `${actualPercent}%` : "unparseable"}); the label states ${expectedPercent}%.`,
  };
}

/**
 * Scores net contents by parsed value+unit, converted to mL — the same
 * "read the right number" standard as `scoreAbv`, using the router's own
 * `parseNetContents`/`convertNetContentsToMl`/`normalizeNetContentsUnit`.
 */
function scoreNetContents(caseSpec: GoldenSetCase, extraction: HaikuExtractionResult): ExtractionFieldScore {
  const label = caseSpec.label;
  const actualRaw = extraction.net_contents.value;
  const expectedText = `${label.netContentsValue} ${label.netContentsUnit}`;

  if (actualRaw === null) {
    return {
      field: "netContents",
      correct: false,
      expected: expectedText,
      actual: "(not read)",
      detail: `Haiku read no net-contents statement; the label states ${expectedText}.`,
    };
  }

  const expectedUnit = normalizeNetContentsUnit(label.netContentsUnit);
  if (expectedUnit === null) {
    return {
      field: "netContents",
      correct: false,
      expected: expectedText,
      actual: actualRaw,
      detail: `Golden-set case data error: netContentsUnit "${label.netContentsUnit}" is not a recognized unit.`,
    };
  }
  const expectedMl = convertNetContentsToMl({ value: label.netContentsValue, unit: expectedUnit });

  const parsed = parseNetContents(actualRaw);
  if (!parsed) {
    return {
      field: "netContents",
      correct: false,
      expected: expectedText,
      actual: `"${actualRaw}" (unparseable)`,
      detail: `Haiku read "${actualRaw}", which does not parse as a value plus unit; the label states ${expectedText}.`,
    };
  }
  const actualMl = convertNetContentsToMl(parsed);
  const fractionDiff = expectedMl === 0 ? Infinity : Math.abs(actualMl - expectedMl) / expectedMl;
  const correct = fractionDiff <= 0.005;
  return {
    field: "netContents",
    correct,
    expected: expectedText,
    actual: `${parsed.value} ${parsed.unit}`,
    detail: correct
      ? "Haiku read the correct net contents."
      : `Haiku read "${actualRaw}"; the label states ${expectedText}.`,
  };
}

/**
 * Scores the government warning's TRANSCRIPTION against what the label
 * actually prints (`label.governmentWarningText`) — this is "did Haiku
 * copy the block correctly," never "does the block match the statute." The
 * second question is a verdict, not an extraction fact, and is already
 * covered by `verdict-scoring.ts` plus the real warning subsystem
 * (`../../src/server/warning/`). On a degraded-photo case
 * (glare/rotation/low-light), the ground-truth text still records what is
 * truly printed — the manifest's own convention, per several cases' notes
 * — so a correct-but-degraded read can legitimately score `correct: true`
 * here even though the router's verdict for the same field is NEEDS_REVIEW.
 */
function scoreGovernmentWarning(caseSpec: GoldenSetCase, extraction: HaikuExtractionResult): ExtractionFieldScore {
  const label = caseSpec.label;
  const actual = extraction.government_warning;

  if (!label.governmentWarningPresent) {
    const correct = actual.present === false;
    return {
      field: "governmentWarning",
      correct,
      expected: "(no government warning on the label)",
      actual: actual.present ? (actual.transcription ?? "(present, no transcription)") : "(not present)",
      detail: correct
        ? "Haiku correctly read no government warning."
        : "Haiku read a government warning; the label has none.",
    };
  }

  if (!actual.present || actual.transcription === null) {
    return {
      field: "governmentWarning",
      correct: false,
      expected: label.governmentWarningText,
      actual: "(not read)",
      detail: "Haiku read no government warning; the label has one.",
    };
  }

  const expectedFolded = foldCase(normalizeTransport(label.governmentWarningText));
  const actualFolded = foldCase(normalizeTransport(actual.transcription));
  const correct = expectedFolded === actualFolded;
  return {
    field: "governmentWarning",
    correct,
    expected: label.governmentWarningText,
    actual: actual.transcription,
    detail: correct
      ? "Haiku transcribed the government warning correctly."
      : "Haiku's transcription differs from what the label prints.",
  };
}

/** Scores every extraction field for one golden-set case. Pure — no I/O,
 * no model call; `extraction` is the real Haiku result the caller already
 * has in hand. */
export function scoreExtraction(caseSpec: GoldenSetCase, extraction: HaikuExtractionResult): ExtractionCaseScore {
  return {
    caseId: caseSpec.caseId,
    category: caseSpec.category,
    fields: [
      scoreBrandName(caseSpec, extraction),
      scoreClassType(caseSpec, extraction),
      scoreAbv(caseSpec, extraction),
      scoreNetContents(caseSpec, extraction),
      scoreGovernmentWarning(caseSpec, extraction),
    ],
  };
}
