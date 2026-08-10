import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

declare global {
  // `var` is required here — ambient global declarations cannot use let/const.
  var __lhPgPool: Pool | undefined;
}

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. See .env.local.example (or source " +
        ".factory-env in a factory worktree).",
    );
  }
  // Reuse the pool across Next.js dev-server hot reloads so we don't leak
  // connections on every edit.
  if (!globalThis.__lhPgPool) {
    globalThis.__lhPgPool = new Pool({ connectionString });
  }
  return globalThis.__lhPgPool;
}

export const db = drizzle(getPool(), { schema });
