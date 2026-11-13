#!/usr/bin/env bash
# Builds the app, starts it on a throwaway local database and runs the
# end-to-end tests in tests/ against it. Never point this at Turso:
# TURSO_* are unset so lib/db.ts uses a local libSQL file.
set -euo pipefail
cd "$(dirname "$0")/.."
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN SHOTS_BASE_URL
# Ports: E2E_PORT and the three stand-in ports below can be set by hand;
# otherwise each run takes free ports from the OS, so parallel runs (several
# worktrees, several agents) never share a server or a stand-in. A run that
# reused a busy port could pass or fail against someone else's server.
free_ports() {
  node -e '
    const net = require("node:net");
    const servers = [];
    (async () => {
      for (let i = 0; i < Number(process.argv[1]); i++) {
        const s = net.createServer();
        await new Promise((ok, no) => { s.once("error", no); s.listen(0, "127.0.0.1", ok); });
        servers.push(s);
      }
      process.stdout.write(servers.map((s) => s.address().port).join(" "));
      for (const s of servers) s.close();
    })();
  ' "$1"
}
read -r FREE_APP FREE_PSI FREE_GRADER FREE_GAMES FREE_KIT <<< "$(free_ports 5)"
export PORT="${E2E_PORT:-$FREE_APP}"
export E2E_BASE_URL="http://localhost:$PORT"
export AUTH_SECRET="${AUTH_SECRET:-$(node -e 'process.stdout.write(require("crypto").randomBytes(33).toString("base64"))')}"
export AUTH_GITHUB_ID="${AUTH_GITHUB_ID:-e2e}" AUTH_GITHUB_SECRET="${AUTH_GITHUB_SECRET:-e2e}"
# The site's address (lib/site.ts siteUrl; auth.ts gives it to Auth.js).
export SITE_URL="$E2E_BASE_URL"
# The admin API (tests/admin-quota.test.mjs) answers this GitHub account id
# only (tests/helpers/session.mjs ADMIN_ID), whatever its login.
export ADMIN_GITHUB_ID="990000000"
# As in wrangler.jsonc: accounts younger than this don't count as voters or
# owners (tests/helpers/session.mjs mints accounts a year old by default).
export MIN_GITHUB_ACCOUNT_AGE_DAYS=30
# A local stand-in for Google PageSpeed, served by tests/psi-cache.test.mjs.
export E2E_PSI_PORT="${E2E_PSI_PORT:-$FREE_PSI}"
export PSI_API_BASE="http://127.0.0.1:$E2E_PSI_PORT/runPagespeed"
unset PSI_API_KEY
# "Grade my portfolio" (tests/grader-api.test.mjs): on, with local stand-ins
# for the portfolio sites, GitHub's API and Gemini served by that test, the
# screenshots in a local folder and emails kept in the email_outbox table.
# lib/grader/server.ts ignores the stand-ins on the deployed Workers.
export GRADER_ENABLED=true
# The free tools (tests/tools-api.test.mjs), with PageSpeed from the stand-in above.
export TOOLS_ENABLED=true
# A low speed cap, so tests/tools-api.test.mjs can reach it (it can only lower the defaults).
export TOOLS_CAPS='{"speed":{"network":3}}'
export E2E_GRADER_MOCK_PORT="${E2E_GRADER_MOCK_PORT:-$FREE_GRADER}"
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
# The content engine's ceiling as in production (wrangler.jsonc): drafts for
# review, at most 2 a week (tests/admin-controls.test.mjs, the Automation panel).
export CONTENT_MODE=dry-run CONTENT_DRAFTS_PER_WEEK=2
# The blog (tests/blog-pages.test.mjs): post images from the fixture folder
# instead of the R2 bucket (lib/blog-media.ts, ignored on the deployed Workers).
export BLOG_TEST_MEDIA_DIR="$PWD/tests/fixtures/blog/media"
# The blog newsletter (tests/newsletter-e2e.test.mjs): on, with a local
# stand-in for Kit's API served by that test (KIT_TEST_API, ignored on the
# deployed Workers) and a fake key. The stand-in has one form, so
# KIT_FORM_ID stays unset and the form is found by asking Kit.
export NEWSLETTER_ENABLED=true OWNER_EMAIL=owner@example.com
export E2E_KIT_PORT="${E2E_KIT_PORT:-$FREE_KIT}"
export KIT_TEST_API="http://127.0.0.1:$E2E_KIT_PORT/v4" KIT_API_KEY="e2e-kit-key"
unset KIT_FORM_ID KIT_BROADCAST_MODE
export E2E_GAMES_GH_PORT="${E2E_GAMES_GH_PORT:-$FREE_GAMES}"
export GAMES_TEST_GITHUB_API="http://127.0.0.1:$E2E_GAMES_GH_PORT"
unset GITHUB_API_TOKEN
DB="$PWD/data/e2e.db"
rm -f "$DB"*
rm -rf "$GRADER_TEST_SHOTS_DIR"
export LOCAL_DB_FILE="$DB" E2E_DB_URL="file:$DB"
# A library of graded portfolios, as every deployed site has (the face-off draws only graded sites).
node scripts/e2e-seed.mjs
export E2E_SERVER_LOG="${E2E_SERVER_LOG:-${TMPDIR:-/tmp}/portfolio-rank-e2e-$PORT.log}"
[ "${E2E_SKIP_BUILD:-}" = 1 ] || npx next build
node node_modules/next/dist/bin/next start -p "$PORT" > "$E2E_SERVER_LOG" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true; rm -f "$DB"*; rm -rf "$GRADER_TEST_SHOTS_DIR"' EXIT
# Wait for our own server. If it exited (say the port was taken between the
# pick and the start), stop rather than test whatever else listens there.
for _ in $(seq 1 120); do
  if ! kill -0 "$server" 2>/dev/null; then
    echo "e2e: the server exited before it was ready on port $PORT; the end of its log:" >&2
    tail -n 30 "$E2E_SERVER_LOG" >&2
    exit 1
  fi
  curl -s -o /dev/null "$E2E_BASE_URL/" && break
  sleep 1
done
echo "e2e: app on port $PORT, stand-ins on $E2E_PSI_PORT, $E2E_GRADER_MOCK_PORT and $E2E_GAMES_GH_PORT; server log $E2E_SERVER_LOG"
node --test --test-concurrency=1 "tests/*.test.mjs"
