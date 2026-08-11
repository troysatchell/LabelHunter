import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // NOTE: the gate invokes `pnpm test -- --reporter=json --outputFile=<abs path>`.
    // Vitest resolves a relative --outputFile against this config's root (the repo
    // root, since this file lives there) — the gate always passes an absolute path,
    // so that resolution rule doesn't matter in practice, but keep root implicit
    // (no `root:` override below) so it stays true if that ever changes.
  },
});
