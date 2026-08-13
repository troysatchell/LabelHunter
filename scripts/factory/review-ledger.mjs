#!/usr/bin/env node
// Review-findings ledger: record every reviewer finding, then look for the
// classes that keep coming back.
//
// WHY THIS EXISTS
//
// A factory learns from gate failures via its lessons file. Left alone, it does
// NOT learn from *review* findings: each one is triaged, fixed, and thrown
// away, so a defect class can recur on four different branches without anyone
// noticing it is the same defect four times. That is exactly what happened on
// day one of the reference factory's real operation — six separate findings
// about the same cast pattern, across four branches, each fixed in isolation.
//
// Aggregation is the whole point. A single finding is feedback; the same
// finding on two tickets is a missing brief rule; on three or more it is a
// missing mechanical gate check. (Thresholds also in factory/config.yaml
// under operation.recurrenceLadder.)
//
// Usage:
//   review-ledger.mjs record --ticket ABC-123 --pr 12 --source cli|pr|github|self \
//     --severity critical|major|minor|trivial|nitpick \
//     --category <kebab-slug> --file <path> \
//     --disposition fixed|dismissed|new-ticket \
//     --summary "one line" [--ts YYYY-MM-DD]
//
//   review-ledger.mjs report            # group by category, flag recurrence
//   review-ledger.mjs report --since 2026-07-29
//
// The ledger is append-only JSONL (default factory/review-findings.jsonl,
// override with --ledger). Categories are free-form kebab slugs, deliberately:
// an enum would need editing before an unfamiliar class could be recorded, and
// the friction would push people toward the nearest wrong bucket. BUT converge
// on one slug per defect family — on the reference factory the same defect
// filed under four different slugs hid the largest recurring class for six
// tickets. When in doubt, reuse the closest existing slug.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, required = false) {
  const i = argv.indexOf(`--${name}`);
  const v = i === -1 ? null : argv[i + 1];
  if (required && !v) {
    console.error(`review-ledger: --${name} is required`);
    process.exit(2);
  }
  return v;
}

const LEDGER = flag('ledger') ?? 'factory/review-findings.jsonl';

function load() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        console.error(`review-ledger: skipping malformed line ${i + 1}`);
        return null;
      }
    })
    .filter(Boolean);
}

if (cmd === 'record') {
  const row = {
    ticket: flag('ticket', true),
    pr: flag('pr'),
    source: flag('source') ?? 'unknown',
    severity: (flag('severity') ?? 'unknown').toLowerCase(),
    category: flag('category', true),
    file: flag('file') ?? null,
    disposition: flag('disposition') ?? 'fixed',
    summary: flag('summary', true).trim(),
    ts: flag('ts') ?? null,
  };
  if (!row.summary) {
    console.error('review-ledger: --summary must not be blank');
    process.exit(2);
  }
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, JSON.stringify(row) + '\n');
  console.error(`review-ledger: recorded ${row.category} (${row.severity}) for ${row.ticket}`);
  process.exit(0);
}

if (cmd !== 'report') {
  console.error('usage: review-ledger.mjs record --ticket … --category … | report [--since YYYY-MM-DD]');
  process.exit(2);
}

const since = flag('since');
let rows = load();
if (since) rows = rows.filter((r) => (r.ts ?? '') >= since);

if (!rows.length) {
  console.log('review-ledger: no findings recorded');
  process.exit(0);
}

const SEV_RANK = { critical: 0, major: 1, minor: 2, trivial: 3, nitpick: 4, unknown: 5 };

const byCategory = new Map();
for (const r of rows) {
  if (!byCategory.has(r.category)) byCategory.set(r.category, []);
  byCategory.get(r.category).push(r);
}

// Rank by how much a category is costing us: distinct tickets first (a class
// that recurs across tickets is systemic, not a one-off), then worst severity,
// then raw count.
const ranked = [...byCategory.entries()]
  .map(([cat, list]) => {
    const tickets = new Set(list.map((r) => r.ticket));
    const worst = Math.min(...list.map((r) => SEV_RANK[r.severity] ?? 5));
    return { cat, list, tickets, worst };
  })
  .sort((a, b) => b.tickets.size - a.tickets.size || a.worst - b.worst || b.list.length - a.list.length);

const sevName = (n) => Object.keys(SEV_RANK).find((k) => SEV_RANK[k] === n) ?? 'unknown';

console.log(`\nReview findings: ${rows.length} across ${new Set(rows.map((r) => r.ticket)).size} ticket(s)\n`);
console.log('  n  tickets  worst     category                        action');
console.log('  -  -------  --------  ------------------------------  ------------------------------');

for (const { cat, list, tickets, worst } of ranked) {
  // The thresholds are the whole editorial claim of this tool:
  //   1 ticket  -> feedback, fix it and move on
  //   2 tickets -> a rule is missing from the agent brief
  //   3+        -> a prompt rule is not enough; it needs a mechanical check
  let action;
  if (tickets.size >= 3) action = 'GATE CHECK — prompts insufficient';
  else if (tickets.size === 2) action = 'ADD BRIEF RULE (lessons file)';
  else action = 'one-off';

  console.log(
    `  ${String(list.length).padStart(1)}  ${String(tickets.size).padStart(7)}  ` +
      `${sevName(worst).padEnd(8)}  ${cat.padEnd(30)}  ${action}`
  );
}

const systemic = ranked.filter((r) => r.tickets.size >= 2);
if (systemic.length) {
  console.log(`\nRecurring classes (${systemic.length}) — these are the self-improvement backlog:\n`);
  for (const { cat, list, tickets } of systemic) {
    console.log(`  ${cat}  (${list.length} findings, ${tickets.size} tickets: ${[...tickets].join(', ')})`);
    for (const r of list) {
      const f = r.file ? ` ${r.file}` : '';
      console.log(`    - [${r.severity}] ${r.ticket}${f} — ${r.summary}`);
    }
    console.log('');
  }
}

const dismissed = rows.filter((r) => r.disposition === 'dismissed');
if (dismissed.length) {
  console.log(`Dismissed (${dismissed.length}) — check these are not a pattern of ignoring real feedback:`);
  for (const r of dismissed) console.log(`  - ${r.ticket} ${r.category}: ${r.summary}`);
  console.log('');
}
