/**
 * Tests for the daily spend budget guard (TRO-482 / LH-061, PRD §8, TH-R6).
 * Written first, per PRD §6's TDD mandate — `daily-budget.ts` does not
 * exist yet when this file is added.
 *
 * Two kinds of test, in two `describe` blocks: pure logic (no I/O, no
 * clock dependency beyond an injected `Date`) and DB-backed behavior
 * against this worktree's own real Postgres database — the same "real DB,
 * no mock" convention `src/app/api/verify/route.test.ts` already uses.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../lib/db";
import { dailySpend } from "../../lib/db/schema";
import {
  BUDGET_EXHAUSTED_MESSAGE,
  checkDailyBudget,
  DEFAULT_DAILY_BUDGET_USD,
  getDailyBudgetUsd,
  getTodaySpendUsd,
  isBudgetExhausted,
  recordSpendUsd,
  todayUtcDateString,
} from "./daily-budget";

describe("isBudgetExhausted — pure", () => {
  it("is not exhausted when spend is below the budget", () => {
    expect(isBudgetExhausted(1, 5)).toBe(false);
  });

  it("is exhausted when spend equals the budget", () => {
    expect(isBudgetExhausted(5, 5)).toBe(true);
  });

  it("is exhausted when spend exceeds the budget", () => {
    expect(isBudgetExhausted(5.01, 5)).toBe(true);
  });

  it("treats zero spend against a positive budget as not exhausted", () => {
    expect(isBudgetExhausted(0, 5)).toBe(false);
  });
});

describe("getDailyBudgetUsd — pure, env-driven", () => {
  const ORIGINAL = process.env.DAILY_BUDGET_USD;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DAILY_BUDGET_USD;
    else process.env.DAILY_BUDGET_USD = ORIGINAL;
  });

  it("returns the documented default when DAILY_BUDGET_USD is unset", () => {
    delete process.env.DAILY_BUDGET_USD;
    expect(getDailyBudgetUsd()).toBe(DEFAULT_DAILY_BUDGET_USD);
  });

  it("returns the documented default when DAILY_BUDGET_USD is empty", () => {
    process.env.DAILY_BUDGET_USD = "";
    expect(getDailyBudgetUsd()).toBe(DEFAULT_DAILY_BUDGET_USD);
  });

  it("reads a real positive override", () => {
    process.env.DAILY_BUDGET_USD = "12.50";
    expect(getDailyBudgetUsd()).toBe(12.5);
  });

  it("falls back to the default on a non-numeric value — never NaN, never a crash", () => {
    process.env.DAILY_BUDGET_USD = "not-a-number";
    expect(getDailyBudgetUsd()).toBe(DEFAULT_DAILY_BUDGET_USD);
  });

  it("falls back to the default on a zero or negative value", () => {
    process.env.DAILY_BUDGET_USD = "0";
    expect(getDailyBudgetUsd()).toBe(DEFAULT_DAILY_BUDGET_USD);
    process.env.DAILY_BUDGET_USD = "-3";
    expect(getDailyBudgetUsd()).toBe(DEFAULT_DAILY_BUDGET_USD);
  });
});

describe("todayUtcDateString — pure", () => {
  it("formats a Date as a UTC YYYY-MM-DD string", () => {
    expect(todayUtcDateString(new Date("2026-08-12T23:59:00Z"))).toBe("2026-08-12");
  });

  it("uses the UTC day, not the local day, near a day boundary", () => {
    // 2026-08-12T00:30:00Z is still 2026-08-11 in a negative-UTC-offset
    // local zone — this function must not drift with the runner's TZ.
    expect(todayUtcDateString(new Date("2026-08-12T00:30:00Z"))).toBe("2026-08-12");
  });
});

// The UTC day this whole suite runs against — real inserts below always use
// today, per `recordSpendUsd`'s own contract, so tests clean up by this key.
const TEST_DAY = todayUtcDateString();

describe("getTodaySpendUsd / recordSpendUsd — DB-backed, real worktree Postgres", () => {
  afterEach(async () => {
    await db.delete(dailySpend).where(eq(dailySpend.spendDate, TEST_DAY));
  });

  it("reads zero when no row exists for today", async () => {
    expect(await getTodaySpendUsd(db)).toBe(0);
  });

  it("records a real spend amount and reads it back", async () => {
    await recordSpendUsd(0.008932, db);
    expect(await getTodaySpendUsd(db)).toBeCloseTo(0.008932, 6);
  });

  it("accumulates across multiple calls — never overwrites", async () => {
    await recordSpendUsd(0.005, db);
    await recordSpendUsd(0.02, db);
    await recordSpendUsd(0.0075, db);
    expect(await getTodaySpendUsd(db)).toBeCloseTo(0.0325, 6);
  });

  it("rejects a negative amount rather than silently recording it", async () => {
    await expect(recordSpendUsd(-1, db)).rejects.toThrow(RangeError);
    expect(await getTodaySpendUsd(db)).toBe(0);
  });

  it("is a no-op for a zero amount — no row created, no write", async () => {
    await recordSpendUsd(0, db);
    expect(await getTodaySpendUsd(db)).toBe(0);
  });
});

describe("checkDailyBudget — DB-backed, combines the pure check with the real ledger", () => {
  afterEach(async () => {
    await db.delete(dailySpend).where(eq(dailySpend.spendDate, TEST_DAY));
    delete process.env.DAILY_BUDGET_USD;
  });

  it("is not exhausted with no spend recorded yet", async () => {
    process.env.DAILY_BUDGET_USD = "5";
    const status = await checkDailyBudget(db);
    expect(status).toEqual({ exhausted: false, spentUsd: 0, budgetUsd: 5 });
  });

  it("is exhausted once real recorded spend reaches the configured budget", async () => {
    process.env.DAILY_BUDGET_USD = "1";
    await recordSpendUsd(1, db);
    const status = await checkDailyBudget(db);
    expect(status.exhausted).toBe(true);
    expect(status.spentUsd).toBeCloseTo(1, 6);
    expect(status.budgetUsd).toBe(1);
  });
});

describe("BUDGET_EXHAUSTED_MESSAGE — a friendly, specific message, not a raw error", () => {
  it("is plain English, not a status code or an exception name", () => {
    expect(BUDGET_EXHAUSTED_MESSAGE).not.toMatch(/error|exception|\d{3}/i);
    expect(BUDGET_EXHAUSTED_MESSAGE.length).toBeGreaterThan(10);
  });
});
