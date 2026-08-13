import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatApprovedNote,
  loadExceptionsFile,
  parseExceptionsFile,
  resolveException,
  type GateExceptionsFile,
} from "./gate-exceptions";

// TRO-553: G6 (regression-test) fails every docs-only and test-only ticket,
// because its premise — every ticket changes production code — is false for
// those classes. This is the resolver gate.sh consults instead of failing
// outright. See factory/gate-exceptions.json for the two real approved
// records this test's fixtures mirror.

const APPROVED_TICKET = "TRO-547";
const APPROVED_TICKET_2 = "TRO-472";
const GATE_ID = "regression-test";

function fixture(overrides: Partial<GateExceptionsFile["exceptions"][number]> = {}) {
  return {
    version: 1,
    exceptions: [
      {
        ticket: APPROVED_TICKET,
        gate: GATE_ID,
        reason: "test-repair ticket; no red-first case is possible",
        approver: "Troy",
        date: "2026-08-13",
        pr: 50,
        ...overrides,
      },
    ],
  };
}

describe("resolveException", () => {
  it("returns 'none' for a ticket with no matching record — ordinary production tickets", () => {
    const outcome = resolveException("TRO-999", GATE_ID, fixture());
    expect(outcome).toEqual({ state: "none" });
  });

  it("returns 'none' when the ticket matches but the gate id does not", () => {
    const outcome = resolveException(APPROVED_TICKET, "typecheck", fixture());
    expect(outcome).toEqual({ state: "none" });
  });

  it("returns 'approved' when ticket, gate, and a non-empty approver all match", () => {
    const outcome = resolveException(APPROVED_TICKET, GATE_ID, fixture());
    expect(outcome.state).toBe("approved");
    if (outcome.state === "approved") {
      expect(outcome.exception.approver).toBe("Troy");
      expect(outcome.exception.date).toBe("2026-08-13");
    }
  });

  it("returns 'unapproved' — never 'approved' — when the approver field is an empty string", () => {
    const outcome = resolveException(APPROVED_TICKET, GATE_ID, fixture({ approver: "" }));
    expect(outcome.state).toBe("unapproved");
  });

  it("returns 'unapproved' when the approver field is only whitespace", () => {
    const outcome = resolveException(APPROVED_TICKET, GATE_ID, fixture({ approver: "   " }));
    expect(outcome.state).toBe("unapproved");
  });

  it("never lets an agent self-approve by omitting the approver field entirely", () => {
    const file: GateExceptionsFile = {
      version: 1,
      exceptions: [
        { ticket: APPROVED_TICKET, gate: GATE_ID, reason: "r" } as GateExceptionsFile["exceptions"][number],
      ],
    };
    const outcome = resolveException(APPROVED_TICKET, GATE_ID, file);
    expect(outcome.state).not.toBe("approved");
  });
});

describe("formatApprovedNote", () => {
  // Pinned exact output: gate.sh's G6 block reads this string verbatim (both
  // the console line and gate-result.json's detail field), so a silent
  // format drift here is a silent drift in what the gate reports.
  it("names the approver, date, ticket, gate, PR, and reason", () => {
    const note = formatApprovedNote({
      ticket: APPROVED_TICKET,
      gate: GATE_ID,
      reason: "no red-first case possible",
      approver: "Troy",
      date: "2026-08-13",
      pr: 50,
    });
    expect(note).toBe(
      "pass-with-exception — approved by Troy on 2026-08-13 " +
        "(ticket TRO-547, gate regression-test, PR #50): no red-first case possible",
    );
  });

  it("omits the PR clause when pr is not set", () => {
    const note = formatApprovedNote({
      ticket: "TRO-1",
      gate: GATE_ID,
      reason: "r",
      approver: "Troy",
      date: "2026-08-01",
    });
    expect(note).toBe(
      "pass-with-exception — approved by Troy on 2026-08-01 (ticket TRO-1, gate regression-test): r",
    );
  });
});

describe("parseExceptionsFile", () => {
  it("throws on a document missing the exceptions array", () => {
    expect(() => parseExceptionsFile(JSON.stringify({ version: 1 }))).toThrow();
  });

  it("ignores a leading $comment field alongside a valid exceptions array", () => {
    const doc = parseExceptionsFile(
      JSON.stringify({ $comment: ["note"], version: 1, exceptions: [] }),
    );
    expect(doc.exceptions).toEqual([]);
  });
});

describe("loadExceptionsFile", () => {
  it("returns an empty exceptions list when the file does not exist", () => {
    const doc = loadExceptionsFile("/nonexistent/path/gate-exceptions.json");
    expect(doc.exceptions).toEqual([]);
  });
});

describe("the real committed factory/gate-exceptions.json", () => {
  const REPO_ROOT = join(__dirname, "..", "..");
  const REAL_PATH = join(REPO_ROOT, "factory", "gate-exceptions.json");

  it("exists and parses", () => {
    expect(existsSync(REAL_PATH)).toBe(true);
    const doc = parseExceptionsFile(readFileSync(REAL_PATH, "utf8"));
    expect(doc.exceptions.length).toBeGreaterThanOrEqual(2);
  });

  it("approves TRO-547 (test-only, PR #50) for regression-test, with a named approver", () => {
    const doc = parseExceptionsFile(readFileSync(REAL_PATH, "utf8"));
    const outcome = resolveException(APPROVED_TICKET, GATE_ID, doc);
    expect(outcome.state).toBe("approved");
    if (outcome.state === "approved") {
      expect(outcome.exception.approver.length).toBeGreaterThan(0);
      expect(outcome.exception.pr).toBe(50);
    }
  });

  it("approves TRO-472 (docs-only, CP-3 walkthrough) for regression-test, with a named approver", () => {
    const doc = parseExceptionsFile(readFileSync(REAL_PATH, "utf8"));
    const outcome = resolveException(APPROVED_TICKET_2, GATE_ID, doc);
    expect(outcome.state).toBe("approved");
    if (outcome.state === "approved") {
      expect(outcome.exception.approver.length).toBeGreaterThan(0);
    }
  });

  it("does not exempt a ticket the file never names — proves the mechanism cannot self-approve", () => {
    const doc = parseExceptionsFile(readFileSync(REAL_PATH, "utf8"));
    const outcome = resolveException("TRO-553", GATE_ID, doc);
    expect(outcome.state).toBe("none");
  });
});
