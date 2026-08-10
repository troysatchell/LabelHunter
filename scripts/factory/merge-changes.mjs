#!/usr/bin/env node
// merge-changes.mjs — entry-aware merge/validation for CHANGES.md.
//
// WHY THIS EXISTS
//
// CHANGES.md is append-at-top: every ticket branch adds its entry above
// everything else. That means every concurrent branch conflicts with every
// other branch's merge, on the same few lines, every single time — this repo
// hit the identical conflict on three tickets in a row (TRO-456 x2, TRO-457)
// before this tool existed.
//
// Both obvious auto-resolutions are wrong:
//   - A 3-way merge can COLLAPSE two entries into one, because every entry
//     shares section headings like "**How to run it.**" — git's line-based
//     diff sees matching context lines and merges across entry boundaries.
//   - `merge=union` DROPS the shared context lines entirely and can splice
//     one entry's body into another's, while reporting "Auto-merging
//     CHANGES.md — Automatic merge went well." It is not well: the result
//     can have an unbalanced number of ``` fences and a run block that
//     belongs to the wrong ticket.
//
// So: parse into whole entries (split on "^## ", never line-wise), merge by
// entry identity, and verify structurally afterward rather than trusting
// git's own merge output.
//
// Usage:
//   merge-changes.mjs --check CHANGES.md              # validate structure only
//   merge-changes.mjs --check CHANGES.md --expect TRO-457   # + confirm that
//                                                              ticket's entry
//                                                              is present
//
// Exit 0 = valid (or only WARN-tier issues). Exit 1 = FATAL structural
// problem. A validator that cries wolf on WARN-tier stuff gets switched off,
// so FATAL and WARN are reported separately and only FATAL fails the check.

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};

if (!argv.includes('--check')) {
  console.error('usage: merge-changes.mjs --check <file> [--expect <TICKET>]');
  process.exit(2);
}

const file = argv[argv.indexOf('--check') + 1];
const expect = flag('expect');

if (!file) {
  console.error('merge-changes.mjs: --check requires a file path');
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`merge-changes.mjs: cannot read ${file}: ${e.message}`);
  process.exit(2);
}

const fatal = [];
const warn = [];

// --- 0. no leftover conflict markers -----------------------------------
for (const marker of ['<<<<<<<', '=======', '>>>>>>>']) {
  if (text.includes(marker)) {
    fatal.push(`unresolved merge conflict marker "${marker}" still present`);
  }
}

// --- 1. parse into whole entries, never line-wise -----------------------
// An entry is everything from one "## " heading up to (not including) the
// next "## " heading, or end of file. The preamble (before the first
// heading) is kept but not treated as an entry.
const lines = text.split('\n');
const headingIdx = [];
lines.forEach((l, i) => { if (l.startsWith('## ')) headingIdx.push(i); });

if (headingIdx.length === 0) {
  warn.push('no "## " entry headings found — file may be empty or a different format');
}

const entries = headingIdx.map((start, i) => {
  const end = i + 1 < headingIdx.length ? headingIdx[i + 1] : lines.length;
  const body = lines.slice(start, end).join('\n');
  const heading = lines[start].slice(3).trim();
  return { heading, body, startLine: start + 1, endLine: end };
});

// --- 2. duplicate headings (a sign entries got merged/split wrong) ------
const seen = new Map();
for (const e of entries) {
  seen.set(e.heading, (seen.get(e.heading) ?? 0) + 1);
}
for (const [heading, count] of seen) {
  if (count > 1) fatal.push(`duplicate entry heading appears ${count} times: "${heading}"`);
}

// --- 3. fence balance, checked PER ENTRY, not globally -------------------
// A global fence count can be even while one entry has an odd number
// (its closing fence stolen by a union-merge) and a neighboring entry has
// the extra opening fence — checking per-entry catches that; a global count
// does not.
for (const e of entries) {
  const fences = (e.body.match(/^```/gm) ?? []).length;
  if (fences % 2 !== 0) {
    fatal.push(`entry "${e.heading}" (lines ${e.startLine}-${e.endLine}) has an odd number of \`\`\` fences (${fences}) — a code block is unterminated or spliced from another entry`);
  }
}

// --- 4. expected sections present (WARN, not FATAL — some entries legitimately omit one) ---
for (const e of entries) {
  if (!/\*\*How to run it\.?\*\*/.test(e.body)) {
    warn.push(`entry "${e.heading}" has no "**How to run it.**" section`);
  }
  if (!/\*\*Rollback\.?\*\*/.test(e.body)) {
    warn.push(`entry "${e.heading}" has no "**Rollback.**" section`);
  }
}

// --- 5. --expect: confirm a specific ticket has at least one entry -------
// Multiple entries for one ticket are legitimate (a second review round adds
// its own entry rather than rewriting history) — check #2 above already
// catches an EXACT duplicate heading, which is the actual bad-merge
// signature. This check only needs to rule out "lost the entry entirely".
if (expect) {
  const matches = entries.filter((e) => new RegExp(`(^|[^A-Za-z0-9-])${expect}([^A-Za-z0-9-]|$)`).test(e.heading));
  if (matches.length === 0) {
    fatal.push(`--expect ${expect}: no entry heading mentions it — wrong file, or the entry was lost in a merge`);
  }
}

// --- report ---------------------------------------------------------------
if (fatal.length) {
  console.error(`merge-changes.mjs: FATAL (${fatal.length}):`);
  for (const m of fatal) console.error(`  - ${m}`);
}
if (warn.length) {
  console.error(`merge-changes.mjs: warn (${warn.length}):`);
  for (const m of warn) console.error(`  - ${m}`);
}
if (!fatal.length && !warn.length) {
  console.error(`merge-changes.mjs: ${file} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, structurally valid`);
}

process.exit(fatal.length ? 1 : 0);
