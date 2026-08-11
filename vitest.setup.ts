/**
 * Global vitest setup (TRO-465). Registers `@testing-library/jest-dom`'s
 * matchers (e.g. `toBeInTheDocument`) on `expect` for every test file, not
 * just component tests — a no-op for the server-side `*.test.ts` files that
 * never render DOM, so it is safe to load unconditionally.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// `vitest.config.ts` does not set `test.globals: true` — every component
// test imports `afterEach` from "vitest" explicitly, matching this repo's
// convention. `@testing-library/react`'s own auto-cleanup only registers
// against a GLOBAL `afterEach`, so without this it never runs, and a
// second `render()` in the same file leaves the first render's DOM behind
// (which is exactly what produced duplicate-element `getByRole` failures
// the first time this suite ran). Guarded on `document` so the many
// `environment: "node"` server-side test files — this setup file loads for
// every one of them — never touch a DOM that does not exist there.
afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
