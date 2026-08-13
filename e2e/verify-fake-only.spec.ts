/**
 * Verify — the one E2E scenario that only makes sense against the fake
 * Anthropic server (TRO-521).
 *
 * `scripts/e2e/fake-anthropic-server.ts` fails on demand for a request
 * whose image decodes under `FAILURE_TRIGGER_MAX_BYTES` — a fake-server-
 * only trigger, chosen by that file's own author, with no live-API
 * equivalent. No real, security-conscious third-party API lets a caller
 * force a failure on demand (`.claude/skills/labelhunter-factory/
 * references/lessons.md` rule 30). Running this scenario under
 * `E2E_LIVE=1` would not prove anything about a real bug — it would just
 * fail for a reason that has nothing to do with the app.
 *
 * TRO-479's original version of this test lived in `e2e/verify.spec.ts`,
 * gated by `test.skip(E2E_LIVE, "…")`. Troy approved that as a narrow,
 * documented exception (rule 30). CodeRabbit's later review proposed a
 * structurally cleaner alternative: isolate the scenario in its own file
 * instead of skipping it in place. This file is that isolation —
 * `playwright.config.ts`'s `testIgnore` excludes it entirely under
 * `E2E_LIVE=1`, at the config level, so the test body below carries no
 * runtime skip and needs no `E2E_LIVE` branch of its own. Under the
 * default (fake) mode — the mode the gate and CI both run — this file
 * runs exactly like any other spec, and the retry affordance it proves
 * stays fully exercised.
 */
import { expect, test } from "@playwright/test";
import { buildFailureTriggerImage, readDefaultGoldenImage, uniqueTag } from "../scripts/e2e/fixtures";
import { errorPanel, fillVerifyForm, jpegFile, submitVerifyFormAndWait } from "./helpers";

test.describe("Verify — designed error states (TH-R20), fake-server-only", () => {
  test("an API failure shows the SERVICE error state with a retry affordance that actually recovers", async ({ page }) => {
    await page.goto("/");

    const brandName = uniqueTag("verify-retry");
    await fillVerifyForm(page, {
      image: jpegFile("trigger.jpg", await buildFailureTriggerImage()),
      beverageType: "spirits",
      brandName,
      classType: "Straight Bourbon Whiskey",
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    });
    await submitVerifyFormAndWait(page);

    const alert = errorPanel(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/could not reach|took too long|try again|went wrong/i);

    const retryButton = page.getByRole("button", { name: "Try again" });
    await expect(retryButton).toBeVisible();

    // Prove the affordance genuinely recovers, not merely that a button
    // exists: swap in a real, working photo — "Try again" re-reads
    // whatever the file input currently holds (VerifyForm.tsx's own
    // `runSubmit`) — then retry.
    await page.getByLabel("Label photo").setInputFiles([jpegFile("case-01-clean-match-spirits.jpg", readDefaultGoldenImage())]);
    await retryButton.click();

    await expect(page.getByTestId("label-verdict-banner")).toBeVisible({ timeout: 20_000 });
    await expect(errorPanel(page)).toHaveCount(0);
    await expect(page.getByTestId("checklist-row-brand_name")).toBeVisible();
  });
});
