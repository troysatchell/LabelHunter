/**
 * TRO-568: `--url` mode must present the access code TRO-482 now requires.
 *
 * The defect these cover: `measure.ts`'s `--url` fetch carried no `headers`
 * object at all, so every request to a deployed instance returned 401
 * before any stage ran. The harness would have reported the gate's own
 * rejection as a latency measurement.
 */
import { describe, expect, it } from "vitest";
import { ACCESS_CODE_HEADER_NAME, type AccessCodeEnv, buildAccessCodeHeaders, MissingAccessCodeError } from "./access-code";

describe("buildAccessCodeHeaders (TRO-568)", () => {
  it("sends the code as the x-access-code header", () => {
    const headers = buildAccessCodeHeaders({ ACCESS_CODE: "3d30e2b1" } satisfies AccessCodeEnv);
    expect(headers[ACCESS_CODE_HEADER_NAME]).toBe("3d30e2b1");
  });

  it("uses the exact header name the server reads", () => {
    // `src/server/auth/access-code.ts` reads this literal name. A rename on
    // either side that is not mirrored here fails every deployed run with a
    // 401 that looks like a wrong code rather than a wrong header.
    expect(ACCESS_CODE_HEADER_NAME).toBe("x-access-code");
  });

  it("throws a named error when ACCESS_CODE is unset, rather than sending nothing", () => {
    // The whole point: fail before the first request. Sending 50
    // unauthenticated requests reports 50 identical 401s, which reads as a
    // broken deployment, and spends the target's per-IP rate-limit budget.
    expect(() => buildAccessCodeHeaders({} satisfies AccessCodeEnv)).toThrow(MissingAccessCodeError);
  });

  it("names the variable in the error, so the operator knows what to set", () => {
    expect(() => buildAccessCodeHeaders({} satisfies AccessCodeEnv)).toThrow(/ACCESS_CODE/);
  });

  it("treats an empty or whitespace-only value as absent", () => {
    // A variable set to "" or "   " is a configuration mistake, not a
    // credential. Letting it through produces the same 401 storm as sending
    // no header at all, but with a more confusing cause.
    for (const value of ["", "   ", "\t\n"]) {
      expect(() => buildAccessCodeHeaders({ ACCESS_CODE: value } satisfies AccessCodeEnv)).toThrow(MissingAccessCodeError);
    }
  });

  it("trims surrounding whitespace off a real value", () => {
    // A code pasted out of a dashboard often carries a trailing newline.
    // Sending it verbatim fails the server's constant-time comparison and
    // is indistinguishable from a wrong code.
    const headers = buildAccessCodeHeaders({ ACCESS_CODE: "  abc123\n" } satisfies AccessCodeEnv);
    expect(headers[ACCESS_CODE_HEADER_NAME]).toBe("abc123");
  });
});
