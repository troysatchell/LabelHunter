// TRO-560: gate.sh's review step (G10) silently reused a previous run's
// findings when capture failed, with nothing in the output distinguishing
// "reviewed and clean" from "not reviewed this time" — and threw away the
// real failure reason. TRO-508's comment (2026-08-13) documented the second
// defect exactly: the coderabbit CLI reports its error as a JSON line on
// STDOUT (`{"type":"error","errorType":"rate_limit",...}`), but gate.sh
// wrote stderr to `.factory/coderabbit.err` and pointed readers there — the
// file the CLI leaves empty on this failure mode.
//
// This module is G10's full orchestration, extracted out of gate.sh so its
// decision logic is unit-testable (the pattern scripts/factory/defect-gates
// already established: a thin gate.sh call into a tested TS module). G10
// stays advisory: this never returns a status stronger than "warn".

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CoderabbitErrorEvent {
  errorType: string;
  message: string;
  raw: string;
}

export interface ParsedCoderabbitOutput {
  findings: number;
  lastError: CoderabbitErrorEvent | null;
}

/**
 * Parses the coderabbit CLI's JSONL stdout.
 *
 * Ignores lines that are not valid JSON (banner text, blank lines) instead
 * of throwing — the CLI's non-JSON output must never crash the gate. Keeps
 * the LAST `type: "error"` line, matching "most recent state" for a CLI that
 * streams status events before its terminal error.
 */
export function parseCoderabbitOutput(text: string): ParsedCoderabbitOutput {
  let findings = 0;
  let lastError: CoderabbitErrorEvent | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      if (rec.type === "finding") findings++;
      if (rec.type === "error") {
        lastError = {
          errorType: typeof rec.errorType === "string" ? rec.errorType : "unknown",
          message: typeof rec.message === "string" ? rec.message : "",
          raw: trimmed,
        };
      }
    }
  }
  return { findings, lastError };
}

/** Rate limiting is the one error type this module retries — see the ticket's scope note. */
export function isRateLimitError(err: CoderabbitErrorEvent | null): boolean {
  return err !== null && err.errorType === "rate_limit";
}

/**
 * Exponential backoff, capped. `attempt` is 1-based: `backoffMs(1)` is the
 * wait after the FIRST failed attempt, before the second try.
 */
export function backoffMs(attempt: number, baseMs = 2000, capMs = 20000): number {
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}

export interface CaptureMeta {
  /** The commit SHA HEAD pointed to when these findings were captured. */
  sha: string;
  capturedAt: string;
  findings: number;
}

export type ReviewGateStatus = "pass" | "warn";

export interface CaptureDecision {
  status: ReviewGateStatus;
  detail: string;
  /** Whether the fresh stdout/meta should replace the stored baseline. */
  persistFresh: boolean;
}

export interface DecideCaptureInput {
  rc: number;
  timedOut: boolean;
  parsed: ParsedCoderabbitOutput;
  previous: CaptureMeta | null;
  currentSha: string;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function errorSummary(input: DecideCaptureInput): string | null {
  if (input.parsed.lastError) {
    return `${input.parsed.lastError.errorType}: ${input.parsed.lastError.message}`;
  }
  if (input.timedOut) return "timed out";
  return null;
}

/**
 * Turns one capture attempt's outcome into a gate-visible decision.
 *
 * The staleness message is the fix for TRO-560's core defect: on rc!=0 with
 * an earlier run's findings to fall back on, the detail names the SHA those
 * findings were captured at and says plainly the current diff has NOT been
 * reviewed — never a reviewed-looking pass. The one exception is a re-run at
 * the SAME sha (nothing changed since the last successful capture): that
 * really has been reviewed, so the message says so instead of falsely
 * claiming staleness.
 */
export function decideCapture(input: DecideCaptureInput): CaptureDecision {
  const { rc, parsed, previous, currentSha } = input;
  const errSummary = errorSummary(input);

  if (rc === 0) {
    if (parsed.findings > 0) {
      return {
        status: "pass",
        persistFresh: true,
        detail: `${parsed.findings} finding(s) captured at ${shortSha(currentSha)} — triage required`,
      };
    }
    return {
      status: "pass",
      persistFresh: true,
      detail: `review completed with no findings (${shortSha(currentSha)})`,
    };
  }

  // rc != 0: never overwrite a good baseline with a failed attempt's noise.
  const failureNote = `capture failed: rc=${rc}${errSummary ? `, ${errSummary}` : ""} — see .factory/coderabbit-capture.json`;

  if (previous) {
    const stale = previous.sha !== currentSha;
    const provenance = stale
      ? `${previous.findings} finding(s) from an earlier run at ${shortSha(previous.sha)} — ` +
        `HEAD is now ${shortSha(currentSha)}; this diff has NOT been reviewed`
      : `${previous.findings} finding(s) captured at ${shortSha(previous.sha)} — same commit, still current`;
    return {
      status: "warn",
      persistFresh: false,
      detail: `${provenance} (${failureNote})`,
    };
  }

  return {
    status: "warn",
    persistFresh: false,
    detail: `review did not complete (${failureNote})`,
  };
}

// --- Retry orchestration -----------------------------------------------------

export interface RunnerResult {
  rc: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Runner = (args: string[], timeoutMs: number) => RunnerResult;

/** Spawns the real coderabbit binary. Not used by unit tests — they inject a fake Runner. */
export function defaultRunner(bin: string): Runner {
  return (args, timeoutMs) => {
    const result = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      maxBuffer: 32 * 1024 * 1024,
    });
    const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      rc: timedOut ? 124 : (result.status ?? 1),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut,
    };
  };
}

/** A real blocking sleep, via the `sleep` binary — not used by unit tests. */
export function defaultSleep(ms: number): void {
  if (ms <= 0) return;
  spawnSync("sleep", [(ms / 1000).toString()]);
}

export interface AttemptLog {
  attempt: number;
  rc: number;
  timedOut: boolean;
  findings: number;
  lastError: CoderabbitErrorEvent | null;
}

export interface CaptureRunResult {
  decision: CaptureDecision;
  attempts: AttemptLog[];
  finalStdout: string;
  finalStderr: string;
}

export interface RunCaptureOptions {
  base: string;
  currentSha: string;
  previous: CaptureMeta | null;
  runner: Runner;
  /** Total attempts, including the first — bounded, never unbounded. Default 3 (2 retries). */
  maxAttempts?: number;
  backoffFn?: (attempt: number) => number;
  timeoutMs?: number;
  sleep?: (ms: number) => void;
}

/**
 * Runs the capture, retrying only on a rate-limit error, up to a bounded
 * number of attempts. A non-rate-limit failure never retries — this is the
 * one error type the ticket puts in scope for backoff.
 */
/**
 * Hard ceiling on retry attempts, regardless of what a caller requests.
 * `Number.isFinite` alone rejects `NaN`/`Infinity` but accepts any large
 * finite number — a misconfigured `CR_MAX_ATTEMPTS` (e.g. "1000") is
 * "bounded" only in the technical sense, not the operational one the
 * ticket means by it. This is the actual bound.
 */
export const MAX_REASONABLE_ATTEMPTS = 10;

export function runCapture(opts: RunCaptureOptions): CaptureRunResult {
  // Clamped here, not just at the CLI boundary that parses CR_MAX_ATTEMPTS —
  // a direct caller passing 0 or a negative number must still get one real
  // attempt, never a silent no-op loop that reports "warn" without ever
  // invoking the runner. NaN and Infinity need their own branch: Math.max(1,
  // NaN) is NaN (the loop condition `attempt <= NaN` is always false — the
  // same zero-attempt bug this clamp exists to prevent), and Math.max(1,
  // Infinity) is Infinity — an unbounded retry loop, which the ticket puts
  // explicitly out of scope. Both fall back to the ordinary default instead.
  const requestedAttempts = opts.maxAttempts ?? 3;
  const maxAttempts = Number.isFinite(requestedAttempts)
    ? Math.min(MAX_REASONABLE_ATTEMPTS, Math.max(1, Math.floor(requestedAttempts)))
    : 3;
  const backoffFn = opts.backoffFn ?? backoffMs;
  const timeoutMs = opts.timeoutMs ?? 360_000;
  const sleep = opts.sleep ?? defaultSleep;
  const attempts: AttemptLog[] = [];
  let last: RunnerResult = { rc: 1, stdout: "", stderr: "", timedOut: false };
  let parsed: ParsedCoderabbitOutput = { findings: 0, lastError: null };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = opts.runner(["review", "--agent", "--base", opts.base], timeoutMs);
    parsed = parseCoderabbitOutput(last.stdout);
    attempts.push({
      attempt,
      rc: last.rc,
      timedOut: last.timedOut,
      findings: parsed.findings,
      lastError: parsed.lastError,
    });
    const succeeded = last.rc === 0;
    const retryable = !succeeded && isRateLimitError(parsed.lastError) && attempt < maxAttempts;
    if (succeeded || !retryable) break;
    sleep(backoffFn(attempt));
  }

  const decision = decideCapture({
    rc: last.rc,
    timedOut: last.timedOut,
    parsed,
    previous: opts.previous,
    currentSha: opts.currentSha,
  });

  return { decision, attempts, finalStdout: last.stdout, finalStderr: last.stderr };
}

// --- CLI: orchestrates one gate.sh G10 run and writes .factory artifacts. --
// Usage: tsx review-capture.ts --base main --out-dir /path/to/.factory
// Prints one JSON line to stdout: {"status": "pass"|"warn", "detail": "..."}
// Exit code: 0 whenever the orchestration itself completed (a "warn" review
// outcome is NOT a process failure — G10 is advisory). Non-zero only on an
// unexpected internal error, so gate.sh can tell "review says warn" apart
// from "this script crashed" and report each honestly.

/**
 * A bare type assertion here would trust the file's shape unconditionally
 * (lessons rule 13: validate at the boundary where a value's shape is only
 * assumed, not guaranteed). `coderabbit.meta.json` is written by this same
 * module in the ordinary case, but it is also a plain file on disk — a
 * crashed write, a manual edit, or an older format could leave it missing
 * the one field `decideCapture` actually compares (`sha`). A malformed file
 * reads as "no previous capture" (`null`), never as a half-populated
 * `CaptureMeta` that produces `"undefined finding(s) at undefined"`.
 */
export function isCaptureMeta(value: unknown): value is CaptureMeta {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.sha === "string" &&
    rec.sha.length > 0 &&
    typeof rec.capturedAt === "string" &&
    typeof rec.findings === "number"
  );
}

function loadPreviousMeta(outDir: string): CaptureMeta | null {
  const p = join(outDir, "coderabbit.meta.json");
  if (!existsSync(p)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    return isCaptureMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function gitHead(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return (r.stdout ?? "").trim() || "unknown";
}

/**
 * Parses a positive-integer environment override, falling back to `fallback`
 * on anything that is not a finite positive number.
 *
 * `Number(process.env.X ?? default)` looked safe but was not: an unset var
 * falls back correctly, but a var set to `""` (a real misconfiguration, not
 * a hypothetical) parses to `0`, not `NaN` — and a `maxAttempts` of 0 would
 * have skipped the retry loop's body entirely, reporting "review did not
 * complete" without ever invoking the runner once. This never returns
 * anything a caller could turn into a zero-attempt run.
 */
export function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  const floored = Math.floor(n);
  // Checking `n > 0` alone let a positive fraction below 1 (e.g. "0.5")
  // through, then floor it straight to 0 — exactly the value this function
  // exists to refuse. Check the FLOORED value, the one actually returned.
  return Number.isFinite(n) && floored > 0 ? floored : fallback;
}

function main(): void {
  try {
    const args = process.argv.slice(2);
    const get = (name: string, fallback: string): string => {
      const i = args.indexOf(`--${name}`);
      return i === -1 ? fallback : (args[i + 1] ?? fallback);
    };
    const base = get("base", "main");
    const outDir = get("out-dir", ".factory");
    const bin = process.env.CR_BIN ?? "coderabbit";
    mkdirSync(outDir, { recursive: true });

    const repoRoot = process.cwd();
    const currentSha = gitHead(repoRoot);
    const previous = loadPreviousMeta(outDir);
    const timeoutMs = parsePositiveIntEnv(process.env.CR_TIMEOUT_MS, 360_000);
    const maxAttempts = parsePositiveIntEnv(process.env.CR_MAX_ATTEMPTS, 3);
    const backoffBaseMs = parsePositiveIntEnv(process.env.CR_BACKOFF_BASE_MS, 2000);
    const backoffCapMs = parsePositiveIntEnv(process.env.CR_BACKOFF_CAP_MS, 20000);

    const result = runCapture({
      base,
      currentSha,
      previous,
      runner: defaultRunner(bin),
      maxAttempts,
      timeoutMs,
      backoffFn: (a) => backoffMs(a, backoffBaseMs, backoffCapMs),
    });

    // Always keep the full diagnostic of every attempt — the fix for
    // TRO-508's "readers pointed at an empty .err while the real reason sat
    // unread in the .json" defect. Written on every run, pass or fail, so a
    // future failure mode is never silently discarded either.
    writeFileSync(
      join(outDir, "coderabbit-capture.json"),
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          base,
          currentSha,
          attempts: result.attempts,
          finalRc: result.attempts[result.attempts.length - 1]?.rc ?? null,
          finalStderr: result.finalStderr,
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(outDir, "coderabbit.err"), result.finalStderr);

    if (result.decision.persistFresh) {
      writeFileSync(join(outDir, "coderabbit.json"), result.finalStdout);
      const meta: CaptureMeta = {
        sha: currentSha,
        capturedAt: new Date().toISOString(),
        findings: result.attempts[result.attempts.length - 1]?.findings ?? 0,
      };
      writeFileSync(join(outDir, "coderabbit.meta.json"), JSON.stringify(meta, null, 2) + "\n");
    }

    // No explicit process.exit() here: gate.sh always reads this CLI's stdout
    // through a pipe (command substitution), and process.exit() can cut a
    // pending pipe write off before it flushes. Returning lets Node drain
    // stdout and exit on its own with the default code 0.
    process.stdout.write(JSON.stringify({ status: result.decision.status, detail: result.decision.detail }));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`review-capture: internal error — ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("review-capture.ts")) main();
