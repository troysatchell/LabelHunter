#!/usr/bin/env bash
#
# worktree.sh — provision an isolated worktree for one factory ticket.
#
# Every ticket gets its own worktree, its own database, and probed-and-claimed
# ports. Two agents sharing a database silently destroy each other's fixtures
# and produce failures that look like code defects — the single most common
# cause of confusing parallel-agent failures.
#
# Usage:  scripts/factory/worktree.sh TRO-301 feat/lh-scaffold [base-ref]
#
# Re-running for the same ticket RESETS the database, so a retry starts clean
# rather than inheriting a half-migrated state.
#
set -euo pipefail

TICKET="${1:?usage: worktree.sh <TICKET-ID> <branch-name> [base-ref]}"
BRANCH="${2:?usage: worktree.sh <TICKET-ID> <branch-name> [base-ref]}"
BASE_REF="${3:-main}"

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
  echo "    -p ${PG_PORT}:5432 postgres:16-alpine" >&2
  exit 1
fi

# --- 2. worktree ------------------------------------------------------------
if git worktree list --porcelain | grep -qx "worktree ${WT_PATH}"; then
  echo "worktree already exists, reusing it"
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
# .factory-env and .factory/ are ignored via the tracked .gitignore.
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
