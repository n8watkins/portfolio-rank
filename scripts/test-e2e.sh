#!/usr/bin/env bash
# Builds the app, starts it on a throwaway local database and runs the
# end-to-end tests in tests/ against it. Never point this at Turso:
# TURSO_* are unset so lib/db.ts uses a local libSQL file.
set -euo pipefail
cd "$(dirname "$0")/.."
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN SHOTS_BASE_URL
export PORT="${E2E_PORT:-7691}"
export E2E_BASE_URL="http://localhost:$PORT"
export AUTH_SECRET="${AUTH_SECRET:-$(node -e 'process.stdout.write(require("crypto").randomBytes(33).toString("base64"))')}"
export AUTH_GITHUB_ID="${AUTH_GITHUB_ID:-e2e}" AUTH_GITHUB_SECRET="${AUTH_GITHUB_SECRET:-e2e}"
export AUTH_URL="$E2E_BASE_URL"
DB="$PWD/data/e2e.db"
rm -f "$DB"*
export LOCAL_DB_FILE="$DB" E2E_DB_URL="file:$DB"
[ "${E2E_SKIP_BUILD:-}" = 1 ] || npx next build
node node_modules/next/dist/bin/next start -p "$PORT" > "${TMPDIR:-/tmp}/portfolio-rank-e2e.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true; rm -f "$DB"*' EXIT
node --test --test-concurrency=1 "tests/*.test.mjs"
