/**
 * Builds the resolver's per-call user message text (LH-014 / TRO-464,
 * CP-1 §6.3). Unlike the extractor's fixed `USER_MESSAGE_TEXT`, this text
 * differs on every call — a different image, application, extraction, and
 * flagged-field list — so it is built here, not stored as a constant.
 *
 * Every untrusted value (the application record, the extractor's reading)
 * goes through `serializeUntrusted`, never a bare `JSON.stringify` (CP-1
 * §6.3's implementation requirement, verified in `serialize.ts`). The image
 * itself carries no text delimiter here — it is a separate content block
 * (`request.ts`), not text, so it needs none (CP-1 §6.2 SECURITY).
 */
import { assertUntrustedInputWithinBounds } from "./input-validation";
import { serializeUntrusted } from "./serialize";
import type { FlaggedField, ResolverInput } from "./types";

function buildApplicationBlock(input: ResolverInput): string {
  const { application } = input;
  const payload = {
    beverageType: application.beverageType,
    brandName: application.brandName,
    classType: application.classType,
    alcoholContentPercent: application.alcoholContentPercent ?? null,
    netContentsValue: application.netContentsValue,
    netContentsUnit: application.netContentsUnit,
  };
  return `<UNTRUSTED_DATA source="application_form">\n${serializeUntrusted(payload)}\n</UNTRUSTED_DATA>`;
}

function buildExtractionBlock(input: ResolverInput): string {
  return `<UNTRUSTED_DATA source="extractor_reading">\n${serializeUntrusted(input.extraction)}\n</UNTRUSTED_DATA>`;
}

function buildWhatCodeDecidedBlock(input: ResolverInput): string {
  const lines = input.router.fields.map((row) => `  ${row.field}\t${row.verdict}\t${row.reason}`);
  return ["WHAT THE CODE DECIDED", ...lines].join("\n");
}

function buildFlaggedFieldsBlock(flaggedFields: FlaggedField[]): string {
  const entries = flaggedFields.map((flagged) => {
    const lines = [`  ${flagged.field} — ${flagged.reviewReason}`, `    Trigger: ${flagged.trigger}`];
    if (flagged.field === "government_warning") {
      lines.push("    Do not judge the wording. Copy the warning block again, exactly.");
    } else {
      lines.push(`    Decide: what does the label actually state for ${flagged.field}?`);
    }
    return lines.join("\n");
  });
  return ["FLAGGED FIELDS", "", ...entries].join("\n");
}

/**
 * Builds the full text portion of the resolver's user message (everything
 * after the image content block). Validates every untrusted string's length
 * first (`assertUntrustedInputWithinBounds`) — throws `ResolverInputError`
 * rather than embedding an implausibly long value.
 */
export function buildUserMessageText(input: ResolverInput): string {
  assertUntrustedInputWithinBounds(input);

  return [
    buildApplicationBlock(input),
    "",
    buildExtractionBlock(input),
    "",
    buildWhatCodeDecidedBlock(input),
    "",
    buildFlaggedFieldsBlock(input.flaggedFields),
    "",
    "Return the JSON object the schema requires.",
  ].join("\n");
}
