import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options land here as later tickets need them */

  // Next.js 16 defaults to true and rewrites CLAUDE.md with its own
  // agent-rules block on every `next dev`/`next build` — found by TRO-466.
  // This repo's CLAUDE.md is hand-authored and checked into version
  // control; disable the feature rather than reverting the file each time.
  agentRules: false,
};

export default nextConfig;
