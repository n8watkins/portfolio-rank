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
# The admin API (tests/admin-quota.test.mjs) answers this GitHub account id
# only (tests/helpers/session.mjs ADMIN_ID), whatever its login.
export ADMIN_GITHUB_ID="990000000"
# As in wrangler.jsonc: accounts younger than this don't count as voters or
# owners (tests/helpers/session.mjs mints accounts a year old by default).
export MIN_GITHUB_ACCOUNT_AGE_DAYS=30
# A local stand-in for Google PageSpeed, served by tests/psi-cache.test.mjs.
export E2E_PSI_PORT="${E2E_PSI_PORT:-7692}"
export PSI_API_BASE="http://127.0.0.1:$E2E_PSI_PORT/runPagespeed"
unset PSI_API_KEY
# "Grade my portfolio" (tests/grader-api.test.mjs): on, with local stand-ins
# for the portfolio sites, GitHub's API and Gemini served by that test, the
# screenshots in a local folder and emails kept in the email_outbox table.
# lib/grader/server.ts ignores the stand-ins on the deployed Workers.
export GRADER_ENABLED=true
export E2E_GRADER_MOCK_PORT="${E2E_GRADER_MOCK_PORT:-7693}"
export GRADER_TEST_SITE="http://127.0.0.1:$E2E_GRADER_MOCK_PORT"
export GRADER_TEST_GITHUB_API="http://127.0.0.1:$E2E_GRADER_MOCK_PORT/github"
export GRADER_TEST_GEMINI_API="http://127.0.0.1:$E2E_GRADER_MOCK_PORT/gemini"
export GRADER_TEST_SHOTS_DIR="$PWD/data/e2e-shots"
export GITHUB_DISPATCH_TOKEN="e2e-dispatch-token"
export EMAIL_TRANSPORT=outbox
# Not "production": the local Cloudflare context would otherwise fill it in
# from wrangler.jsonc, and the outbox refuses to run on a deployed Worker.
export SITE_ENV=test
unset GEMINI_API_KEY TURNSTILE_SECRET_KEY SEND_EMAIL
# Games, badges, claims, live stats and reports (lib/games), off in
# production until the redesign ships, are tested switched on, with a local
# stand-in for the GitHub API served by tests/games-api.test.mjs on its own
# port (lib/grader/server.ts testSeam: ignored on the deployed Workers).
export GAMES_V2=true
export E2E_GAMES_GH_PORT="${E2E_GAMES_GH_PORT:-7694}"
export GAMES_TEST_GITHUB_API="http://127.0.0.1:$E2E_GAMES_GH_PORT"
unset GITHUB_API_TOKEN
DB="$PWD/data/e2e.db"
rm -f "$DB"*
rm -rf "$GRADER_TEST_SHOTS_DIR"
export LOCAL_DB_FILE="$DB" E2E_DB_URL="file:$DB"
export E2E_SERVER_LOG="${TMPDIR:-/tmp}/portfolio-rank-e2e.log"
[ "${E2E_SKIP_BUILD:-}" = 1 ] || npx next build
node node_modules/next/dist/bin/next start -p "$PORT" > "$E2E_SERVER_LOG" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true; rm -f "$DB"*; rm -rf "$GRADER_TEST_SHOTS_DIR"' EXIT
node --test --test-concurrency=1 "tests/*.test.mjs"
