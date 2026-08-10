import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Loads .env.local for a plain local checkout, same as drizzle.config.ts.
// Playwright's config runs as its own Node process — it does not get
// Next.js's automatic .env.local loading — so without this, a plain
// checkout's configured PORT was silently ignored in favor of the "3000"
// fallback below. A no-op in a factory worktree: .factory-env already
// exports APP_PORT, and dotenv never overrides an already-set variable.
loadEnv({ path: ".env.local" });

// APP_PORT is the factory-assigned port for this worktree (.factory-env);
// PORT is the equivalent for a plain local checkout (.env.local). Falls back
// to 3000 so `pnpm test:e2e` still works with neither set.
const PORT = process.env.APP_PORT ?? process.env.PORT ?? "3000";
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    // `pnpm start -- -p ${PORT}` looks tempting but is broken: pnpm forwards
    // a literal "--" to the script (npm strips it; pnpm does not), which
    // `next start` then misparses as a positional project-directory arg.
    // `next start`/`next dev` both honor the PORT env var directly, so pass
    // it that way instead — see scripts/run-tests.cjs for the same pnpm
    // quirk hitting `pnpm test -- --reporter=json ...`.
    command: "pnpm build && pnpm start",
    url: baseURL,
    env: { PORT },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
