/**
 * Regression test for `.env.local.example`'s `ACCESS_CODE` placeholder
 * (TRO-567 finding 1, TH-R6).
 *
 * The setup instructions at this file's own top tell a reader to copy it
 * verbatim to `.env.local`. Before this fix, `ACCESS_CODE=changeme-in-
 * production` was a real, functional access code the moment that copy
 * happened — anyone who did what the instructions said got a working,
 * publicly-known credential, not a placeholder that needs filling in.
 *
 * This test reads the real file from disk (same convention
 * `render-yaml.test.ts` already uses for `render.yaml`) and checks the
 * placeholder against the REAL `isValidAccessCode`, not a re-implemented
 * assumption of how it behaves.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isValidAccessCode } from "../../src/server/auth/access-code";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENV_EXAMPLE_PATH = `${REPO_ROOT}.env.local.example`;

function readEnvExampleText(): string {
  return readFileSync(ENV_EXAMPLE_PATH, "utf8");
}

/** Reads `ACCESS_CODE`'s configured value out of the file's own text — an
 * uncommented line starting with `ACCESS_CODE=`. Throws if the line is
 * missing entirely: a silently-deleted line is a bigger regression than
 * this test is built to catch, and should fail loudly, not pass by
 * accident. */
function readAccessCodePlaceholder(): string {
  const line = readEnvExampleText()
    .split("\n")
    .find((candidate) => candidate.startsWith("ACCESS_CODE="));
  if (line === undefined) {
    throw new Error(".env.local.example has no active ACCESS_CODE= line.");
  }
  return line.slice("ACCESS_CODE=".length).trim();
}

describe(".env.local.example — ACCESS_CODE placeholder is not a working code", () => {
  const ORIGINAL_ACCESS_CODE = process.env.ACCESS_CODE;
  afterEach(() => {
    if (ORIGINAL_ACCESS_CODE === undefined) delete process.env.ACCESS_CODE;
    else process.env.ACCESS_CODE = ORIGINAL_ACCESS_CODE;
  });

  it("ships empty — copying the file verbatim to .env.local sets no working code", () => {
    expect(readAccessCodePlaceholder()).toBe("");
  });

  it("fails closed when copied verbatim: no candidate can pass with this placeholder configured", async () => {
    // access-code.ts's own contract: an unset OR empty ACCESS_CODE rejects
    // every candidate. This proves the FILE'S OWN VALUE, copied verbatim,
    // actually exercises that fail-closed path — not a re-assertion of the
    // contract in isolation.
    process.env.ACCESS_CODE = readAccessCodePlaceholder();
    await expect(isValidAccessCode("changeme-in-production")).resolves.toBe(false);
    await expect(isValidAccessCode("")).resolves.toBe(false);
    await expect(isValidAccessCode("anything")).resolves.toBe(false);
  });

  it("states plainly that the deployed instance reads this from the platform's environment, not this file", () => {
    const text = readEnvExampleText();
    expect(text).toMatch(/platform/i);
  });
});
