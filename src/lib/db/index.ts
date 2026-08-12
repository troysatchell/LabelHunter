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
    const pool = new Pool({
      connectionString,
      // pg's default is 0 (no timeout) — an unreachable database would hang
      // a connection attempt forever instead of failing fast.
      connectionTimeoutMillis: 10_000,
      // pg's default `max` is 10. TRO-513: this module's own `globalThis`
      // guard only dedupes calls to `getPool()` WITHIN one process — it
      // cannot dedupe across processes. Vitest's default `pool: 'forks'`
      // runs each test file's isolated environment in its own forked
      // process (measured: one worktree's full `pnpm test` run opens 17
      // separate pools, one per fork), so the real ceiling this module must
      // respect is Postgres's server-wide `max_connections` (100 on a
      // default local install) divided across every pool every concurrent
      // worktree's test run opens at once, not just this one process's own
      // pool. A smaller `max` keeps one pool's worst case small enough that
      // several worktrees' worth of forks still fit.
      max: 5,
    });
    // An idle client that loses its connection emits "error" on the pool.
    // With no listener, Node treats that as an unhandled error and can
    // crash the process. The pool already evicts the dead client and will
    // open a new one on the next query — this listener only stops the
    // crash and reports what happened.
    pool.on("error", (err) => {
      console.error("Unexpected error on idle Postgres client", err);
    });
    globalThis.__lhPgPool = pool;
  }
  return globalThis.__lhPgPool;
}

export const db = drizzle(getPool(), { schema });
