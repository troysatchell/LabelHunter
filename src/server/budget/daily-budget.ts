/**
 * The daily spend budget guard (TRO-482 / LH-061, PRD §8, TH-R6).
 *
 * Protects Troy's Anthropic key on the public URL: once today's real,
 * measured spend reaches the configured budget, `src/app/api/verify/route.ts`
 * and `src/app/api/batch/start/route.ts` refuse new work with a friendly
 * message instead of calling the model. Both routes check `checkDailyBudget`
 * BEFORE the model call, never after — check-then-call, not call-then-check.
 *
 * PERSISTED, not in-memory (unlike the rate limiter, `../rate-limit/`): a
 * process restart (a deploy, a crash, Render recycling the instance) must
 * not silently reset spend to zero and defeat the guard exactly when a
 * traffic spike is causing restarts. `daily_spend` (`../../lib/db/schema.ts`,
 * migration `drizzle/migrations/0004_daily_spend.sql`) holds one row per UTC
 * calendar day.
 *
 * **The default budget number and the reasoning behind it.** PRD §4's own
 * committed cost table: Haiku extraction ~$0.005/label; Sonnet resolution
 * ~$0.02, on an estimated 10-15% of labels. Blended, that is roughly
 * $0.005 + 0.125 * $0.02 = $0.0075/label. The golden set is ~20-30 labels
 * (PRD §6) — a full demo run plus manual exploration by one or two
 * evaluators over a full day is, generously, a few hundred label
 * verifications: 400 labels * $0.0075 ~= $3.00. $5.00/day gives real
 * headroom above that legitimate use while bounding the worst case of a
 * discovered, unauthenticated-looking script hammering the endpoint to a
 * small, acceptable daily dollar figure — well inside this project's own
 * stakes. This is a distinct pool from `factory/config.yaml`'s
 * `policy.spendCap.projectedBuildEvalUsd` ($25): that number tracks
 * FACTORY BUILD+EVAL spend during development (and Troy explicitly removed
 * its pause-on-cross, escalation.md item 3) — this number is the ongoing
 * RUNTIME budget for the deployed public instance, a different pool serving
 * a different purpose, not derived from it.
 *
 * `DAILY_BUDGET_USD` overrides the default without a redeploy (same pattern
 * `scripts/batch-worker/run.ts`'s `envPositiveInt` already uses for its own
 * tunable knobs) — see `.env.local.example` and `render.yaml`.
 */
import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import { dailySpend } from "../../lib/db/schema";

export const DEFAULT_DAILY_BUDGET_USD = 5;

/** Reads `DAILY_BUDGET_USD` from the environment; falls back to the
 * documented default on anything unset, empty, non-numeric, or <= 0 — a
 * misconfigured budget must never become "no budget" (Infinity/NaN would
 * make `isBudgetExhausted` always false). Logs a warning on a rejected
 * override so a typo'd env var is visible in the deploy logs, not silent. */
export function getDailyBudgetUsd(): number {
  const raw = process.env.DAILY_BUDGET_USD;
  if (raw === undefined || raw === "") return DEFAULT_DAILY_BUDGET_USD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `DAILY_BUDGET_USD=${JSON.stringify(raw)} is not a positive number — using the default ($${DEFAULT_DAILY_BUDGET_USD.toFixed(2)}).`,
    );
    return DEFAULT_DAILY_BUDGET_USD;
  }
  return parsed;
}

/** Pure. `>=`, not `>` — a spend that has JUST reached the budget is treated
 * as exhausted, not "one dollar short of a problem." */
export function isBudgetExhausted(spentUsd: number, budgetUsd: number): boolean {
  return spentUsd >= budgetUsd;
}

/** The UTC calendar day for a `Date` (default: now), as `YYYY-MM-DD` — the
 * one place "today" is decided, so every reader and writer of `daily_spend`
 * agrees. UTC, not the server's local time zone or the caller's: Render
 * runs its own local clock setting, and a day boundary that silently moved
 * with the deploy region would make the budget's reset time undocumented
 * and unpredictable. `Date#toISOString` is always UTC by spec. */
export function todayUtcDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface BudgetStatus {
  readonly exhausted: boolean;
  readonly spentUsd: number;
  readonly budgetUsd: number;
}

/** Real spend recorded for today, or `0` when no row exists yet — "no row"
 * and "zero spend" are the same fact, not an error. */
export async function getTodaySpendUsd(db: typeof defaultDb = defaultDb, now: Date = new Date()): Promise<number> {
  const day = todayUtcDateString(now);
  const rows = await db
    .select({ totalUsd: dailySpend.totalUsd })
    .from(dailySpend)
    .where(sql`${dailySpend.spendDate} = ${day}`);
  return rows[0]?.totalUsd ?? 0;
}

/**
 * Adds a real, measured cost to today's running total. Atomic upsert
 * (`INSERT ... ON CONFLICT (spend_date) DO UPDATE SET total_usd =
 * total_usd + excluded`) — safe under concurrent requests recording spend
 * for the same day; never a read-then-write race.
 *
 * Rejects a negative amount (standing rule 13: validate at the boundary —
 * `usd` is a computed value from an external API's token-usage response,
 * not a guaranteed-valid one) rather than silently corrupting the ledger.
 * A `0` amount is a legal input (e.g. a cache-only call) but writes
 * nothing — no row is created just to record "nothing happened."
 */
export async function recordSpendUsd(usd: number, db: typeof defaultDb = defaultDb, now: Date = new Date()): Promise<void> {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError(`recordSpendUsd: usd must be a finite number >= 0, got ${usd}`);
  }
  if (usd === 0) return;
  const day = todayUtcDateString(now);
  await db
    .insert(dailySpend)
    .values({ spendDate: day, totalUsd: usd })
    .onConflictDoUpdate({
      target: dailySpend.spendDate,
      set: { totalUsd: sql`${dailySpend.totalUsd} + ${usd}`, updatedAt: sql`now()` },
    });
}

/** Combines the real ledger read with the pure exhausted check — the one
 * function `handleVerifyRequest`/`handleBatchStartRequest` call before
 * their expensive model call. */
export async function checkDailyBudget(db: typeof defaultDb = defaultDb, now: Date = new Date()): Promise<BudgetStatus> {
  const budgetUsd = getDailyBudgetUsd();
  const spentUsd = await getTodaySpendUsd(db, now);
  return { exhausted: isBudgetExhausted(spentUsd, budgetUsd), spentUsd, budgetUsd };
}

/** ASD-STE100 / Zinsser copy (CLAUDE.md): plain English, one clear
 * instruction, no jargon, no bare status code. Shown to a TTB agent, not a
 * developer. */
export const BUDGET_EXHAUSTED_MESSAGE = "LabelHunter has reached its spending limit for today. Please try again tomorrow.";
