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
  /**
   * TRO-548: set when this capture was a SCOPED review (`--base-commit
   * <scopedFrom>`), not a full-branch one — `findings` then counts only
   * the diff-since-`scopedFrom` slice, not the whole branch. Undefined for
   * an ordinary full-branch capture, and for any meta.json written before
   * this field existed — always optional, never assumed present.
   */
  scopedFrom?: string | null;
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
  /**
   * Set (TRO-548) when this capture scoped CodeRabbit's own diff to
   * `--base-commit <sha>` — the last real review's SHA — instead of the
   * whole branch. Undefined/null for an ordinary full-branch review.
   */
  scopedFromSha?: string | null;
}

export function shortSha(sha: string): string {
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
  const scopeNote = input.scopedFromSha ? ` (scoped since ${shortSha(input.scopedFromSha)})` : "";

  if (rc === 0) {
    if (parsed.findings > 0) {
      return {
        status: "pass",
        persistFresh: true,
        detail: `${parsed.findings} finding(s) captured at ${shortSha(currentSha)} — triage required${scopeNote}`,
      };
    }
    return {
      status: "pass",
      persistFresh: true,
      detail: `review completed with no findings (${shortSha(currentSha)})${scopeNote}`,
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

// --- Review scope: mode + carry-forward classification (TRO-548) -----------
//
// TRO-544's orchestrator pass ran gate.sh 11 times. Each run re-reviewed the
// FULL branch diff, including the previous round's own triage prose:
// findings regenerated every round (3, 12, 4, 5, 8, 4, 3, 2, 4, 10), real
// substance ending at round 12 of 13. Lessons rule 31 capped this by asking
// agents to stop manually. This section is the mechanical cap: skip a
// re-review entirely when nothing worth reviewing changed since the last
// real capture, and scope CodeRabbit's own diff to what IS new otherwise —
// never weakening the first full-branch review a ticket branch gets.

/** gate.sh's `--review` flag. "carry" is the default. */
export type ReviewMode = "off" | "carry" | "full";

/** Anything other than "off" or "full" reads as "carry" — the safe default, never a crash on a typo. */
export function normalizeReviewMode(raw: string | undefined): ReviewMode {
  return raw === "off" || raw === "full" ? raw : "carry";
}

/**
 * Paths the ticket names explicitly as never worth a re-review on their
 * own: the root CHANGES.md (prose, already reviewed at gate G7) and the
 * factory's own append-only JSONL logs (scorecard, review-findings) —
 * machine-written bookkeeping, not code. A same-named file in a different
 * directory does not match: this repo has exactly one CHANGES.md, at the
 * root.
 */
export function isBoringPath(path: string): boolean {
  if (path === "CHANGES.md") return true;
  return path.startsWith("factory/") && path.endsWith(".jsonl");
}

// `#` and a bare `*` both need a boundary check, not a bare prefix match:
//   - `#` alone matched a TS/JS PRIVATE CLASS FIELD ("#cache = new Map();")
//     as a comment — real code, in this repo's own language. `#` now must
//     be followed by whitespace, `!` (a shebang), or end-of-line. This also
//     means a real but unspaced `#comment` (no space after `#`) no longer
//     matches — the safe direction: an occasional missed skip, never a
//     hidden change.
//   - A bare `*` with nothing required after it matched `*2` (a glued
//     multiplication) as a JSDoc continuation. `*` now must be followed by
//     `/` (a close, `*/`) or whitespace/end-of-line (a JSDoc line's actual
//     shape). KNOWN REMAINING GAP: `* 2` (multiplication, WITH a space) is
//     textually identical to a real JSDoc continuation line — telling them
//     apart needs block-comment state across lines, out of scope for a
//     per-line classifier. Prettier's own line-break style does not
//     produce this shape in practice (operators stay at the end of the
//     previous line, not the start of the next).
const COMMENT_MARKER = /^(\/\/|\/\*|\*(?:\/|(?=\s|$))|#(?=[\s!]|$)|<!--|-->)/;

/**
 * True for a blank line, or a line whose real content starts with a
 * comment marker: `//`, `/*`, a block-comment continuation (`*`) or close
 * (`*​/`), `#`, or an HTML/Markdown comment delimiter. Checked against a
 * diff line with its `+`/`-` prefix already stripped. See `COMMENT_MARKER`
 * above for the exact boundary rules and the one documented gap.
 *
 * Deliberately conservative: a line that mixes code and a trailing comment
 * ("const x = 2; // was 1") does NOT match — it starts with code, not a
 * comment marker, so it is real content, not review-skippable. Guessing
 * wrong the other way would let a real change slip past review.
 */
export function isCommentOrBlankLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || COMMENT_MARKER.test(trimmed);
}

export interface ParsedDiffFile {
  path: string;
  binary: boolean;
  /** Added/removed content lines for this file, +/- prefix stripped. Context lines are never included. */
  changedLines: string[];
}

/**
 * Parses `git diff --unified=0` output into one entry per changed file.
 * `--unified=0` is the caller's responsibility to pass — it means every
 * `+`/`-` line here IS a real change, never leftover context, so no
 * hunk-header bookkeeping is needed beyond starting a new entry on each
 * `diff --git` line.
 */
export function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // "diff --git a/<path> b/<path>" — the b/ side is the post-change
      // path, which still resolves correctly for a delete (b/ names the
      // pre-delete path git still prints there) and a rename.
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      current = { path: match ? match[2] : line, binary: false, changedLines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("Binary files ")) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      current.changedLines.push(line.slice(1));
    }
  }
  return files;
}

/**
 * A file's change is boring when its path is unconditionally boring
 * (`isBoringPath`) or every changed line is blank/comment-only. A binary
 * file is never boring — there is no line content to inspect, so this
 * refuses to guess rather than risk hiding a real change.
 *
 * Zero changed lines (a pure rename, for instance) is boring BY DESIGN —
 * stated explicitly here, not left as an implicit vacuous-true from
 * `.every()` on an empty array: nothing changed, so there is nothing to
 * review.
 */
export function isFileChangeBoring(file: ParsedDiffFile): boolean {
  if (file.binary) return false;
  if (isBoringPath(file.path)) return true;
  if (file.changedLines.length === 0) return true;
  return file.changedLines.every(isCommentOrBlankLine);
}

/**
 * Zero changed files is boring BY DESIGN, stated explicitly — nothing
 * changed, so there is nothing to review. Not left as an implicit
 * vacuous-true from `.every()` on an empty array.
 */
export function isDiffBoring(files: ParsedDiffFile[]): boolean {
  if (files.length === 0) return true;
  return files.every(isFileChangeBoring);
}

/**
 * Diffs `fromSha` against `toSha` with zero context lines (`parseUnifiedDiff`'s
 * precondition). Returns null on any git failure — an unresolvable SHA,
 * most likely — rather than throwing: an unreadable diff must fall through
 * to a real review, never silently read as boring.
 */
export function diffSince(cwd: string, fromSha: string, toSha: string): ParsedDiffFile[] | null {
  const r = spawnSync("git", ["diff", "--no-color", "--unified=0", fromSha, toSha], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return parseUnifiedDiff(r.stdout ?? "");
}

export type ReviewPlan =
  | { kind: "off" }
  | { kind: "carried-forward"; sha: string; findings: number; reason: string }
  | { kind: "run"; baseArgs: string[]; scopedFromSha: string | null };

export interface PlanReviewInput {
  mode: ReviewMode;
  previous: CaptureMeta | null;
  currentSha: string;
  /**
   * The diff between `previous.sha` and `currentSha`, already parsed — or
   * null when it was never computed (no previous capture yet, mode is not
   * "carry", or the diff itself could not be computed). null always falls
   * through to a real run: an unreadable diff must never look boring.
   */
  diffSincePrevious: ParsedDiffFile[] | null;
}

/**
 * Decides what G10 does this run — the mechanical form of lessons rule 31's
 * orchestrator-discipline stop rule. Never weakens the FIRST review a
 * ticket branch gets: with no `previous` capture on record, every mode
 * except "off" runs a full `--base <baseRef>` review, unconditionally.
 */
export function planReview(input: PlanReviewInput, baseRef: string): ReviewPlan {
  if (input.mode === "off") return { kind: "off" };

  if (input.mode === "full" || !input.previous) {
    return { kind: "run", baseArgs: ["--base", baseRef], scopedFromSha: null };
  }

  // mode === "carry" with a previous capture on record.
  if (input.previous.sha === input.currentSha) {
    return {
      kind: "carried-forward",
      sha: input.previous.sha,
      findings: input.previous.findings,
      reason: "no changes since that review",
    };
  }

  if (input.diffSincePrevious !== null && isDiffBoring(input.diffSincePrevious)) {
    return {
      kind: "carried-forward",
      sha: input.previous.sha,
      findings: input.previous.findings,
      reason: "diff since then touches only CHANGES.md, factory/*.jsonl, or comment-only hunks",
    };
  }

  // Real changes since the last review: CodeRabbit only needs to see what's
  // NEW, not the whole branch again — the CLI's own --base-commit flag
  // scopes its diff the same way --base scopes it against a branch.
  return { kind: "run", baseArgs: ["--base-commit", input.previous.sha], scopedFromSha: input.previous.sha };
}

/** Formats the exact "carried-forward from <sha>" wording the ticket specifies for gate-result.json. */
export function formatCarriedForwardDetail(plan: Extract<ReviewPlan, { kind: "carried-forward" }>): string {
  return `carried-forward from ${shortSha(plan.sha)} — ${plan.reason} (${plan.findings} finding(s) from that review still stand)`;
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
  /** TRO-548: the CLI args after `review --agent`. Defaults to `["--base", base]`. */
  baseArgs?: string[];
  /** TRO-548: set alongside a `--base-commit` baseArgs — surfaced in the decision detail. */
  scopedFromSha?: string | null;
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
  const baseArgs = opts.baseArgs ?? ["--base", opts.base];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = opts.runner(["review", "--agent", ...baseArgs], timeoutMs);
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
    scopedFromSha: opts.scopedFromSha,
  });

  return { decision, attempts, finalStdout: last.stdout, finalStderr: last.stderr };
}

// --- CLI: orchestrates one gate.sh G10 run and writes .factory artifacts. --
// Usage: tsx review-capture.ts --base main --mode carry --out-dir /path/to/.factory
// Prints one JSON line to stdout: {"status": "pass"|"warn"|"carried", "detail": "..."}
// --mode (TRO-548): off|carry|full, default carry. "off" and a
// carried-forward "carry" decision never invoke the coderabbit binary at
// all — that IS the mechanical cap, not just a relabeling of the result.
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
 * True when `git status --porcelain` reports anything at all — staged,
 * unstaged, or untracked.
 *
 * TRO-548's same-SHA carry-forward path compares COMMITTED SHAs; it has no
 * visibility into uncommitted content. gate.sh's own full run already
 * refuses on a dirty tree before G10 is ever reached, but review-capture.ts
 * can also run standalone, outside that guarantee — this check enforces
 * the same safety here too, rather than assuming the caller always did.
 */
export function isWorkingTreeDirty(cwd: string): boolean {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  return (r.stdout ?? "").trim().length > 0;
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
    const mode = normalizeReviewMode(get("mode", "carry"));
    const bin = process.env.CR_BIN ?? "coderabbit";
    mkdirSync(outDir, { recursive: true });

    const repoRoot = process.cwd();
    const currentSha = gitHead(repoRoot);
    const storedPrevious = loadPreviousMeta(outDir);

    if (mode === "off") {
      process.stdout.write(JSON.stringify({ status: "skip", detail: "review disabled (--review=off)" }));
      return;
    }

    // A dirty tree means real, uncommitted content exists that no captured
    // SHA can vouch for — planReview's SHA-based classification cannot see
    // it. gate.sh's own full run already refuses before G10 on a dirty
    // tree; this is the same safety net for a standalone invocation.
    // Treating `previous` as absent forces planReview's unconditional
    // full-run branch (mode "full", or "carry" with no previous) — never a
    // carry-forward built on a comparison the dirty tree has invalidated.
    const dirty = isWorkingTreeDirty(repoRoot);
    const previous = dirty ? null : storedPrevious;

    // Only ever computed in carry mode, with a previous capture at a
    // DIFFERENT sha to diff against — full mode always runs full (below),
    // and a same-sha carry-forward needs no diff at all.
    const diffSincePrevious =
      mode === "carry" && previous && previous.sha !== currentSha
        ? diffSince(repoRoot, previous.sha, currentSha)
        : null;

    const plan = planReview({ mode, previous, currentSha, diffSincePrevious }, base);

    if (plan.kind === "carried-forward") {
      // The actual cap: no coderabbit invocation happens on this path at
      // all. Deliberately does NOT touch coderabbit.meta.json — the
      // "previous" anchor stays the SHA of the last REAL review, so a run
      // of consecutive boring commits keeps diffing against that same real
      // review, not against the just-skipped one.
      process.stdout.write(JSON.stringify({ status: "carried", detail: formatCarriedForwardDetail(plan) }));
      return;
    }
    if (plan.kind === "off") {
      // Unreachable in practice: `mode` was already checked above, and
      // planReview only ever returns "off" when its own `mode` input is
      // "off" — which this branch's `mode` (carry/full) never is. Handled
      // anyway so the type narrows `plan` to "run" below without a cast.
      process.stdout.write(JSON.stringify({ status: "skip", detail: "review disabled (--review=off)" }));
      return;
    }

    const timeoutMs = parsePositiveIntEnv(process.env.CR_TIMEOUT_MS, 360_000);
    const maxAttempts = parsePositiveIntEnv(process.env.CR_MAX_ATTEMPTS, 3);
    const backoffBaseMs = parsePositiveIntEnv(process.env.CR_BACKOFF_BASE_MS, 2000);
    const backoffCapMs = parsePositiveIntEnv(process.env.CR_BACKOFF_CAP_MS, 20000);

    const result = runCapture({
      base,
      baseArgs: plan.baseArgs,
      scopedFromSha: plan.scopedFromSha,
      currentSha,
      // The real stored capture, dirty tree or not: this is only ever read
      // by decideCapture's rc!=0 STALE-FALLBACK messaging ("N finding(s)
      // from an earlier run"), a different question from whether the
      // carry-forward shortcut above was safe to take.
      previous: storedPrevious,
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
        // TRO-548: names this capture as a scoped slice, not a full-branch
        // review, so `findings` is never misread as the whole branch's
        // count on a later read of this file.
        scopedFrom: plan.scopedFromSha,
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
