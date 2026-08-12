import { describe, expect, it } from "vitest";
import { db } from "./index";

/**
 * TRO-513: pins the shared pool's `max`, under a real Vitest run, well
 * below pg's own default of 10.
 *
 * This module's `globalThis` guard only dedupes a Postgres pool WITHIN one
 * process — it cannot dedupe across processes. Vitest's default pool
 * ("forks") isolates each test file into its own forked process, so one
 * worktree's full `pnpm test` run opens many separate pools (measured: 17
 * on this repo), all competing for the SAME server-wide `max_connections`
 * every other worktree's own test run also draws from. A pool `max` left
 * at the default of 10 makes that worst case far larger than it needs to
 * be; this test fails loudly if a future change drops the override and
 * silently reintroduces that risk.
 *
 * The smaller `max` applies only under Vitest (`process.env.VITEST`,
 * Vitest's own signal, checked in `getPool()`) — production (the live
 * Next.js server, `scripts/batch-worker/run.ts`) keeps pg's default
 * capacity, since neither one hits the per-process pool multiplication a
 * test run does. This file itself runs under Vitest, so `VITEST` is always
 * `"true"` here — that is the precondition the assertion below relies on.
 */
describe("db pool sizing", () => {
  it("caps max well below pg's own default of 10 under a Vitest run, so many per-process pools stay a small worst case", () => {
    expect(process.env.VITEST).toBe("true");
    const client = db.$client as unknown as { options?: { max?: number } };
    expect(client.options?.max).toBeDefined();
    expect(client.options?.max).toBeLessThanOrEqual(5);
  });
});
