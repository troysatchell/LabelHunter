import { describe, expect, it } from "vitest";
import { formatTimestampUTC } from "./format-timestamp";

describe("formatTimestampUTC", () => {
  it("formats an ISO string in UTC regardless of the machine's own timezone", () => {
    // A fixed instant, not "now" — this suite must give the same answer no
    // matter which timezone CI or a laptop happens to run in.
    expect(formatTimestampUTC("2026-08-11T14:03:00.000Z")).toBe("Aug 11, 2026, 2:03 PM UTC");
  });

  it("accepts a Date object the same way it accepts an ISO string", () => {
    expect(formatTimestampUTC(new Date("2026-08-11T14:03:00.000Z"))).toBe("Aug 11, 2026, 2:03 PM UTC");
  });

  it("formats midnight UTC without an off-by-one date shift", () => {
    expect(formatTimestampUTC("2026-01-01T00:00:00.000Z")).toBe("Jan 1, 2026, 12:00 AM UTC");
  });
});
