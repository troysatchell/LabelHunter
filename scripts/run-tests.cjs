#!/usr/bin/env node
"use strict";

// pnpm forwards a literal "--" when a script is invoked as
// `pnpm test -- --foo=bar` (npm strips it; pnpm does not — this is a known
// pnpm/npm divergence). Vitest's CLI parser treats a leading "--" as "the
// rest of argv is a positional test-name-pattern filter", so flags placed
// after it — like --reporter and --outputFile — are silently ignored and no
// report file is written, even though the run itself appears to succeed.
//
// A caller may invoke exactly
// `pnpm test -- --reporter=json --outputFile=<path>`, so the fix lives
// here: strip one leading "--" before handing argv to vitest.
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
if (args[0] === "--") {
  args.shift();
}

const vitestBin = path.join(__dirname, "..", "node_modules", ".bin", "vitest");
const result = spawnSync(vitestBin, ["run", ...args], { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
