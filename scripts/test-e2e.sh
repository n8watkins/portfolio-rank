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
# The admin API (tests/admin-quota.test.mjs) answers this login only.
export ADMIN_GITHUB_LOGIN="e2e-admin"
# A local stand-in for Google PageSpeed, served by tests/psi-cache.test.mjs.
export E2E_PSI_PORT="${E2E_PSI_PORT:-7692}"
export PSI_API_BASE="http://127.0.0.1:$E2E_PSI_PORT/runPagespeed"
unset PSI_API_KEY
# Games, badges, claims, live stats and reports (lib/games), off in
# production until the redesign ships, are tested switched on, with a local
# stand-in for the GitHub API served by tests/games-api.test.mjs.
export GAMES_V2=true
export E2E_GH_PORT="${E2E_GH_PORT:-7693}"
export GITHUB_API_BASE="http://127.0.0.1:$E2E_GH_PORT"
unset GITHUB_API_TOKEN EMAIL_FROM
DB="$PWD/data/e2e.db"
rm -f "$DB"*
export LOCAL_DB_FILE="$DB" E2E_DB_URL="file:$DB"
[ "${E2E_SKIP_BUILD:-}" = 1 ] || npx next build
node node_modules/next/dist/bin/next start -p "$PORT" > "${TMPDIR:-/tmp}/portfolio-rank-e2e.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true; rm -f "$DB"*' EXIT
node --test --test-concurrency=1 "tests/*.test.mjs"
