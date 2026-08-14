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
 * migration `drizzle/migrations/0008_tricky_banshee.sql`) holds one row per UTC
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
 * stakes. This is a distinct pool from the project's own build-and-eval
 * spend cap ($25), which tracks development spend and does not pause on
 * cross — this number is the ongoing
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

/**
 * Shown when the budget guard itself cannot answer — the ledger read
 * failed (TRO-566 finding 3) — not when it answered "exhausted." Direction
 * is fail-closed either way (no model call happens), but the two causes
 * are different facts and get different words: this one asks the reader to
 * try again shortly, the exhausted message asks them to try tomorrow.
 * Conflating them would tell a caller "come back tomorrow" for a five-
 * second database blip.
 */
export const BUDGET_CHECK_UNAVAILABLE_MESSAGE = "LabelHunter could not check today's spending limit. Try again in a moment.";

/**
 * Conservative, documented UPPER bounds for what ONE model call might
 * cost — used only to RESERVE room in the ledger before the real cost is
 * known (`reserveDailyBudget` below, TRO-566 finding 2). The real,
 * measured cost (`haikuCallCostUsd`/the Sonnet equivalent,
 * `./anthropic-usage.ts`) is always what actually gets recorded — these
 * two numbers never appear in `daily_spend` themselves.
 *
 * Derived, not measured: 2x this file's own header-comment figures from
 * PRD §4's committed cost table (Haiku ~$0.005/label, Sonnet
 * ~$0.02/label) — headroom against real token-count variance between
 * labels, not a second independently-measured number.
 */
export const HAIKU_CALL_RESERVE_ESTIMATE_USD = 0.01;
export const SONNET_CALL_RESERVE_ESTIMATE_USD = 0.04;

export interface BudgetReservation {
  readonly reserved: boolean;
  /** The amount actually reserved. `0` when `reserved` is `false` — no
   * write happened, so there is nothing to settle later. */
  readonly reservedUsd: number;
  /** Today's real total AFTER this call — includes this reservation when
   * `reserved` is `true`; unchanged (the pre-call total) when `false`. */
  readonly spentUsd: number;
  readonly budgetUsd: number;
}

/**
 * Atomically reserves `estimatedUsd` of today's budget BEFORE a model call
 * starts — closes the check-then-act race `checkDailyBudget`/
 * `recordSpendUsd` leaves open (TRO-566 finding 2): two concurrent callers
 * that each read "under budget" before either one writes can together
 * spend past the cap. `daily-budget.test.ts`'s own race describe block
 * proves this directly, with the OLD check-then-act pair, before proving
 * this function closes it.
 *
 * One conditional `UPDATE ... WHERE total_usd + estimate < budget
 * RETURNING` — the same idiom `../batch-queue/escalation-cap.ts`'s
 * `reserveSonnetCall` already uses and already proves against a real
 * database under concurrency: Postgres serializes concurrent UPDATEs to
 * the SAME row, so two racing reservations for the same day cannot both
 * read "room" and both win. Strict `<`, matching `isBudgetExhausted`'s own
 * `>=`: a reservation that would land EXACTLY on the budget is refused,
 * the same "reached is exhausted" rule that function already documents.
 *
 * A brand-new day has no row yet — `ON CONFLICT DO NOTHING` inserts a `$0`
 * placeholder first, unconditionally. That insert never adds money on its
 * own, so it cannot itself race past the budget; the conditional UPDATE
 * right after it is the one statement that actually gates.
 *
 * The caller MUST follow a successful reservation with
 * `settleBudgetReservation` once the real cost is known (or the call
 * turned out not to happen at all) — see that function's own comment. No
 * database transaction spans the model call between the two calls: this
 * function returns before the call starts, `settleBudgetReservation` runs
 * after it resolves. (Review caveat: never hold a transaction open across
 * the provider call.)
 */
export async function reserveDailyBudget(
  estimatedUsd: number,
  db: typeof defaultDb = defaultDb,
  now: Date = new Date(),
): Promise<BudgetReservation> {
  if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) {
    throw new RangeError(`reserveDailyBudget: estimatedUsd must be a finite number >= 0, got ${estimatedUsd}`);
  }
  const budgetUsd = getDailyBudgetUsd();
  const day = todayUtcDateString(now);

  await db.insert(dailySpend).values({ spendDate: day, totalUsd: 0 }).onConflictDoNothing({ target: dailySpend.spendDate });

  const rows = await db
    .update(dailySpend)
    .set({ totalUsd: sql`${dailySpend.totalUsd} + ${estimatedUsd}`, updatedAt: sql`now()` })
    .where(sql`${dailySpend.spendDate} = ${day} AND ${dailySpend.totalUsd} + ${estimatedUsd} < ${budgetUsd}`)
    .returning({ totalUsd: dailySpend.totalUsd });

  if (rows.length === 0) {
    const spentUsd = await getTodaySpendUsd(db, now);
    return { reserved: false, reservedUsd: 0, spentUsd, budgetUsd };
  }
  return { reserved: true, reservedUsd: estimatedUsd, spentUsd: rows[0].totalUsd, budgetUsd };
}

/**
 * Corrects a reservation from its conservative estimate to the model
 * call's REAL, measured cost — the second half of `reserveDailyBudget`
 * (TRO-566 finding 2). Applies the delta (`realUsd - reservedUsd`,
 * ordinarily negative: the reservation is a documented UPPER bound, the
 * real cost is normally smaller) directly to today's ledger. No budget
 * re-check here — the reservation already gated admission; this call only
 * corrects the AMOUNT, it never re-decides whether the call should have
 * been allowed.
 *
 * `realUsd` is `0` when the call never actually happened — e.g. the
 * resolve worker's own caller lost `resolveEscalatedLabel`'s internal
 * review-queue reservation race and reused another caller's result instead
 * of calling Sonnet itself (`../resolver/index.ts`). The full reservation
 * comes back out.
 *
 * `GREATEST(..., 0)` floors the result at zero. In normal operation a
 * settle always follows its own matching reserve and never goes negative
 * on its own; the floor is defensive (standing rule 13) against a caller
 * bug settling more than was ever reserved — a negative number in a
 * ledger a human reads on a dashboard is worse than a floor at zero. The
 * database's own `daily_spend_total_usd_non_negative` check constraint
 * would otherwise reject the write outright.
 */
export async function settleBudgetReservation(
  reservedUsd: number,
  realUsd: number,
  db: typeof defaultDb = defaultDb,
  now: Date = new Date(),
): Promise<void> {
  if (!Number.isFinite(reservedUsd) || reservedUsd < 0) {
    throw new RangeError(`settleBudgetReservation: reservedUsd must be a finite number >= 0, got ${reservedUsd}`);
  }
  if (!Number.isFinite(realUsd) || realUsd < 0) {
    throw new RangeError(`settleBudgetReservation: realUsd must be a finite number >= 0, got ${realUsd}`);
  }
  const delta = realUsd - reservedUsd;
  if (delta === 0) return;
  const day = todayUtcDateString(now);
  await db
    .update(dailySpend)
    .set({ totalUsd: sql`GREATEST(${dailySpend.totalUsd} + ${delta}, 0)`, updatedAt: sql`now()` })
    .where(sql`${dailySpend.spendDate} = ${day}`);
}

/**
 * Thrown by a batch worker (TRO-566 finding 1) when `reserveDailyBudget`
 * refuses before a model call. This module never throws it itself —
 * `reserveDailyBudget` only ever returns `{ reserved: false, ... }` and
 * leaves the decision to its caller.
 *
 * `../../server/batch-queue/backoff.ts`'s `classifyModelCallError`
 * recognizes this class specifically and classifies it as retryable with a
 * distinct `isBudgetExhausted` flag, so the SAME attempts/backoff state
 * machine `extract-worker.ts`/`resolve-worker.ts` already use for a rate
 * limit or a 5xx also governs a budget-exhausted item: it retries a
 * bounded number of times (`claim.ts` still counts every reclaim against
 * `maxAttempts`, unconditionally), then reaches `FAILED` with THIS error's
 * own message as `last_error` — a clear, distinguishable reason a human
 * can act on (resubmit the batch once the budget resets), rather than
 * either hot-looping the database or hanging forever waiting for tomorrow.
 * See CHANGES.md for the fuller design rationale.
 */
export class BudgetExhaustedError extends Error {
  constructor(reservation: Pick<BudgetReservation, "spentUsd" | "budgetUsd">) {
    super(
      `Today's spending limit is reached ($${reservation.spentUsd.toFixed(2)} of $${reservation.budgetUsd.toFixed(2)}). ` +
        "Try this batch again after the daily reset.",
    );
    this.name = "BudgetExhaustedError";
  }
}
