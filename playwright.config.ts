import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Loads .env.local for a plain local checkout, same as drizzle.config.ts.
// Playwright's config runs as its own Node process — it does not get
// Next.js's automatic .env.local loading — so without this, a plain
// checkout's configured PORT was silently ignored in favor of the "3000"
// fallback below. A no-op when APP_PORT is already exported: dotenv never
// overrides an already-set variable.
loadEnv({ path: ".env.local" });

// APP_PORT names the app's port when a caller assigns one; PORT is the
// equivalent for a plain local checkout (.env.local). Falls back
// to 3000 so `pnpm test:e2e` still works with neither set.
const PORT = process.env.APP_PORT ?? process.env.PORT ?? "3000";
const baseURL = `http://localhost:${PORT}`;

/**
 * TRO-479 (LH-053): real model calls or a fake server, decided here.
 *
 * Default (E2E_LIVE unset): every spec runs against a FAKE Anthropic API
 * (`scripts/e2e/fake-anthropic-server.ts`) — the app's and the worker's
 * `webServer` processes below both get `ANTHROPIC_BASE_URL` pointed at it,
 * plus a placeholder `ANTHROPIC_API_KEY` (the fake server never checks the
 * key; the Anthropic SDK just requires some value to construct a client).
 * This is the same "cheap by default" shape `scripts/eval/check.ts`
 * already established for its own `--live` flag (see that file's header
 * comment) — E2E runs are expected to run often (every `gate.sh`-adjacent
 * check, every local iteration), and burning real API spend on each one
 * is not the intent PRD §6 describes.
 *
 * `E2E_LIVE=1 pnpm test:e2e` runs the real cascade against the real
 * Anthropic API instead — no fake server is started, and
 * ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY are left unset here so the app and
 * worker processes fall back to whatever `.env.local` (or the real CI/
 * deploy environment) provides. Needs a real ANTHROPIC_API_KEY. This mode
 * is for a deliberate, human-or-agent-invoked confidence check, not part
 * of the normal inner loop — matching `scripts/eval/check.ts --live`'s own
 * "expensive, deliberate, never automatic" posture.
 */
const E2E_LIVE = process.env.E2E_LIVE === "1";

// Deliberately derived from PORT, not a fixed literal: two checkouts can
// run `pnpm test:e2e` at the same time when each sets its own APP_PORT, and
// deriving this port the same way keeps their fake model servers out of
// each other's way too.
const FAKE_MODEL_PORT = String(Number(PORT) + 1000);
const FAKE_MODEL_BASE_URL = `http://localhost:${FAKE_MODEL_PORT}`;

// Merged into both the app's and the worker's webServer `env` below —
// every real outbound call either process makes to Anthropic
// (src/server/extractor/index.ts, src/server/resolver/index.ts) reads
// these two variables and no others to decide where it goes.
const modelEnv: Record<string, string> = E2E_LIVE
  ? {}
  : {
      ANTHROPIC_BASE_URL: FAKE_MODEL_BASE_URL,
      ANTHROPIC_API_KEY: "sk-ant-e2e-fake-key-not-a-real-credential",
    };

// TRO-482 / LH-061, PRD §8: src/proxy.ts now gates every route behind the
// shared access code. A fixed, obviously-fake, non-production string — the
// same "clearly not a real credential" convention modelEnv's own
// ANTHROPIC_API_KEY placeholder above already uses. Set on the app's
// webServer env below so the running instance actually accepts it, and on
// `use.extraHTTPHeaders` so EVERY request Playwright makes (page
// navigation and the `request` fixture alike) carries it automatically —
// one central place, not a per-spec change (this ticket's brief's own
// "add the credential once, centrally" instruction, applied here since
// e2e specs are real browser/HTTP traffic that DOES go through
// src/proxy.ts, unlike route.test.ts's direct handler calls, which never
// do — see that ticket's other commits for the full reasoning).
const E2E_ACCESS_CODE = "e2e-test-access-code-not-a-real-credential";

export default defineConfig({
  testDir: "./e2e",
  // TRO-524: every run starts from a queue with no leftovers from earlier
  // runs. See `e2e/global-setup.ts` for why this is setup, not teardown.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  // TRO-521: e2e/verify-fake-only.spec.ts exercises the fake Anthropic
  // server's own failure-injection trigger, which has no live-API
  // equivalent by design (see that file's header comment). Excluding it
  // here, structurally, replaces an earlier in-body
  // `test.skip(E2E_LIVE, "…")` — the same outcome (the scenario never
  // runs under E2E_LIVE=1), but the exclusion now lives at the config
  // level, next to the E2E_LIVE decision it depends on, instead of as a
  // runtime skip a reviewer has to re-justify on every pass. Under the
  // default (fake) mode this list is empty, and the file runs like any
  // other spec.
  testIgnore: E2E_LIVE ? ["**/verify-fake-only.spec.ts"] : undefined,
  use: {
    baseURL,
    trace: "on-first-retry",
    extraHTTPHeaders: { "x-access-code": E2E_ACCESS_CODE },
  },
  webServer: [
    // Only started in the default (fake) mode — E2E_LIVE has nothing for
    // it to do, and starting a server no spec will ever talk to is just
    // noise in the run's own log output.
    ...(E2E_LIVE
      ? []
      : [
          {
            // `tsx` (already a devDependency) runs the TS file directly —
            // same mechanism `pnpm worker` already uses below for
            // scripts/batch-worker/run.ts.
            command: "pnpm e2e:fake-model",
            env: { FAKE_MODEL_PORT },
            port: Number(FAKE_MODEL_PORT),
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
          },
        ]),
    {
      // `pnpm start -- -p ${PORT}` looks tempting but is broken: pnpm forwards
      // a literal "--" to the script (npm strips it; pnpm does not), which
      // `next start` then misparses as a positional project-directory arg.
      // `next start`/`next dev` both honor the PORT env var directly, so pass
      // it that way instead — see scripts/run-tests.cjs for the same pnpm
      // quirk hitting `pnpm test -- --reporter=json ...`.
      command: "pnpm build && pnpm start",
      url: baseURL,
      // ACCESS_CODE only — not modelEnv's own concern, but this is the one
      // webServer entry that actually serves the HTTP traffic src/proxy.ts
      // gates. The worker entry below serves none, so it does not get this.
      env: { PORT, ACCESS_CODE: E2E_ACCESS_CODE, ...modelEnv },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The batch happy-path spec needs this actually running the cascade
      // (PRD §3.6: "Next.js app + worker" — the review-queue and batch
      // screens have nothing to show without it). No HTTP endpoint of its
      // own to poll — `wait.stdout` instead, matching this process's own
      // real startup log line (scripts/batch-worker/run.ts).
      command: "pnpm worker",
      env: { ...modelEnv },
      wait: { stdout: /\[batch-worker\] starting/ },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
