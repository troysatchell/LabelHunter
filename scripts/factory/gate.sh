#!/usr/bin/env bash
#
# gate.sh — the factory's cheap-tier eval. Run inside a ticket worktree.
#
# This is the objective "is this ticket done" check. An agent's self-report is a
# claim; this script is the result. Every gate passes or fails on evidence, and
# the JSON it writes becomes the PR body's evidence block.
#
# It does NOT measure improvement: eval-harness accuracy deltas, latency vs the
# 5s budget (TH-R2), and the cascade benchmark are Tier 2 — see the
# labelhunter-factory skill.
#
# Usage:
#   scripts/factory/gate.sh                 # full gate
#   scripts/factory/gate.sh --fast          # skip build + review capture (inner loop)
#   scripts/factory/gate.sh --skip-review   # skip review capture only
#
set -uo pipefail

FAST=0
SKIP_REVIEW=0
for a in "$@"; do
  case "$a" in
    --fast) FAST=1; SKIP_REVIEW=1 ;;
    --skip-review) SKIP_REVIEW=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

WT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERROR: not inside a git repository." >&2; exit 2; }
cd "$WT_ROOT" || { echo "ERROR: cannot cd to ${WT_ROOT}" >&2; exit 2; }

# Pre-scaffold guard: the gate is meaningless (and UNVERIFIED) until the
# scaffold ticket lands. Refuse loudly rather than emit a vacuous pass.
if [ ! -f package.json ]; then
  echo "ERROR: no package.json — this repo is pre-scaffold." >&2
  echo "       The gate cannot check anything yet. The scaffold ticket's DoD includes" >&2
  echo "       making this gate run AND negative-testing it (factory/config.yaml)." >&2
  exit 2
fi

# .factory-env carries the ticket id and this worktree's EXCLUSIVE database.
# An explicitly-exported FACTORY_BASE_REF must survive the source: `set -a; .`
# would otherwise overwrite the caller's value with the file's, and a stale
# local base ref fails QUIET via merge-base resolution (ship lesson, TRO-226).
BASE_REF_OVERRIDE="${FACTORY_BASE_REF:-}"
if [ -f .factory-env ]; then
  set -a; . ./.factory-env; set +a
fi
if [ -n "$BASE_REF_OVERRIDE" ]; then
  FACTORY_BASE_REF="$BASE_REF_OVERRIDE"
fi
TICKET="${FACTORY_TICKET:-}"
if [ -z "$TICKET" ]; then
  echo "ERROR: no .factory-env / FACTORY_TICKET. Provision with scripts/factory/worktree.sh." >&2
  exit 2
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL unset. Unit tests reset their target database;" >&2
  echo "       refusing to run against an unknown one." >&2
  exit 2
fi
case "${DATABASE_URL}" in
  *labelhunter_wt_*|*labelhunter_ci*) ;;
  *) echo "ERROR: DATABASE_URL does not look like a factory-owned database:" >&2
     echo "       ${DATABASE_URL}" >&2
     echo "       Refusing to run tests against it." >&2
     exit 2 ;;
esac

BASE_REF="${FACTORY_BASE_REF:-main}"
OUT_DIR="${WT_ROOT}/.factory"
mkdir -p "$OUT_DIR"

# The quarantine baseline is materialized from BASE_REF, never read from the
# ticket branch — reading the branch copy would let an agent append its own new
# failures and pass. Legitimately FIXING a quarantined test still works:
# testdiff reports it as "fixed", which is informational.
QUARANTINE="${OUT_DIR}/quarantine-base.json"
if git show "${BASE_REF}:factory/quarantine.json" > "$QUARANTINE" 2>/dev/null; then
  :
elif [ -f "${WT_ROOT}/factory/quarantine.json" ]; then
  cp "${WT_ROOT}/factory/quarantine.json" "$QUARANTINE"
  echo "  note: no quarantine baseline on ${BASE_REF}; using working-tree copy"
else
  echo "ERROR: no quarantine baseline on ${BASE_REF} or in the working tree." >&2
  exit 2
fi

RESULTS=()          # "id|status|detail"
OVERALL=pass

record() {           # record <id> <status> <detail>
  RESULTS+=("$1|$2|$3")
  local icon="ok "
  [ "$2" = fail ] && icon="FAIL"
  [ "$2" = skip ] && icon="skip"
  [ "$2" = warn ] && icon="warn"
  printf '  [%s] %-22s %s\n' "$icon" "$1" "$3"
  [ "$2" = fail ] && OVERALL=fail
  return 0
}

echo "=== factory gate: ${TICKET} (base ${BASE_REF}) ==="
echo

# --- G1: type check ---------------------------------------------------------
if pnpm typecheck > "$OUT_DIR/typecheck.log" 2>&1; then
  record typecheck pass "clean"
else
  N=$(grep -c 'error TS' "$OUT_DIR/typecheck.log" 2>/dev/null) || N='?'
  record typecheck fail "see .factory/typecheck.log (${N} TS errors)"
fi

# --- G2: lint ---------------------------------------------------------------
# A lint script with no config exits 0 while checking nothing. Wire it only
# when a config exists; otherwise say so instead of manufacturing confidence.
#
# `ls a.* b.*` exits nonzero if EITHER glob has no match, even when the other
# matched a real file — so a repo with only eslint.config.mjs (no .eslintrc*)
# always read as "no config found" and lint silently stayed skip forever.
# Found by the TRO-456 scaffold agent. compgen -G tests each pattern on its
# own and never touches argv, so one glob's absence can't hide the other's match.
if compgen -G "eslint.config.*" >/dev/null || compgen -G ".eslintrc*" >/dev/null; then
  if pnpm lint > "$OUT_DIR/lint.log" 2>&1; then
    record lint pass "clean"
  else
    record lint fail "see .factory/lint.log"
  fi
else
  record lint skip "no eslint config found — NOT wired into the gate (scaffold DoD)"
fi

# --- G3: build --------------------------------------------------------------
if [ "$FAST" = 1 ]; then
  record build skip "--fast"
elif pnpm build > "$OUT_DIR/build.log" 2>&1; then
  record build pass "built"
else
  record build fail "see .factory/build.log"
fi

# --- G4: unit tests vs quarantine baseline -----------------------------------
# Failure IDENTITIES, not counts: break-one/fix-one keeps totals equal and
# slips through any count check.
TESTS_JSON="$OUT_DIR/unit-tests.json"
pnpm test -- --reporter=json --outputFile="$TESTS_JSON" > "$OUT_DIR/unit-tests.log" 2>&1
if [ ! -f "$TESTS_JSON" ]; then
  record tests fail "runner produced no report — see .factory/unit-tests.log"
else
  DIFF_OUT="$(node "${WT_ROOT}/scripts/factory/testdiff.mjs" \
      --suite unit --current "$TESTS_JSON" --baseline "$QUARANTINE" \
      --repo-root "$WT_ROOT" 2>&1)"; RC=$?
  echo "$DIFF_OUT" > "$OUT_DIR/unit-testdiff.txt"
  if [ $RC -eq 0 ]; then
    FIXED=$(grep -c '^  +' "$OUT_DIR/unit-testdiff.txt" 2>/dev/null) || FIXED=0
    if [ "${FIXED:-0}" -gt 0 ]; then
      record tests pass "no new failures; ${FIXED} quarantined test(s) now pass — remove from baseline in this PR"
    else
      record tests pass "no new failures vs baseline"
    fi
  else
    # Flake diagnosis: re-run each failing file standalone and report the split.
    # Deliberately NOT auto-passed — "fails in suite, passes alone" is also the
    # signature of a real test-isolation bug (ship's TEST-12 was exactly that).
    FILES="$(node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const out = new Set();
        for (const s of j.testResults || [])
          for (const a of s.assertionResults || [])
            if (a.status === "failed") out.add(s.name);
        process.stdout.write([...out].join("\n"));
      } catch {}
    ' "$TESTS_JSON" 2>/dev/null)"
    SA_PASS=0; SA_TOTAL=0
    if [ -n "$FILES" ]; then
      : > "$OUT_DIR/unit-standalone.txt"
      while IFS= read -r tf; do
        [ -z "$tf" ] && continue
        SA_TOTAL=$((SA_TOTAL + 1))
        if npx vitest run "$tf" > /dev/null 2>&1; then
          SA_PASS=$((SA_PASS + 1)); echo "PASSED standalone: $tf" >> "$OUT_DIR/unit-standalone.txt"
        else
          echo "FAILED standalone: $tf" >> "$OUT_DIR/unit-standalone.txt"
        fi
      done <<< "$FILES"
    fi
    if [ "$SA_TOTAL" -gt 0 ] && [ "$SA_PASS" -eq "$SA_TOTAL" ]; then
      record tests fail "new failure(s), but ALL ${SA_TOTAL} passed standalone — load-sensitive or a test-isolation bug; see .factory/unit-standalone.txt"
    elif [ "$SA_TOTAL" -gt 0 ]; then
      record tests fail "new failure(s) — ${SA_PASS}/${SA_TOTAL} passed standalone; the rest are REAL. See .factory/unit-standalone.txt"
    else
      record tests fail "new failure(s) — see .factory/unit-testdiff.txt"
    fi
  fi
fi

# --- G5: tests were not weakened -------------------------------------------
# NET comparison, learned the hard way: correcting or renaming an assertion
# rewrites the line, so counting removals alone misfires on legitimate work —
# and a false positive that suppresses real work is the worst outcome.
# .skip/.todo stays an unconditional fail: no added assertion offsets a
# disabled test.
WEAKENED=""
DELS=0; ADDS=0
DIFF_TESTS="$(git diff "${BASE_REF}"...HEAD --name-only -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null || true)"
if [ -n "$DIFF_TESTS" ]; then
  SKIPS="$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null \
           | grep -E '^\+' | grep -cE '\.(skip|todo)\(' || true)"
  DELS="$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null \
           | grep -E '^-' | grep -cE '^\-\s*(it|test|expect)\(' || true)"
  ADDS="$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' '*.spec.ts' 2>/dev/null \
           | grep -E '^\+' | grep -cE '^\+\s*(it|test|expect)\(' || true)"
  [ "${SKIPS:-0}" -gt 0 ] && WEAKENED="${WEAKENED}${SKIPS} newly skipped test(s); "
  if [ "${DELS:-0}" -gt "${ADDS:-0}" ]; then
    WEAKENED="${WEAKENED}net loss of test lines (-${DELS} / +${ADDS}); "
  fi
fi
if [ -n "$WEAKENED" ]; then
  record tests:not-weakened fail "${WEAKENED}justify in the PR or revert"
elif [ "${DELS:-0}" -gt 0 ]; then
  record tests:not-weakened pass "-${DELS} / +${ADDS} test line(s) — net gain; reviewer should confirm removals are corrections"
else
  record tests:not-weakened pass "no tests skipped or assertions removed"
fi

# --- G6: regression test present --------------------------------------------
# "A test file was touched" is too weak. Require at least one ADDED case, and
# remember: the case must live where vitest actually executes it — an e2e-only
# spec satisfies this grep while never running (the brief carries this rule).
ADDED_CASES=$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' 2>/dev/null \
              | grep -cE '^\+[[:space:]]*(it|test)(\.[a-z]+)?\(') || ADDED_CASES=0
if [ "${ADDED_CASES:-0}" -gt 0 ]; then
  record regression-test pass "${ADDED_CASES} test case(s) added"
else
  record regression-test fail "no new test case added — every ticket ships a red-first regression test"
fi

# --- G7: CHANGES.md entry ---------------------------------------------------
# Anchored on non-identifier boundaries: unanchored, TRO-24 false-passes on an
# entry written for TRO-244.
if [ ! -f CHANGES.md ]; then
  record changes-entry fail "CHANGES.md missing"
elif grep -qE "(^|[^A-Za-z0-9-])${TICKET}([^A-Za-z0-9-]|\$)" CHANGES.md; then
  # "An entry mentions the ticket" is not "the file is intact" — CHANGES.md is
  # append-at-top, so every concurrent branch's merge conflicts on it, and
  # both obvious auto-resolutions (3-way, union) can splice one entry's body
  # into another's while reporting success. Verify structure too.
  if [ -f scripts/factory/merge-changes.mjs ] \
     && ! node scripts/factory/merge-changes.mjs --check CHANGES.md --expect "${TICKET}" >/dev/null 2>&1; then
    record changes-entry fail "entry for ${TICKET} present but CHANGES.md is structurally invalid — run: node scripts/factory/merge-changes.mjs --check CHANGES.md --expect ${TICKET}"
  else
    record changes-entry pass "entry for ${TICKET} present; structure valid"
  fi
else
  record changes-entry fail "no entry mentioning ${TICKET}"
fi

# --- G8: eval harness not regressed (TH-R17/TH-R19) -------------------------
# Real once ticket LH-EVAL lands a `pnpm eval:check` comparing accuracy against
# the committed baseline. Until then: skip WITH the reason, never a vacuous pass.
if node -e 'const p=require("./package.json"); process.exit(p.scripts && p.scripts["eval:check"] ? 0 : 1)' 2>/dev/null; then
  if pnpm eval:check > "$OUT_DIR/eval-check.log" 2>&1; then
    record eval-not-regressed pass "accuracy >= committed baseline"
  else
    record eval-not-regressed fail "eval harness regressed — see .factory/eval-check.log"
  fi
else
  record eval-not-regressed skip "no eval:check script yet (lands with the eval-harness ticket)"
fi

# --- G9: scope discipline ---------------------------------------------------
CHANGED_FILES="$(git diff "${BASE_REF}"...HEAD --name-only 2>/dev/null | wc -l | tr -d ' ')"
if [ "${CHANGED_FILES:-0}" -eq 0 ]; then
  record scope fail "branch has no changes vs ${BASE_REF}"
elif [ "${CHANGED_FILES:-0}" -gt 40 ]; then
  record scope warn "${CHANGED_FILES} files changed — unusually broad for one ticket"
else
  record scope pass "${CHANGED_FILES} file(s) changed"
fi

# --- G10: review capture (advisory — pass/warn/skip only, NEVER fail) --------
if [ "$SKIP_REVIEW" = 1 ]; then
  record review skip "disabled for this run"
elif ! command -v coderabbit >/dev/null 2>&1; then
  record review skip "CLI not installed — PR-level review is the authoritative channel"
else
  # Ship lessons baked in: timeout (the CLI hangs under concurrent load), and
  # capture to a temp file so an error stub never destroys completed findings.
  CR_TIMEOUT="${CR_TIMEOUT:-360}"
  if command -v timeout >/dev/null 2>&1; then CR_RUNNER=(timeout --foreground -k 10 "${CR_TIMEOUT}")
  elif command -v gtimeout >/dev/null 2>&1; then CR_RUNNER=(gtimeout --foreground -k 10 "${CR_TIMEOUT}")
  else CR_RUNNER=(); fi
  CR_TMP="$OUT_DIR/coderabbit.next.json"; : > "$CR_TMP"
  if [ ${#CR_RUNNER[@]} -eq 0 ]; then
    coderabbit review --agent --base "${BASE_REF}" > "$CR_TMP" 2>"$OUT_DIR/coderabbit.err"; CR_RC=$?
  else
    "${CR_RUNNER[@]}" coderabbit review --agent --base "${BASE_REF}" > "$CR_TMP" 2>"$OUT_DIR/coderabbit.err"; CR_RC=$?
  fi
  cr_findings() { grep -c '"type"[[:space:]]*:[[:space:]]*"finding"' "$1" 2>/dev/null || true; }
  CR_NEW_N="$(cr_findings "$CR_TMP")"; CR_NEW_N="${CR_NEW_N:-0}"
  CR_OLD_N=0
  [ -f "$OUT_DIR/coderabbit.json" ] && { CR_OLD_N="$(cr_findings "$OUT_DIR/coderabbit.json")"; CR_OLD_N="${CR_OLD_N:-0}"; }
  if [ "$CR_RC" -eq 0 ] && [ "$CR_NEW_N" -gt 0 ]; then
    mv "$CR_TMP" "$OUT_DIR/coderabbit.json"
    record review pass "${CR_NEW_N} finding(s) captured — triage required"
  elif [ "$CR_OLD_N" -gt 0 ]; then
    rm -f "$CR_TMP"
    record review warn "run incomplete (rc=${CR_RC}) — KEPT ${CR_OLD_N} finding(s) from an earlier run"
  else
    mv "$CR_TMP" "$OUT_DIR/coderabbit.json"
    if [ "$CR_RC" -eq 0 ]; then record review pass "review completed with no findings"
    else record review warn "review did not complete (rc=${CR_RC}) — see .factory/coderabbit.err"; fi
  fi
fi

# --- verdict ----------------------------------------------------------------
echo
echo "=== ${TICKET}: ${OVERALL} ==="

{
  echo '{'
  echo "  \"ticket\": \"${TICKET}\","
  echo "  \"branch\": \"$(git branch --show-current)\","
  echo "  \"headSha\": \"$(git rev-parse HEAD)\","
  echo "  \"baseRef\": \"${BASE_REF}\","
  echo "  \"baseSha\": \"$(git rev-parse "${BASE_REF}" 2>/dev/null || echo unknown)\","
  echo "  \"ranAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"verdict\": \"${OVERALL}\","
  echo '  "gates": ['
  for i in "${!RESULTS[@]}"; do
    IFS='|' read -r id st detail <<< "${RESULTS[$i]}"
    sep=','; [ "$i" -eq $(( ${#RESULTS[@]} - 1 )) ] && sep=''
    echo "    {\"id\": \"${id}\", \"status\": \"${st}\", \"detail\": \"${detail//\"/\\\"}\"}${sep}"
  done
  echo '  ]'
  echo '}'
} > "$OUT_DIR/gate-result.json"

echo "evidence: .factory/gate-result.json"
[ "$OVERALL" = pass ] && exit 0 || exit 1
