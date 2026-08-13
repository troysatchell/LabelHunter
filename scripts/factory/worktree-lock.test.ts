/**
 * TRO-572: worktree.sh must serialize two truly concurrent invocations for
 * the SAME ticket, not just refuse a reuse from a different session.
 *
 * The gap TRO-557 left open: its `.factory-owner` ownership stamp is written
 * near the END of a successful provision -- after the database is
 * dropped/recreated and the port claimed. Two invocations landing at once
 * (the same session calling twice, or two `--steal` calls together) can both
 * pass the ownership check before either has written anything, then both
 * race `DROP DATABASE ... WITH (FORCE)` / `CREATE DATABASE` and both `cd`
 * into the same worktree directory at once.
 *
 * These tests exercise the real `mkdir`-based lock worktree.sh now takes
 * around that whole critical section, against a disposable git repo and a
 * disposable database on the same running Postgres server this test run's
 * own DATABASE_URL points at -- same approach as worktree-owner.test.ts
 * (TRO-557), not mocked.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const WORKTREE_SH = fileURLToPath(new URL("./worktree.sh", import.meta.url));

interface PgTarget {
  container: string;
  host: string;
  port: string;
  user: string;
  password: string;
}

function requirePgTargetFromEnv(): Omit<PgTarget, "container"> {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error("DATABASE_URL is not set. Source .factory-env before running tests.");
  }
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function discoverPgContainer(port: string): string {
  const result = spawnSync("docker", ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `could not list docker containers publishing port ${port}: ${result.error?.message ?? result.stderr}`,
    );
  }
  const name = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!name) {
    throw new Error(
      `no docker container publishes port ${port}. worktree.sh's own container-presence check needs one.`,
    );
  }
  return name;
}

function uniqueTicket(): string {
  // Matches worktree.sh's own ^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+$ validation.
  const raw = randomUUID().replace(/-/g, "").toUpperCase();
  return `ZZLOCK${raw.slice(0, 10)}-1`;
}

function ticketSlug(ticket: string): string {
  return ticket.toLowerCase().replace(/-/g, "_");
}

/** A pid guaranteed dead on every OS: spawn a real child and wait for it to
 * exit (spawnSync blocks until it does), then reuse its now-vacated pid. A
 * hardcoded magic number risks colliding with a live process on a system
 * with a high `pid_max` (CodeRabbit, TRO-572 review round 2). */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (!result.pid) {
    throw new Error(`could not determine the reaped child's pid: ${result.error}`);
  }
  return result.pid;
}

interface Fixture {
  scratchRoot: string;
  repoDir: string;
  worktreeDir: string;
  lockDir: string;
  dbName: string;
  ticket: string;
  branch: string;
}

function scratchGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeFixture(): Fixture {
  const ticket = uniqueTicket();
  const slug = ticketSlug(ticket);
  const scratchRoot = mkdtempSync(join(tmpdir(), "lh-wt-lock-"));
  const repoDir = join(scratchRoot, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
  scratchGit(repoDir, ["config", "user.email", "tro-572-test@example.com"]);
  scratchGit(repoDir, ["config", "user.name", "TRO-572 test"]);
  writeFileSync(join(repoDir, "README.md"), "TRO-572 disposable test fixture\n");
  scratchGit(repoDir, ["add", "README.md"]);
  scratchGit(repoDir, ["commit", "-q", "-m", "init"]);
  const worktreeDir = join(scratchRoot, `labelhunter-wt-${slug}`);
  return {
    scratchRoot,
    repoDir,
    worktreeDir,
    lockDir: `${worktreeDir}.lock`,
    dbName: `labelhunter_wt_${slug}`,
    ticket,
    branch: `test/tro-572-${slug}`,
  };
}

function worktreeShEnv(pg: PgTarget, sessionId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FACTORY_SESSION_ID;
  env.CLAUDE_CODE_SESSION_ID = sessionId;
  env.FACTORY_PG_CONTAINER = pg.container;
  env.FACTORY_PG_HOST = pg.host;
  env.FACTORY_PG_PORT = pg.port;
  env.FACTORY_PG_USER = pg.user;
  env.FACTORY_PG_PASSWORD = pg.password;
  return env;
}

function runWorktreeSh(fx: Fixture, pg: PgTarget, sessionId: string, extraArgs: string[] = []) {
  return spawnSync(WORKTREE_SH, [fx.ticket, fx.branch, "main", ...extraArgs], {
    cwd: fx.repoDir,
    env: worktreeShEnv(pg, sessionId),
    encoding: "utf8",
    // spawnSync blocks the event loop; the test's own `it(...)` timeout
    // cannot save a real hang (same reasoning as worktree-owner.test.ts).
    timeout: 45_000,
  });
}

/** Non-blocking spawn, for tests that need to observe a process WHILE it is
 * still running (blocked on the lock) rather than waiting for it to exit. */
function spawnWorktreeSh(fx: Fixture, pg: PgTarget, sessionId: string, extraArgs: string[] = []) {
  return spawn(WORKTREE_SH, [fx.ticket, fx.branch, "main", ...extraArgs], {
    cwd: fx.repoDir,
    env: worktreeShEnv(pg, sessionId),
  });
}

function collectText(stream: NodeJS.ReadableStream): { get: () => string } {
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
  });
  return { get: () => buf };
}

/** Resolves once `getBuf()` matches `pattern`, rejects if `timeoutMs` passes
 * first -- used to confirm a process is genuinely blocked waiting on the
 * lock before this test releases it. */
function waitForMatch(getBuf: () => string, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      const buf = getBuf();
      if (pattern.test(buf)) {
        clearInterval(poll);
        resolve(buf);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`timed out waiting for ${pattern} in output:\n${buf}`));
      }
    }, 50);
  });
}

/** Registers the `exit` listener with `.once` up front -- callers must call
 * this immediately after `spawn`, before anything else, so there is no gap
 * where a fast-exiting child's event could fire unobserved. Bounded by
 * `timeoutMs`: a child that never exits is killed rather than left to hang
 * the test (and, via the fixture's own cleanup, leak a background process). */
function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 40_000): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function queryDb(pg: PgTarget, dbName: string, sql: string) {
  const client = new Client({
    host: pg.host,
    port: Number(pg.port),
    user: pg.user,
    password: pg.password,
    database: dbName,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function cleanupFixture(fx: Fixture, pg: PgTarget): Promise<void> {
  const errors: unknown[] = [];
  try {
    execFileSync("git", ["worktree", "remove", "--force", fx.worktreeDir], { cwd: fx.repoDir });
  } catch (err) {
    errors.push(err);
  }
  try {
    const admin = new Client({
      host: pg.host,
      port: Number(pg.port),
      user: pg.user,
      password: pg.password,
      database: "postgres",
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
    });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${fx.dbName} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  } catch (err) {
    errors.push(err);
  }
  try {
    rmSync(fx.scratchRoot, { recursive: true, force: true });
  } catch (err) {
    errors.push(err);
  }
  if (errors.length > 0) {
    console.error(`TRO-572 fixture cleanup had ${errors.length} failure(s):`, errors);
    throw new AggregateError(errors, `TRO-572 fixture cleanup had ${errors.length} failure(s)`);
  }
}

async function withFixture(fn: (fx: Fixture, pg: PgTarget) => Promise<void>): Promise<void> {
  const pgConn = requirePgTargetFromEnv();
  const pg: PgTarget = { ...pgConn, container: discoverPgContainer(pgConn.port) };
  const fx = makeFixture();
  let bodyFailed = false;
  // Cleanup's own error is recorded here and thrown AFTER try/finally
  // completes, never from inside finally -- throwing directly inside a
  // finally block silently replaces whatever the try/catch above it was
  // already propagating (CodeRabbit, TRO-572 review round 2).
  let cleanupError: unknown;
  try {
    await fn(fx, pg);
  } catch (err) {
    bodyFailed = true;
    throw err;
  } finally {
    try {
      await cleanupFixture(fx, pg);
    } catch (err) {
      cleanupError = err;
      if (bodyFailed) {
        console.error("TRO-572 fixture cleanup ALSO failed after a test failure:", err);
      }
    }
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

describe("worktree.sh concurrency lock (TRO-572)", () => {
  it(
    "blocks on a lock another invocation holds, then proceeds once it is released",
    () =>
      withFixture(async (fx, pg) => {
        // Simulate another invocation already inside the critical section:
        // create the lock dir by hand, owned by THIS test process's own pid
        // (alive for the test's whole duration) on this host.
        mkdirSync(fx.lockDir);
        writeFileSync(join(fx.lockDir, "owner"), `PID=${process.pid}\nHOST=${hostname()}\n`);

        const child = spawnWorktreeSh(fx, pg, "test-session-lock-a");
        // Registered immediately, before anything else -- a fast-exiting
        // child's `exit` event must never fire unobserved (CodeRabbit,
        // TRO-572 review round 1).
        const exitPromise = waitForExit(child);
        const stderr = collectText(child.stderr);
        const stdout = collectText(child.stdout);

        // Proves it actually blocked, not that it happened to be slow.
        await waitForMatch(() => stderr.get(), /another invocation is provisioning/, 5_000);
        expect(child.exitCode, "should still be blocked on the lock").toBeNull();

        // Release the simulated lock -- the real release path.
        rmSync(fx.lockDir, { recursive: true, force: true });

        const code = await exitPromise;
        expect(code, `stdout: ${stdout.get()}\nstderr: ${stderr.get()}`).toBe(0);

        // It actually finished provisioning, not just exited early.
        const stamp = readFileSync(join(fx.worktreeDir, ".factory-owner"), "utf8");
        expect(stamp).toMatch(/^FACTORY_OWNER_SESSION=test-session-lock-a$/m);
      }),
    60_000,
  );

  it(
    "breaks a stale lock left by a dead process on this host instead of waiting out the timeout",
    () =>
      withFixture(async (fx, pg) => {
        mkdirSync(fx.lockDir);
        const pid = deadPid();
        writeFileSync(join(fx.lockDir, "owner"), `PID=${pid}\nHOST=${hostname()}\n`);

        const startedAt = Date.now();
        const result = runWorktreeSh(fx, pg, "test-session-lock-b");
        const elapsedMs = Date.now() - startedAt;

        expect(result.status, `stderr: ${result.stderr}`).toBe(0);
        expect(result.stderr).toContain(`breaking a stale lock from dead pid ${pid}`);
        // Well under the ~60s poll timeout -- proves it broke the lock
        // immediately rather than waiting it out and succeeding anyway.
        expect(elapsedMs).toBeLessThan(20_000);
      }),
    60_000,
  );

  it(
    "serializes two REAL concurrent invocations for the same ticket without corrupting the database",
    () =>
      withFixture(async (fx, pg) => {
        // Launched back to back, no await between them -- as close to
        // simultaneous as two real OS processes get. Before TRO-572 this
        // could interleave DROP/CREATE DATABASE across both processes; one
        // side would see "database ... already exists" or the final
        // database could be left half-created.
        const first = spawnWorktreeSh(fx, pg, "test-session-concurrent");
        const firstExit = waitForExit(first); // registered immediately -- see waitForExit's own comment
        const second = spawnWorktreeSh(fx, pg, "test-session-concurrent");
        const secondExit = waitForExit(second);
        const firstErr = collectText(first.stderr);
        const secondErr = collectText(second.stderr);

        const [codeA, codeB] = await Promise.all([firstExit, secondExit]);
        expect(codeA, `first stderr: ${firstErr.get()}`).toBe(0);
        expect(codeB, `second stderr: ${secondErr.get()}`).toBe(0);

        // The database is left in a valid, queryable state -- not
        // half-dropped or half-created by an interleaved race.
        const result = await queryDb(pg, fx.dbName, "SELECT 1 AS ok");
        expect(result.rows).toEqual([{ ok: 1 }]);

        // The concrete failure this ticket fixes: an interleaved
        // DROP/CREATE DATABASE pair raises a real postgres ERROR (distinct
        // from the benign "does not exist, skipping" NOTICE a normal first
        // provision prints). Neither process should ever see one.
        expect(firstErr.get(), "first invocation").not.toMatch(/^ERROR:/m);
        expect(secondErr.get(), "second invocation").not.toMatch(/^ERROR:/m);

        // At most one of the two could have found the lock already held
        // (mkdir is atomic; only one loser is possible with two racers) --
        // not asserted as exactly 1, since real OS scheduling occasionally
        // lets the first finish before the second even attempts `mkdir`.
        const waitedCount = [firstErr.get(), secondErr.get()].filter((s) =>
          /another invocation is provisioning/.test(s),
        ).length;
        expect(waitedCount).toBeLessThanOrEqual(1);
      }),
    60_000,
  );

  it(
    "two waiters racing to break the same stale lock never both reset the database at once",
    () =>
      withFixture(async (fx, pg) => {
        // Regression for the TOCTOU CodeRabbit found in round 1: a naive
        // read-then-`rm -rf` let a SECOND waiter delete a lock a THIRD,
        // live invocation had already re-acquired between the first
        // waiter's read and its removal, letting two processes believe
        // they each held the lock alone. Both racers below see the exact
        // same stale, dead-pid lock at once.
        mkdirSync(fx.lockDir);
        writeFileSync(join(fx.lockDir, "owner"), `PID=${deadPid()}\nHOST=${hostname()}\n`);

        const first = spawnWorktreeSh(fx, pg, "test-session-stale-race");
        const firstExit = waitForExit(first);
        const second = spawnWorktreeSh(fx, pg, "test-session-stale-race");
        const secondExit = waitForExit(second);
        const firstErr = collectText(first.stderr);
        const secondErr = collectText(second.stderr);

        const [codeA, codeB] = await Promise.all([firstExit, secondExit]);
        expect(codeA, `first stderr: ${firstErr.get()}`).toBe(0);
        expect(codeB, `second stderr: ${secondErr.get()}`).toBe(0);

        const result = await queryDb(pg, fx.dbName, "SELECT 1 AS ok");
        expect(result.rows).toEqual([{ ok: 1 }]);
        expect(firstErr.get(), "first invocation").not.toMatch(/^ERROR:/m);
        expect(secondErr.get(), "second invocation").not.toMatch(/^ERROR:/m);
      }),
    60_000,
  );
});
