import { describe, expect, it } from "vitest";
import { HARNESS_POOL_OPTIONS } from "./pool-config";

describe("HARNESS_POOL_OPTIONS (TRO-544 post-merge review finding)", () => {
  it("bounds connection establishment", () => {
    expect(HARNESS_POOL_OPTIONS.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it("bounds established queries too — connectionTimeoutMillis alone never does", () => {
    // Red-first: before this change no query deadline existed anywhere in
    // the harness, so a query that hung after connecting hung forever.
    expect(HARNESS_POOL_OPTIONS.query_timeout).toBeGreaterThan(0);
  });

  it("keeps the query bound at least as generous as the connection bound", () => {
    // A query deadline tighter than the connection deadline would time out
    // legitimate first queries on a slow-starting server.
    expect(HARNESS_POOL_OPTIONS.query_timeout).toBeGreaterThanOrEqual(HARNESS_POOL_OPTIONS.connectionTimeoutMillis);
  });
});
