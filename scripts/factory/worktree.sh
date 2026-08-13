#!/usr/bin/env bash
#
# worktree.sh — provision an isolated worktree for one factory ticket.
#
# Every ticket gets its own worktree, its own database, and probed-and-claimed
# ports. Two agents sharing a database silently destroy each other's fixtures
# and produce failures that look like code defects — the single most common
# cause of confusing parallel-agent failures.
#
# Usage:  scripts/factory/worktree.sh TRO-301 feat/lh-scaffold [base-ref] [--steal]
#
# Re-running for the same ticket RESETS the database, so a retry starts clean
# rather than inheriting a half-migrated state. That reset is safe only when
# the caller re-running it is the same session that provisioned the worktree
# last (TRO-557): every provision stamps a `.factory-owner` ownership file,
# and reuse from a DIFFERENT session refuses with exit 2 instead of silently
# resetting a database that session may still be using. Pass --steal to
# reassign ownership and proceed anyway.
#
# Two invocations for the SAME ticket landing at once serialize on a
# per-ticket lock (TRO-572) rather than both racing the database reset — see
# the lock's own comment below for why the ownership stamp alone cannot
# catch that case.
#
set -euo pipefail

USAGE="usage: worktree.sh <TICKET-ID> <branch-name> [base-ref] [--steal]"
STEAL=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --steal) STEAL=1 ;;
    --*)
      echo "ERROR: unknown option '${arg}'." >&2
      echo "       ${USAGE}" >&2
      exit 2
      ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
if [ "${#POSITIONAL[@]}" -gt 3 ]; then
  echo "ERROR: too many arguments." >&2
  echo "       ${USAGE}" >&2
  exit 2
fi

TICKET="${POSITIONAL[0]:?$USAGE}"
BRANCH="${POSITIONAL[1]:?$USAGE}"
BASE_REF="${POSITIONAL[2]:-main}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Config, overridable from the environment. NOTE: :5433 is ship-audit-pg on
# this machine — labelhunter gets its own container on :5434.
PG_CONTAINER="${FACTORY_PG_CONTAINER:-labelhunter-pg}"
PG_HOST="${FACTORY_PG_HOST:-localhost}"
PG_PORT="${FACTORY_PG_PORT:-5434}"
PG_USER="${FACTORY_PG_USER:-labelhunter}"
PG_PASSWORD="${FACTORY_PG_PASSWORD:-labelhunter_dev_password}"

# Validate the ticket ID BEFORE it reaches a database name. Identifiers cannot
# be bound as parameters, so a ticket like `X"; DROP DATABASE prod; --` would
# execute. Reject rather than escape. (Found by review on the reference
# factory's own provisioner.)
if ! [[ "$TICKET" =~ ^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+$ ]]; then
  echo "ERROR: invalid ticket ID '${TICKET}'." >&2
  echo "       Expected a plain Linear identifier such as TRO-301." >&2
  exit 2
fi

TICKET_SLUG="$(echo "$TICKET" | tr '[:upper:]-' '[:lower:]_')"
DB_NAME="labelhunter_wt_${TICKET_SLUG}"
# Canonicalized via pwd -P: `git worktree list` prints resolved absolute paths,
# so an unnormalized path never matches the reuse check and every retry fails.
WT_PATH="$(cd "${REPO_ROOT}/.." && pwd -P)/labelhunter-wt-${TICKET_SLUG}"

# --- caller identity (TRO-557) -----------------------------------------------
# Two orchestrator sessions provisioning the same ticket within seconds of
# each other is a real, observed failure (2026-08-13): the second run reused
# the first session's worktree and dropped its database mid-use. There is no
# single canonical "session id" every caller is guaranteed to have, so this
# picks the strongest one actually available: $CLAUDE_CODE_SESSION_ID is set
# by the Claude Code CLI for the life of one session and inherited by every
# subshell it spawns — unlike $$, which is a fresh PID on every single Bash
# tool call, it stays stable across repeated invocations from the same
# session. FACTORY_SESSION_ID overrides it explicitly (a non-Claude-Code
# caller that wants to assert its own stable identity, or a test).
# LIMITATION: a caller with neither set (a bare shell, cron, CI) gets a value
# that is different on every invocation, so it can never match itself on a
# retry — every reuse then needs --steal. That is a usability cost, not a
# safety hole: an unidentifiable caller defaults to refusal, never to silent
# trust of a stranger's database.
RAW_SESSION_ID="${FACTORY_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
if [[ "$RAW_SESSION_ID" =~ ^[A-Za-z0-9._:-]+$ ]]; then
  CALLER_SESSION_ID="$RAW_SESSION_ID"
else
  CALLER_SESSION_ID="unidentified-$(hostname)-$$-$(date +%s 2>/dev/null || echo 0)"
fi

echo "=== factory worktree: ${TICKET} ==="
echo "  branch:    ${BRANCH}  (from ${BASE_REF})"
echo "  worktree:  ${WT_PATH}"
echo "  database:  ${DB_NAME}"
echo

# --- 1. preconditions -------------------------------------------------------
if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  echo "ERROR: postgres container '${PG_CONTAINER}' is not running." >&2
  echo "Start it with:" >&2
  echo "  docker run -d --name ${PG_CONTAINER} -e POSTGRES_DB=labelhunter_dev \\" >&2
  echo "    -e POSTGRES_USER=${PG_USER} -e POSTGRES_PASSWORD=${PG_PASSWORD} \\" >&2
  echo "    -p 127.0.0.1:${PG_PORT}:5432 postgres:16-alpine" >&2
  exit 1
fi

# --- per-ticket lock (TRO-572) ----------------------------------------------
# TRO-557 refuses a reuse from a DIFFERENT session, but only by comparing a
# stamp file written near the END of a successful provision (after the
# database is dropped/recreated and the port is claimed). Two invocations for
# the SAME ticket -- the same session calling twice at once, or two --steal
# calls landing together -- can both pass that check before either has
# written anything, then both proceed to DROP/CREATE the database and both
# `cd` into the same worktree to run `pnpm install`/`db:migrate` at once.
# That is a genuine data race, not merely a UX gap (TRO-557's own review
# triage scoped it out on purpose: cross-session refusal, not intra-session
# mutual exclusion).
#
# `mkdir` is atomic on every filesystem this factory runs on, and this
# machine has no `flock` binary (macOS ships none by default) -- so `mkdir`
# is both the portable choice and the one that needs no new dependency.
# Exactly one concurrent invocation can create LOCK_DIR; every other one
# waits, or breaks a lock left behind by a crashed same-host holder.
LOCK_DIR="${WT_PATH}.lock"
REAP_LOCK="${LOCK_DIR}.reaping"
LOCK_POLLS=0
LOCK_MAX_POLLS=300 # ~60s at 0.2s/poll

# `ps -p`, not `kill -0`: `kill -0` fails for two different reasons -- ESRCH
# (no such process, genuinely dead) and EPERM (the process exists but this
# user cannot signal it, e.g. it is owned by someone else). Treating both as
# "dead" would break a lock a live process still holds. `ps -p` reports
# existence regardless of ownership, on both the BSD (macOS) and GNU (Linux
# CI) variants (CodeRabbit, TRO-572 review round 2).
pid_is_alive() {
  ps -p "$1" >/dev/null 2>&1
}

while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  # Counted at the TOP of every iteration, including the stale-break path
  # below, so a pathological run of back-to-back stale locks still reaches
  # the timeout instead of spinning past it uncounted.
  LOCK_POLLS=$(( LOCK_POLLS + 1 ))
  if [ "$LOCK_POLLS" -gt "$LOCK_MAX_POLLS" ]; then
    echo "ERROR: timed out waiting for the lock on ${TICKET} (${LOCK_DIR})." >&2
    echo "       There is no reliable way to check a pid's liveness on a" >&2
    echo "       different host, so a lock stamped from elsewhere always" >&2
    echo "       waits out its holder rather than being auto-broken." >&2
    echo "       CONFIRM no other worktree.sh invocation for ${TICKET} is" >&2
    echo "       really running before removing it by hand:" >&2
    echo "         rm -rf '${LOCK_DIR}'" >&2
    exit 2
  fi

  # Stale-lock recovery, gated by its OWN mutex (REAP_LOCK). Two earlier
  # versions of this fix inspected LOCK_DIR by moving it aside first (a
  # capture-then-confirm-then-restore dance). Both left a real window: while
  # one waiter held the lock's content OUTSIDE the LOCK_DIR path -- even
  # briefly, even to put it straight back -- LOCK_DIR did not exist, and a
  # DIFFERENT invocation's `mkdir` could win that gap. That let two
  # processes each believe they held the lock alone (CodeRabbit, TRO-572
  # review rounds 1 and 2, both critical).
  #
  # This version never moves LOCK_DIR at all. `mkdir "$REAP_LOCK"` lets
  # AT MOST ONE waiter at a time even attempt to inspect-and-maybe-remove
  # the stale lock; every other waiter that fails to grab REAP_LOCK just
  # skips straight to the wait/retry path below, touching nothing. While
  # this waiter holds REAP_LOCK, nothing else can start its own inspection,
  # and LOCK_DIR still exists at its normal path the whole time (nobody
  # else's `mkdir` can succeed against an existing directory) -- so
  # read-then-remove is safe here, with no capture, confirm, or restore
  # step needed. REAP_LOCK itself is held only for a few local filesystem
  # calls, not for the ticket's whole critical section, so it gets no
  # stale-recovery of its own: a crash inside that narrow window is
  # vastly less likely than one during `pnpm install`/`db:migrate`, and the
  # 60s timeout below is the backstop either way.
  if mkdir "$REAP_LOCK" 2>/dev/null; then
    STALE_HOST=""
    STALE_PID=""
    if [ -f "${LOCK_DIR}/owner" ]; then
      STALE_HOST="$(sed -n 's/^HOST=//p' "${LOCK_DIR}/owner" 2>/dev/null || true)"
      STALE_PID="$(sed -n 's/^PID=//p' "${LOCK_DIR}/owner" 2>/dev/null || true)"
    fi
    BROKE_STALE_LOCK=0
    if [ "$STALE_HOST" = "$(hostname)" ] && [ -n "$STALE_PID" ] && ! pid_is_alive "$STALE_PID"; then
      echo "  lock:      breaking a stale lock from dead pid ${STALE_PID} on this host" >&2
      rm -rf "$LOCK_DIR"
      BROKE_STALE_LOCK=1
    fi
    rm -rf "$REAP_LOCK"
    if [ "$BROKE_STALE_LOCK" -eq 1 ]; then
      continue
    fi
  fi

  if [ "$LOCK_POLLS" -eq 1 ]; then
    echo "  lock:      another invocation is provisioning ${TICKET} -- waiting..." >&2
  fi
  sleep 0.2
done

# The owner file is written BEFORE the trap, so the trap's own ownership
# check (below) never runs against a lock dir that has no owner file yet --
# an early interrupt between `mkdir` and this write would otherwise make the
# trap refuse to clean up its own, definitely-ours lock.
{
  echo "PID=$$"
  echo "HOST=$(hostname)"
} > "${LOCK_DIR}/owner"
# Released on ANY exit -- success, error, or signal -- so a failed or
# interrupted provision never leaves the next invocation waiting forever.
# Checks the stamp still names THIS pid first: under the pre-check design
# above nobody else should ever touch a live lock, but this is a cheap,
# direct answer to "verify ownership before the EXIT trap removes it"
# (CodeRabbit, TRO-572 review round 2) rather than relying on that
# invariant alone.
trap '
  lock_owner_pid="$(sed -n "s/^PID=//p" "${LOCK_DIR}/owner" 2>/dev/null || true)"
  [ "$lock_owner_pid" = "$$" ] && rm -rf "$LOCK_DIR"
' EXIT

# --- 2. worktree ------------------------------------------------------------
if git worktree list --porcelain | grep -qx "worktree ${WT_PATH}"; then
  OWNER_STAMP="${WT_PATH}/.factory-owner"
  # The stamp is data written by a PRIOR run, not trusted code — read it with
  # grep, never `source` (lessons.md #13: validate at the boundary).
  STAMPED_SESSION=""
  if [ -f "$OWNER_STAMP" ]; then
    # `|| true`: under `set -o pipefail`, grep finding no matching line exits
    # 1 even though cut still succeeds on empty input, and that non-zero
    # status would abort the whole script here under `set -e` -- a stamp
    # file missing this one field must fall through to "unknown owner", not
    # crash provisioning outright. (CodeRabbit, this PR.)
    STAMPED_SESSION="$(grep -m1 '^FACTORY_OWNER_SESSION=' "$OWNER_STAMP" | cut -d= -f2- || true)"
  fi
  if [ "$STEAL" -eq 1 ]; then
    echo "worktree already exists, reusing it (--steal: ownership reassigned to this session)"
  elif [ -n "$STAMPED_SESSION" ] && [ "$STAMPED_SESSION" = "$CALLER_SESSION_ID" ]; then
    echo "worktree already exists, reusing it (same session)"
  else
    echo "ERROR: worktree ${WT_PATH} is claimed by another session." >&2
    echo "       Re-provisioning resets a database another session may be using." >&2
    if [ -n "$STAMPED_SESSION" ]; then
      echo "       Current stamp (${OWNER_STAMP}):" >&2
      sed 's/^/         /' "$OWNER_STAMP" >&2
    else
      echo "       worktree.sh found no readable ownership stamp here." >&2
      echo "       Treat the owner as unknown." >&2
    fi
    echo "       Pass --steal to reassign ownership and proceed anyway." >&2
    exit 2
  fi
else
  if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    git worktree add "$WT_PATH" "$BRANCH"
  else
    git worktree add "$WT_PATH" -b "$BRANCH" "$BASE_REF"
  fi
fi

# --- 3. isolated database ---------------------------------------------------
echo "provisioning database ${DB_NAME}..."
# WITH (FORCE) terminates lingering backends first: a retry after a crashed
# agent — whose pool is still connected — otherwise fails with "database is
# being accessed by other users" and aborts under `set -e`.
docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);" \
  -c "CREATE DATABASE ${DB_NAME} OWNER ${PG_USER};" >/dev/null

DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${DB_NAME}"

# --- 4. per-worktree ports --------------------------------------------------
# The hash gives a STABLE starting point across re-provisions; it does not give
# uniqueness (md5 % 900 collides at ~50% odds by 36 concurrent tickets). Probe
# upward and claim the first port that is neither listening nor recorded in a
# sibling worktree's .factory-env.
HASH="$(echo -n "$TICKET_SLUG" | md5 2>/dev/null | cut -c1-4 || echo -n "$TICKET_SLUG" | md5sum | cut -c1-4)"
PORT_OFFSET=$(( 0x$HASH % 900 + 10 ))

WT_PARENT="$(cd "${REPO_ROOT}/.." && pwd -P)"

port_listening() {   # 0 = something is bound to it
  ( exec 3<>"/dev/tcp/127.0.0.1/$1" ) >/dev/null 2>&1
}

port_claimed() {     # 0 = another worktree already recorded it
  grep -rhsE "^export APP_PORT=$1$" \
    "${WT_PARENT}"/labelhunter-wt-*/.factory-env 2>/dev/null | grep -q .
}

find_free_port() {   # find_free_port <start>
  local p="$1" tries=0
  while [ $tries -lt 500 ]; do
    if ! port_listening "$p" && ! port_claimed "$p"; then
      echo "$p"; return 0
    fi
    p=$(( p + 1 )); tries=$(( tries + 1 ))
  done
  echo "ERROR: no free port found starting at $1" >&2
  return 1
}

APP_PORT="$(find_free_port $(( 3100 + PORT_OFFSET )))"
echo "  port:      app ${APP_PORT}"

cd "$WT_PATH"

# --- ownership stamp (TRO-557) -----------------------------------------------
# Written on every successful provision: a fresh worktree, a same-session
# reuse, or a --steal. This is what the next caller's reuse check compares
# against. PID/host/timestamp are forensic only (a fresh PID every
# invocation, unlike CALLER_SESSION_ID) — never compared, only printed on
# refusal so a human doesn't have to reconstruct ownership from stat/reflog.
cat > .factory-owner <<EOF
FACTORY_OWNER_SESSION=${CALLER_SESSION_ID}
FACTORY_OWNER_PID=$$
FACTORY_OWNER_HOST=$(hostname)
FACTORY_OWNER_STAMPED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FACTORY_OWNER_BRANCH=${BRANCH}
EOF

# Next.js reads .env.local; the scaffold ticket may extend this, but
# DATABASE_URL and PORT are the load-bearing lines and .factory-env stays the
# authority for the gate.
cat > .env.local <<EOF
# Auto-generated by scripts/factory/worktree.sh for ${TICKET}
# This database is EXCLUSIVE to this worktree. Tests reset it.
DATABASE_URL=${DATABASE_URL}
PORT=${APP_PORT}
EOF

# The gate and any agent shell in this worktree read this file.
# Every line is `export`ed: the documented workflow is `source .factory-env`,
# and a plain assignment would not pass DATABASE_URL to pnpm subprocesses.
cat > .factory-env <<EOF
export FACTORY_TICKET=${TICKET}
export FACTORY_BRANCH=${BRANCH}
export FACTORY_BASE_REF=${BASE_REF}
export FACTORY_DB_NAME=${DB_NAME}
export DATABASE_URL=${DATABASE_URL}
export APP_PORT=${APP_PORT}
EOF
# API keys live only in the primary checkout's .env.local (never in the repo).
# Copy each key line through so a ticket that calls Anthropic (cascade) or
# Gemini (golden-set image gen, LH-005) works without a human stop. Both files
# get it: .env.local for Next.js/dotenv loaders, .factory-env (exported) for
# bare scripts run from an agent shell. The value is never echoed — only the
# key's name.
for KEY_NAME in ANTHROPIC_API_KEY GOOGLE_API_KEY; do
  if KEY_LINE="$(grep -h "^${KEY_NAME}=" "${REPO_ROOT}/.env.local" 2>/dev/null | head -n1)" \
     && [ -n "$KEY_LINE" ]; then
    printf '%s\n' "$KEY_LINE" >> .env.local
    printf 'export %s\n' "$KEY_LINE" >> .factory-env
    echo "  key:       ${KEY_NAME} passed through from primary .env.local"
  fi
done

# .factory-env, .factory-owner, and .factory/ are ignored via the tracked .gitignore.
# Do NOT write to .git/info/exclude here: in a linked worktree `.git` is a FILE
# holding a gitdir pointer, so that path fails with "Not a directory" and,
# under `set -e`, aborts provisioning before the database is ever migrated.

# --- 5. dependencies + schema ----------------------------------------------
# Pre-scaffold there is nothing to install or migrate; both steps are
# conditional so the script is usable from day one.
if [ -f package.json ]; then
  if [ ! -d node_modules ]; then
    echo "installing dependencies (this is the slow part)..."
    pnpm install --silent
  fi
  if node -e 'const p=require("./package.json"); process.exit(p.scripts && p.scripts["db:migrate"] ? 0 : 1)' 2>/dev/null; then
    echo "migrating ${DB_NAME}..."
    DATABASE_URL="$DATABASE_URL" pnpm db:migrate
  else
    echo "  note: no db:migrate script yet (pre-scaffold) — database created empty"
  fi
else
  echo "  note: pre-scaffold repo — no dependencies to install, no migrations to run"
fi

echo
echo "=== ready ==="
echo "cd ${WT_PATH}"
echo "source .factory-env   # exports DATABASE_URL scoped to this ticket"
