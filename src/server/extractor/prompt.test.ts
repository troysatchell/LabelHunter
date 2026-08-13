import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, USER_MESSAGE_TEXT } from "./prompt";

/**
 * Intent assertions for the CP-1 §3.2 / §3.3 prompt text (TRO-502).
 *
 * `request.test.ts` already pins the approved bytes character for character.
 * This file does the different job: it states, in one place, WHY one clause
 * of rule 3 exists, so a later edit that drops the clause fails a test that
 * names the design it breaks. Same convention as `../resolver/prompt.test.ts`.
 */
describe("SYSTEM_PROMPT — rule 3's beverage_type exception (TRO-502)", () => {
  it("names beverage_type as the one field whose value need not appear in the evidence", () => {
    // CP-1 §3.1 makes the extractor's beverage_type inference a design
    // feature: "The extractor infers the beverage type from the label. The
    // router compares that inference to the beverage type the applicant
    // declared." Rule 3's first sentence ("The value must appear inside the
    // evidence") cannot hold for that field — no label prints "spirits".
    // Without this exception the compliant answer is always `value: null`,
    // and the free cross-check never runs.
    expect(SYSTEM_PROMPT).toMatch(/beverage_type is the one exception/);
    expect(SYSTEM_PROMPT).toMatch(/category word does not have to appear in the\n\s*evidence/);
  });

  it("still requires the model to copy the label text that supports the category", () => {
    // The exception drops the containment requirement only. Evidence stays
    // mandatory: CP-1 §3.4 makes provenance a compliance feature, and the
    // router's §4.4 rule 1 rejects a non-null value with no evidence.
    expect(SYSTEM_PROMPT).toMatch(/Copy the label text that supports your reading/);
  });
});

describe("USER_MESSAGE_TEXT", () => {
  it("asks for the product category as a reading, not as transcribed text", () => {
    expect(USER_MESSAGE_TEXT).toMatch(/beverage_type\s+your reading of the product category/);
  });
});
