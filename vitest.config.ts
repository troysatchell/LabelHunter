import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
setupFiles: ["./vitest.setup.ts"],
    // scripts/golden/*.test.ts (TRO-497 / LH-004) covers the golden-set
    // renderer and degrader — the ticket requires these tests in "the unit
    // vitest run", not a separate suite, so this glob widens to match.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    // NOTE: a caller may invoke `pnpm test -- --reporter=json --outputFile=<abs path>`.
    // Vitest resolves a relative --outputFile against this config's root (the repo
    // root, since this file lives there). Keep root implicit (no `root:` override
    // below) so that stays true.
    //
    // TRO-513: bounds how many forked processes one `pnpm test` run opens at
    // once. Vitest's default pool ("forks") isolates each test file into its
    // own process, and `src/lib/db/index.ts`'s `globalThis` pool guard only
    // dedupes a Postgres pool WITHIN one process — it cannot dedupe across
    // them. Measured on this repo: an unbounded run opens 17 separate pools
    // (one per forked process) against the checkout's own database. Two
    // checkouts share one Postgres server, so those 17 pools compete for
    // the SAME server-wide `max_connections` (100 by default) as every
    // other checkout's test run. Concurrent cross-checkout runs are exactly
    // where load-sensitive flakes cluster. Reproduced directly: with enough
    // concurrent connection pressure, some pool's connection attempt is
    // refused with Postgres's own "sorry, too many clients already" —
    // surfacing as an unrelated test failure that clears on a standalone
    // re-run, because a standalone run only ever opens one pool. 4 keeps
    // real parallelism (a full run still takes single-digit seconds) while
    // capping one worktree's worst-case pool count regardless of the host's
    // CPU count, which is what an unbounded run scales with instead.
    maxWorkers: 4,
  },
});
