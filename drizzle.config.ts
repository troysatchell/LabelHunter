import { defineConfig } from "drizzle-kit";
import { config as loadEnv } from "dotenv";

// Loads .env.local for a local checkout. CI sets DATABASE_URL as a job env
// var instead, and dotenv never overrides an already-set variable, so this
// is a no-op there.
loadEnv({ path: ".env.local" });

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.local.example to .env.local " +
      "before running db:generate / db:migrate.",
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
