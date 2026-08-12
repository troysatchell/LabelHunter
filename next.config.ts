import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options land here as later tickets need them */

  // Next.js 16 defaults to true and rewrites CLAUDE.md with its own
  // agent-rules block on every `next dev`/`next build` — found by TRO-466.
  // This repo's CLAUDE.md is hand-authored and checked into version
  // control; disable the feature rather than reverting the file each time.
  agentRules: false,

  // TRO-479: `next build`'s output-file tracing does not follow
  // tesseract.js's own runtime-computed path to its Node worker-thread
  // entry point (`node_modules/tesseract.js/src/worker-script/node/
  // index.js`, resolved at call time by tesseract.js itself, not by a
  // static `require("...")` Next's bundler can see). Found live: the
  // first `pnpm test:e2e` run against a real `next build && next start`
  // instance that uploaded a real photo — every prior check of the
  // warning subsystem (LH-020's own unit suite, `next dev`) either never
  // ran a production build at all or never reached this code path with a
  // real image, so this never surfaced before this ticket's E2E suite ran
  // for real. The failure was severe, not cosmetic: the worker thread's
  // own `MODULE_NOT_FOUND` surfaced as an `uncaughtException` on the
  // whole server process (tesseract.js's Node backend does not route a
  // worker "error" event through the awaited `createWorker(...)` promise
  // `runWarningOcr`'s own try/catch — src/server/warning/ocr.ts — can
  // catch), which killed the process outright — every request after the
  // first real one failed too, not just the one that triggered it.
  // `serverExternalPackages` is Next's documented fix for exactly this
  // class of problem: it tells the bundler to leave the named package as
  // a plain `require()` at runtime, resolved by Node's own module
  // resolution instead of Next's static trace
  // (https://nextjs.org/docs/app/api-reference/next-config-js/serverExternalPackages).
  serverExternalPackages: ["tesseract.js"],
};

export default nextConfig;
