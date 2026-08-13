// TRO-553: a human-approved exception path for gate.sh's G6 (regression-test)
// check.
//
// G6's premise is that every ticket changes production code, so it fails the
// gate when a branch adds zero test cases. That premise is false for a
// docs-only ticket (a checkpoint walkthrough) and a test-repair ticket (the
// fix has no production-code change to write a red-first case against, and
// the only behavior candidate is already covered by an existing test). Three
// occurrences crossed the factory's own recurrence threshold — see
// factory/config.yaml's recurrenceLadder and TRO-553.
//
// The exception record lives in factory/gate-exceptions.json, committed to
// the repo. gate.sh honors a record ONLY when it names a non-empty approver.
// An agent can freely propose an entry in a PR, but that alone never makes
// G6 pass — until the entry carries an approver, resolveException reports
// "unapproved", the same as "none". The real backstop is procedural, not
// code: only the orchestrator writes an entry here, and only after Troy's
// approval already exists on the named Linear ticket (see the file's own
// $comment block). This module cannot verify that provenance; it can only
// refuse to honor a record that skipped the one field approval requires.

import { existsSync, readFileSync } from "node:fs";

export interface GateException {
  /** The ticket this exception covers, e.g. "TRO-547". */
  ticket: string;
  /** The gate.sh check id this exception covers, e.g. "regression-test". */
  gate: string;
  /** Why no red-first case is possible for this ticket. */
  reason: string;
  /**
   * The human who approved this exception. An empty or missing value means
   * NOT approved — resolveException must never read that as "approved".
   */
  approver: string;
  /** YYYY-MM-DD the approval was given. */
  date: string;
  /** The PR this exception covers, for provenance. Optional. */
  pr?: number | string;
}

export interface GateExceptionsFile {
  version: number;
  exceptions: GateException[];
}

export type ExceptionOutcome =
  | { state: "none" }
  | { state: "approved"; exception: GateException }
  | { state: "unapproved"; exception: GateException };

/**
 * Parses a gate-exceptions.json document.
 *
 * Throws on a structurally invalid document (no `exceptions` array) rather
 * than defaulting to an empty list — a malformed file should surface loudly,
 * not silently behave like "no exceptions exist".
 */
export function parseExceptionsFile(raw: string): GateExceptionsFile {
  const doc = JSON.parse(raw) as Partial<GateExceptionsFile>;
  if (!doc || !Array.isArray(doc.exceptions)) {
    throw new Error("gate-exceptions.json: missing or invalid \"exceptions\" array");
  }
  return { version: doc.version ?? 1, exceptions: doc.exceptions };
}

/**
 * Loads the exceptions file from disk. A missing file reads as "no
 * exceptions recorded" — most repos and most gate runs never need one.
 */
export function loadExceptionsFile(path: string): GateExceptionsFile {
  if (!existsSync(path)) return { version: 1, exceptions: [] };
  return parseExceptionsFile(readFileSync(path, "utf8"));
}

/**
 * Looks up whether {ticket, gate} has an approved exception on file.
 *
 * Absent a match, ordinary production tickets get "none" — the same result
 * as if this file did not exist, which keeps their gate behavior unchanged.
 */
export function resolveException(
  ticket: string,
  gate: string,
  file: GateExceptionsFile,
): ExceptionOutcome {
  const match = file.exceptions.find((e) => e.ticket === ticket && e.gate === gate);
  if (!match) return { state: "none" };
  const approver = (match.approver ?? "").trim();
  if (approver.length === 0) return { state: "unapproved", exception: match };
  return { state: "approved", exception: match };
}

/** The "pass-with-exception" note gate.sh writes to both the console line and gate-result.json. */
export function formatApprovedNote(exception: GateException): string {
  const pr = exception.pr !== undefined ? `, PR #${exception.pr}` : "";
  return (
    `pass-with-exception — approved by ${exception.approver} on ${exception.date} ` +
    `(ticket ${exception.ticket}, gate ${exception.gate}${pr}): ${exception.reason}`
  );
}

// --- CLI: prints one JSON line to stdout for gate.sh to parse. -------------
// Usage: tsx gate-exceptions.ts check --ticket TRO-547 --gate regression-test [--file path]
function main(): void {
  const args = process.argv.slice(2);
  if (args[0] !== "check") {
    console.error("usage: gate-exceptions.ts check --ticket T --gate G [--file path]");
    process.exit(2);
  }
  // A value that starts with "--" is the NEXT flag, not this flag's value —
  // `--ticket --gate regression-test` must fail loudly through the usage
  // path below, never silently read "--gate" as the ticket id.
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const value = args[i + 1];
    return value === undefined || value.startsWith("--") ? undefined : value;
  };
  const ticket = get("ticket");
  const gate = get("gate");
  const path = get("file") ?? "factory/gate-exceptions.json";
  if (!ticket || !gate) {
    console.error("usage: gate-exceptions.ts check --ticket T --gate G [--file path]");
    process.exit(2);
  }
  try {
    const file = loadExceptionsFile(path);
    const outcome = resolveException(ticket, gate, file);
    // The formatted note is computed here, once, from formatApprovedNote —
    // not reconstructed a second time by gate.sh's caller. Two independent
    // templates for the same string is exactly how they drift apart.
    const payload =
      outcome.state === "approved"
        ? { ...outcome, note: formatApprovedNote(outcome.exception) }
        : outcome;
    process.stdout.write(JSON.stringify(payload));
  } catch (cause) {
    // A malformed exceptions file must never crash the gate into an
    // unrelated failure, and must never read as "approved". Report it as an
    // explicit error state; gate.sh's caller treats anything other than
    // "approved" as no exception.
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stdout.write(JSON.stringify({ state: "error", error: message }));
  }
}

if (process.argv[1] && process.argv[1].endsWith("gate-exceptions.ts")) main();
