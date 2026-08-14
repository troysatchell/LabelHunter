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
#   scripts/factory/gate.sh                 # full gate, --review=carry (default)
#   scripts/factory/gate.sh --fast          # skip build + review capture (inner loop)
#   scripts/factory/gate.sh --skip-review   # skip review capture only (same as --review=off)
#   scripts/factory/gate.sh --review=off    # never invoke CodeRabbit this run
#   scripts/factory/gate.sh --review=carry  # default (TRO-548): skip a re-review when the
#                                            # diff since the last real capture only touches
#                                            # CHANGES.md, factory/*.jsonl, or comment-only
#                                            # hunks; scope CodeRabbit to what changed since
#                                            # then otherwise. The FIRST review a branch gets
#                                            # is always full, in every mode but --review=off.
#   scripts/factory/gate.sh --review=full   # always a genuine whole-branch review
#
set -uo pipefail

# CodeRabbit finding (this ticket's own first full review, round 1): the
# original single-pass loop let --fast (implies --review=off) and an
# explicit --review=X silently override one another based on ARGUMENT
# ORDER — `--review=full --fast` and `--fast --review=full` disagreed on
# the resulting mode, with nothing to say so. Parsed in two passes now:
# collect every flag first, THEN resolve — order no longer matters, and a
# genuine conflict (--fast/--skip-review alongside an explicit
# --review=<anything but off>) is rejected outright instead of guessed at.
FAST=0
SKIP_REVIEW_FLAG=0
REVIEW_FLAG=""
for a in "$@"; do
  case "$a" in
    --fast) FAST=1 ;;
    --skip-review) SKIP_REVIEW_FLAG=1 ;;
    --review=off) REVIEW_FLAG="off" ;;
    --review=carry) REVIEW_FLAG="carry" ;;
    --review=full) REVIEW_FLAG="full" ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

IMPLIES_OFF=0
[ "$FAST" = 1 ] && IMPLIES_OFF=1
[ "$SKIP_REVIEW_FLAG" = 1 ] && IMPLIES_OFF=1

if [ "$IMPLIES_OFF" = 1 ] && [ -n "$REVIEW_FLAG" ] && [ "$REVIEW_FLAG" != off ]; then
  echo "ERROR: --fast/--skip-review (implies --review=off) conflicts with --review=${REVIEW_FLAG}." >&2
  echo "       Pass only one: drop --fast/--skip-review, or pass --review=off explicitly." >&2
  exit 2
fi

if [ -n "$REVIEW_FLAG" ]; then
  REVIEW_MODE="$REVIEW_FLAG"
elif [ "$IMPLIES_OFF" = 1 ]; then
  REVIEW_MODE="off"
else
  REVIEW_MODE="carry"
fi

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

# Precondition (full gate only — --fast is the documented dirty-tree-tolerant
# inner loop, exempt it): a clean worktree. Several checks below
# (tests:not-weakened, regression-test, changes-entry, scope) diff
# BASE_REF...HEAD — they are blind to anything not committed. pnpm test/build
# run against the actual filesystem, so an uncommitted change can make the
# cheap tests pass while the diff-based checks silently grade a stale,
# already-committed state: a "pass" that does not describe what HEAD actually
# contains. TRO-460 finished real, correct work and reported done with it
# still uncommitted — this refuses loudly instead of certifying a headSha
# that does not match the tree it was tested on.
if [ "$FAST" != 1 ]; then
  DIRTY="$(git status --porcelain 2>/dev/null)"
  if [ -n "$DIRTY" ]; then
    echo "ERROR: worktree is not clean — uncommitted changes present:" >&2
    echo "$DIRTY" >&2
    echo "       Commit (or discard) before running the full gate. A pass here" >&2
    echo "       would certify headSha=$(git rev-parse HEAD 2>/dev/null) against a" >&2
    echo "       tree that does not match it." >&2
    exit 2
  fi
fi

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

# TRO-553: factory/gate-exceptions.json is likewise materialized from
# BASE_REF, never read from the ticket branch. This is the mechanical half
# of "agents must not be able to self-approve" — the doc comment inside the
# file states the rule, but only reading from BASE_REF actually ENFORCES
# it: a ticket branch that adds its own "approved" entry to its own working
# copy has zero effect on its own G6 check, the same guarantee the
# quarantine baseline gives against self-whitelisting. UNLIKE quarantine,
# there is deliberately no working-tree fallback here — an absent baseline
# reads as zero exceptions (the safe default), never as "trust the branch's
# own copy". A brand-new exception takes effect once the commit that adds
# it has landed on BASE_REF, which means it went through ITS OWN prior
# review, not this ticket's.
GATE_EXCEPTIONS="${OUT_DIR}/gate-exceptions-base.json"
if ! git show "${BASE_REF}:factory/gate-exceptions.json" > "$GATE_EXCEPTIONS" 2>/dev/null; then
  echo '{"version":1,"exceptions":[]}' > "$GATE_EXCEPTIONS"
fi

RESULTS=()          # "id|status|detail"
OVERALL=pass

record() {           # record <id> <status> <detail>
  RESULTS+=("$1|$2|$3")
  local icon="ok "
  [ "$2" = fail ] && icon="FAIL"
  [ "$2" = skip ] && icon="skip"
  [ "$2" = warn ] && icon="warn"
  [ "$2" = pass-with-exception ] && icon="ok*"
  [ "$2" = carried ] && icon="cfwd"
  printf '  [%s] %-22s %s\n' "$icon" "$1" "$3"
  [ "$2" = fail ] && OVERALL=fail
  return 0
}

# TRO-553: the human-approved exception path. Shared by every gate that
# offers one (G6, G8, and any future one) — a SECOND copy of this template
# per call site is exactly the "two independent templates for one string"
# drift finding #9 already caught once in this file; one shared function
# instead. Consults factory/gate-exceptions.json, materialized from
# BASE_REF above (never the ticket branch's own working copy — see that
# block's comment for why). Records "pass-with-exception" and returns 0 if
# an approved record matches; otherwise records <result_id> as "fail" with
# <fallback_detail> (byte-identical to what that gate has always said) and
# returns 1.
check_gate_exception() {   # check_gate_exception <result_id> <gate_id> <fallback_detail>
  local result_id="$1" gate_id="$2" fallback_detail="$3"
  local exc_out exc_state exc_note exc_err
  exc_out="$(pnpm exec tsx scripts/factory/gate-exceptions.ts check \
      --ticket "${TICKET}" --gate "${gate_id}" --file "${GATE_EXCEPTIONS}" \
      2>"$OUT_DIR/gate-exceptions-${gate_id}.err")"
  exc_state="$(node -e '
    try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.state || ""); } catch {}
  ' "${exc_out:-}" 2>/dev/null)"
  if [ "$exc_state" = "approved" ]; then
    exc_note="$(node -e '
      try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.note || ""); } catch {}
    ' "${exc_out:-}" 2>/dev/null)"
    record "$result_id" pass-with-exception "${exc_note:-pass-with-exception (note unavailable — see .factory/gate-exceptions-${gate_id}.err)}"
    return 0
  elif [ "$exc_state" = "error" ]; then
    exc_err="$(node -e '
      try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.error || ""); } catch {}
    ' "${exc_out:-}" 2>/dev/null)"
    record "$result_id" fail "${fallback_detail}, AND factory/gate-exceptions.json could not be read: ${exc_err:-see .factory/gate-exceptions-${gate_id}.err}"
    return 1
  else
    record "$result_id" fail "${fallback_detail}"
    return 1
  fi
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
#
# TRO-553: this premise — every ticket changes production code — is false for
# a docs-only ticket and a test-repair ticket with no red-first case to write.
# Absent an added case, consult factory/gate-exceptions.json (check_gate_exception,
# defined above) before failing. An ordinary production ticket has no matching
# record, so this falls straight to the same fail text G6 has always produced —
# byte for byte unchanged (scripts/factory/gate-exceptions.test.ts proves the
# resolver side; this is the one caller both G6 and G8 share). A record only
# ever helps a ticket; it can never turn a real pass into a failure.
ADDED_CASES=$(git diff "${BASE_REF}"...HEAD -- '*.test.ts' '*.test.tsx' 2>/dev/null \
              | grep -cE '^\+[[:space:]]*(it|test)(\.[a-z]+)?\(') || ADDED_CASES=0
if [ "${ADDED_CASES:-0}" -gt 0 ]; then
  record regression-test pass "${ADDED_CASES} test case(s) added"
else
  check_gate_exception regression-test regression-test \
      "no new test case added — every ticket ships a red-first regression test"
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
#
# TRO-553: the same exception path G6 uses (check_gate_exception, defined
# above) — this is the second call site, proving the mechanism is generic
# over the gate id rather than hardcoded to G6. TRO-542 is the live instance
# (factory/gate-exceptions.json): the committed accuracy baseline sits at
# the top of TRO-543's measured variance band, so an honest run of unchanged
# code can fail this comparison on variance alone.
if node -e 'const p=require("./package.json"); process.exit(p.scripts && p.scripts["eval:check"] ? 0 : 1)' 2>/dev/null; then
  if pnpm eval:check > "$OUT_DIR/eval-check.log" 2>&1; then
    record eval-not-regressed pass "accuracy >= committed baseline"
  else
    check_gate_exception eval-not-regressed eval-not-regressed \
        "eval harness regressed — see .factory/eval-check.log"
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

# --- G11: defect gate (BLOCKING) --------------------------------------------
# Runs BEFORE G10 so a defect this factory can catch never consumes external
# review budget. Fails only on violations this branch introduced, measured
# against BASE_REF by content identity — the same discipline the quarantine
# baseline uses.
if [ "$FAST" = 1 ]; then
  record defect-gate skip "skipped in --fast"
elif [ ! -d scripts/factory/defect-gates ]; then
  record defect-gate skip "not installed"
else
  DG_LOG="$OUT_DIR/defect-gate.log"
  DG_JSON="$OUT_DIR/defect-gate.json"
  FACTORY_BASE_REF="${BASE_REF}" pnpm exec tsx scripts/factory/defect-gates/run.ts > "$DG_LOG" 2>&1
  DG_EXIT=$?
  # Read the real per-rule counts from defect-gate.json instead of grepping the
  # log for "FAIL" — a report-only rule's introduced findings print as
  # "report", never "FAIL", so a FAIL-only grep is blind to them. That blindness
  # is exactly what let the old code hardcode "no introduced violations" on
  # every pass, even a pass hiding real report-only findings. Three real
  # outcomes, told apart honestly: a clean pass, a pass that still carries
  # report-only findings (name the count and the pin), and a blocking failure
  # (name the count). A rule that errored is named too — an error must never
  # read as zero violations.
  DG_SUMMARY="$(node -e '
    const fs = require("fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const errored = [];
    let blockingN = 0;
    let reportOnlyN = 0;
    const reportNotes = [];
    for (const r of doc.rules) {
      if (r.status === "error") { errored.push(r.id + ": " + r.error); continue; }
      if (r.mode === "blocking") { blockingN += r.introduced.length; continue; }
      if (r.introduced.length > 0) {
        reportOnlyN += r.introduced.length;
        reportNotes.push(r.id + " (report-only, pinned before activation " + r.pin.activatedAt + ")");
      }
    }
    if (errored.length > 0) {
      process.stdout.write(errored.length + " rule(s) errored — " + errored.join("; "));
    } else if (blockingN > 0) {
      process.stdout.write(blockingN + " introduced violation(s) — see .factory/defect-gate.json");
    } else if (reportOnlyN > 0) {
      process.stdout.write(
        "no BLOCKING violations — " + reportOnlyN +
        " introduced violation(s) under report-only rule(s): " + reportNotes.join(", "),
      );
    } else {
      process.stdout.write("no introduced violations");
    }
  ' "$DG_JSON" 2>/dev/null)"
  if [ "$DG_EXIT" -eq 0 ]; then
    record defect-gate pass "${DG_SUMMARY:-no introduced violations}"
  else
    record defect-gate fail "${DG_SUMMARY:-defect-gate run failed — see .factory/defect-gate.log}"
  fi
fi

# --- G10: review capture (advisory — pass/warn/skip/carried only, NEVER fail) -
# TRO-560: the capture, retry, and stale-vs-fresh decision live in
# scripts/factory/review-capture.ts (unit-tested) — this block only invokes
# it and records what it reports. Two defects that block fixed there: (1) an
# rc!=0 fallback to a previous run's findings now names the SHA it was
# captured at and says plainly when the current diff has NOT been reviewed,
# instead of reading like a fresh pass; (2) the failed attempt's full
# stdout/stderr/exit code is always kept in .factory/coderabbit-capture.json
# — the CLI reports its error as a JSON line on STDOUT, not stderr, so the
# old code's ".factory/coderabbit.err" pointer was reliably empty on exactly
# the run it mattered most for (TRO-508, 2026-08-13 comment).
#
# TRO-548: --review={off,carry,full} (REVIEW_MODE, parsed above) controls
# how much gets reviewed. The default "carry" is the mechanical form of
# lessons rule 31: a re-run inside one orchestrator pass carries the
# previous review forward — no coderabbit invocation at all — when the
# diff since the last real capture only touches CHANGES.md,
# factory/*.jsonl, or comment-only hunks, and scopes CodeRabbit's own diff
# to `--base-commit <that sha>` otherwise, instead of the whole branch
# every time. The mode itself is passed straight through; review-capture.ts
# owns the decision so it stays unit-tested rather than re-implemented here.
if [ "$REVIEW_MODE" = off ]; then
  record review skip "disabled for this run (--review=off)"
elif ! command -v coderabbit >/dev/null 2>&1; then
  record review skip "CLI not installed — PR-level review is the authoritative channel"
else
  CR_JSON="$(pnpm exec tsx scripts/factory/review-capture.ts \
      --base "${BASE_REF}" --mode "${REVIEW_MODE}" --out-dir "${OUT_DIR}" 2>"$OUT_DIR/review-capture.stderr.log")"
  CR_TS_RC=$?
  if [ "$CR_TS_RC" -ne 0 ]; then
    record review warn "review-capture.ts itself failed (rc=${CR_TS_RC}) — see .factory/review-capture.stderr.log"
  else
    CR_STATUS="$(node -e '
      try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.status || ""); } catch {}
    ' "${CR_JSON:-}" 2>/dev/null)"
    CR_DETAIL="$(node -e '
      try { const d = JSON.parse(process.argv[1]); process.stdout.write(d.detail || ""); } catch {}
    ' "${CR_JSON:-}" 2>/dev/null)"
    record review "${CR_STATUS:-warn}" "${CR_DETAIL:-review-capture produced no parseable result}"
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
