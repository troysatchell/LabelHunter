import { defineConfig } from "drizzle-kit";
import { config as loadEnv } from "dotenv";

// Loads .env.local for a plain local checkout. In a factory worktree,
// DATABASE_URL is already exported by `.factory-env` (and CI sets it as a
// job env var) — dotenv never overrides an already-set variable, so this is
// a no-op there.
loadEnv({ path: ".env.local" });

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.local.example to .env.local (plain " +
      "checkout) or `source .factory-env` (factory worktree) before running " +
      "db:generate / db:migrate.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
