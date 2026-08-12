/**
 * Shared Playwright interaction helpers for the E2E suite (TRO-479).
 * Playwright-specific (imports `Page`/`Locator`), unlike
 * `scripts/e2e/fixtures.ts`'s plain Node fixture builders — kept in a
 * separate file under `e2e/` rather than `scripts/e2e/` for that reason,
 * and because `vitest.config.ts`'s `include` glob does not (and should
 * not) collect anything under `e2e/`: this file has no pure logic worth
 * unit-testing on its own, only DOM interaction that is only meaningfully
 * proven by the specs that actually call it against a real page.
 *
 * Resilient selectors throughout — `getByRole`/`getByLabel`/`getByTestId`,
 * never a CSS class or DOM structure — because TRO-480 (UX polish) is
 * running concurrently against the same screens (see this ticket's own
 * brief).
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { BeverageType } from "../src/lib/db/enums";

/**
 * True when this run is using the real Anthropic API
 * (`playwright.config.ts`'s `E2E_LIVE=1` opt-in) rather than the fake
 * model server. Reads the SAME env var `playwright.config.ts` reads, so a
 * spec's own idea of "am I live" never drifts from the config's.
 *
 * A few assertions are coupled to the fake server's own hardcoded canned
 * text (`WELL_FORMED_EXTRACTION_BODY`) and cannot hold against a real
 * model's own reading of the real photo — those branch on this flag
 * instead of failing for a reason that has nothing to do with a real bug
 * (CodeRabbit finding, TRO-479 local review round 2: `E2E_LIVE=1` was a
 * real, documented, callable path this suite had never actually run, and
 * every fixture-exact-text assertion would foreseeably fail under it).
 */
export const E2E_LIVE = process.env.E2E_LIVE === "1";

export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export function jpegFile(name: string, buffer: Buffer): FilePayload {
  return { name, mimeType: "image/jpeg", buffer };
}

export interface VerifyFormValues {
  image: FilePayload;
  beverageType: BeverageType;
  brandName: string;
  classType: string;
  /** Omit for beer/wine's legal blank ABV. */
  alcoholContentPercent?: number;
  netContentsValue: number;
  netContentsUnit: "mL" | "L" | "fl oz";
}

const BEVERAGE_TYPE_LABEL: Record<BeverageType, string> = {
  beer: "Beer",
  wine: "Wine",
  spirits: "Spirits",
};

/** Fills the Verify screen's one form (`src/app/_components/VerifyForm.tsx`)
 * but does not submit it — every spec decides its own moment to click
 * Verify, since the retry-affordance case needs to change the file input
 * again in between. */
export async function fillVerifyForm(page: Page, values: VerifyFormValues): Promise<void> {
  await page.getByLabel("Label photo").setInputFiles([values.image]);
  await page.getByRole("radio", { name: BEVERAGE_TYPE_LABEL[values.beverageType] }).check();
  await page.getByLabel("Brand name").fill(values.brandName);
  await page.getByLabel("Class/type").fill(values.classType);
  if (values.alcoholContentPercent !== undefined) {
    await page.getByLabel("Alcohol content (% ABV)").fill(String(values.alcoholContentPercent));
  }
  await page.getByLabel("Net contents").fill(String(values.netContentsValue));
  await page.getByLabel("Unit").selectOption(values.netContentsUnit);
}

export function verifySubmitButton(page: Page): Locator {
  return page.getByRole("button", { name: "Verify" });
}

/** The Verify screen's one designed error panel
 * (`src/app/_components/ErrorPanel.tsx`) — `role="alert"` is the resilient
 * anchor; title/message text is asserted separately, tolerantly, by each
 * spec (TRO-480 may reword it).
 *
 * Filtered to non-empty text: Next.js itself renders a second, always-
 * present `role="alert"` element on every page
 * (`id="__next-route-announcer__"`, its own route-change announcer for
 * assistive tech) — empty except right after a client-side navigation.
 * Without this filter, `getByRole("alert")` matches both and Playwright's
 * strict mode rejects the ambiguity (observed directly: every error-state
 * spec failed on this before the filter was added, not a hypothetical). */
export function errorPanel(page: Page): Locator {
  return page.getByRole("alert").filter({ hasText: /.+/ });
}

/** Submits the verify form and waits for the request to settle — either
 * the results checklist (`data-testid="label-verdict-banner"`) or the
 * designed error panel (`errorPanel(page)`), whichever the server
 * actually returns. Never a fixed sleep (standing rule 8): both outcomes
 * are real, observable DOM changes Playwright's own auto-waiting `expect`
 * polls for.
 *
 * Uses `errorPanel(page)`, not a raw `page.getByRole("alert")` — an
 * earlier version of this function used the raw, unfiltered locator,
 * which can also match Next's own always-present, possibly non-empty
 * route announcer (see `errorPanel`'s own comment). Matching the
 * announcer here is worse than the strict-mode violation it causes
 * elsewhere: `.or(...)` would resolve this wait as soon as EITHER side
 * matches, so a stale announcer left non-empty by an earlier client-side
 * navigation in the same test could let this function return before the
 * real result ever renders — a caller has no way to tell "the real thing
 * showed up" from "some old, unrelated announcer text was already there"
 * (CodeRabbit finding, TRO-479 local review round 2; regression-tested
 * below). */
export async function submitVerifyFormAndWait(page: Page): Promise<void> {
  await verifySubmitButton(page).click();
  await expect(page.getByTestId("label-verdict-banner").or(errorPanel(page))).toBeVisible({ timeout: 20_000 });
}
