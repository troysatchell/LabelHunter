#!/usr/bin/env node
/**
 * testdiff — compare a test run against the quarantine baseline by failure IDENTITY.
 *
 * Portable across any runner that can emit a report with per-test results. Adapters below
 * cover vitest/jest (testResults[].assertionResults[]), pytest-json-report (tests[]), and
 * `go test -json` (line-delimited events). Add one rather than reshaping the runner's output.
 *
 * WHY IDENTITIES AND NOT COUNTS: an agent that breaks one test while fixing another leaves the
 * totals identical. A count-based check waves it through. This is the single most important
 * property of the gate, and it is worth negative-testing before trusting it — see
 * references/verification.md.
 *
 * Exit 0 = no new failures. Exit 1 = regression. Exit 2 = could not evaluate.
 */

import { readFileSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1]
}

const suite = arg('suite', 'default')
const currentPath = arg('current')
const baselinePath = arg('baseline')
const repoRoot = arg('repo-root', process.cwd())

if (!currentPath || !baselinePath) {
  console.error('usage: testdiff.mjs --suite <name> --current <run.json> --baseline <quarantine.json>')
  process.exit(2)
}

const readJson = (p, what) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) }
  catch (e) { console.error(`testdiff: cannot read ${what} at ${p}: ${e.message}`); process.exit(2) }
}

const rel = (f) => (isAbsolute(f) ? relative(repoRoot, f) : f)

/** Each adapter returns a Set of "<repo-relative file>::<full test name>". */
const adapters = {
  // vitest / jest
  jsJson(r) {
    const out = new Set()
    for (const s of r.testResults ?? []) {
      const file = rel(s.name ?? s.testFilePath ?? '<unknown>')
      const asserts = s.assertionResults ?? []
      // A whole-file failure (import error, collection crash) has no per-test results.
      // The file itself becomes the identity, or the failure would vanish from the diff.
      if (!asserts.length && s.status === 'failed') { out.add(`${file}::<file-level failure>`); continue }
      for (const a of asserts) {
        if (a.status === 'failed') {
          out.add(`${file}::${a.fullName || [...(a.ancestorTitles ?? []), a.title].join(' > ')}`)
        }
      }
    }
    return out
  },
  // pytest --json-report
  pytest(r) {
    const out = new Set()
    for (const t of r.tests ?? []) {
      if (t.outcome === 'failed' || t.outcome === 'error') {
        const [file, ...rest] = String(t.nodeid).split('::')
        out.add(`${rel(file)}::${rest.join('::')}`)
      }
    }
    return out
  },
  // go test -json (line-delimited)
  goJson(text) {
    const out = new Set()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let e; try { e = JSON.parse(line) } catch { continue }
      if (e.Action === 'fail' && e.Test) out.add(`${e.Package}::${e.Test}`)
    }
    return out
  },
}

function failureSet(path) {
  // Must be guarded: an uncaught throw here exits 1, which the gate would read as
  // "regression found" rather than "could not evaluate". Those are different, and
  // conflating them turns a missing report into a phantom regression.
  let raw
  try { raw = readFileSync(path, 'utf8') }
  catch (e) { console.error(`testdiff: cannot read current run at ${path}: ${e.message}`); process.exit(2) }
  // go's output is line-delimited, not a single document
  if (raw.trimStart().startsWith('{"Time"') || raw.includes('"Action":')) {
    try { return adapters.goJson(raw) } catch { /* fall through */ }
  }
  const doc = readJson(path, 'current run')
  if (Array.isArray(doc.testResults)) return adapters.jsJson(doc)
  if (Array.isArray(doc.tests)) return adapters.pytest(doc)
  console.error('testdiff: unrecognized report shape — add an adapter rather than reshaping output')
  process.exit(2)
}

const baseline = readJson(baselinePath, 'quarantine baseline')
const known = new Set(baseline?.suites?.[suite]?.knownFailing ?? baseline?.packages?.[suite]?.knownFailing ?? [])
const now = failureSet(currentPath)

// Guard against a misconfigured --repo-root. If it is wrong, every identity is
// keyed on a path that cannot match the baseline, so a perfectly healthy run
// reports its ENTIRE failure list as new. That looks like a catastrophic
// regression and sends you hunting through the diff instead of the config.
if (known.size > 0 && now.size > 0 && ![...now].some((t) => known.has(t))) {
  console.error(
    `testdiff: WARNING — none of the ${now.size} current failure(s) match any of the ` +
    `${known.size} baseline identities. Before treating these as regressions, check that ` +
    `--repo-root (${repoRoot}) and --suite (${suite}) are right: a wrong value makes every ` +
    `identity mismatch.\n  baseline e.g. ${[...known][0]}\n  current  e.g. ${[...now][0]}`
  )
}

const newFailures = [...now].filter((t) => !known.has(t)).sort()
const fixed = [...known].filter((t) => !now.has(t)).sort()
const stillFailing = [...now].filter((t) => known.has(t)).sort()

console.log(JSON.stringify({
  suite,
  verdict: newFailures.length ? 'fail' : 'pass',
  counts: { knownFailing: known.size, currentlyFailing: now.size, newFailures: newFailures.length, fixed: fixed.length },
  newFailures, fixed, stillFailing,
}, null, 2))

if (newFailures.length) {
  console.error(`\ntestdiff: ${newFailures.length} NEW failure(s) in ${suite} not on the baseline:`)
  for (const t of newFailures) console.error(`  - ${t}`)
  process.exit(1)
}

if (fixed.length) {
  console.error(`\ntestdiff: ${fixed.length} previously-quarantined test(s) now pass in ${suite}:`)
  for (const t of fixed) console.error(`  + ${t}`)
  console.error('If this branch fixed them deliberately, remove them from the baseline in this PR.')
}
process.exit(0)
