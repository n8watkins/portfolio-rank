# Deploying PortfolioRank

## Cloudflare Workers

The app runs on a Cloudflare Worker built with OpenNext (`@opennextjs/cloudflare`) at https://portfoliorank.dev; `wrangler.jsonc` and `open-next.config.ts` hold the config.
The custom domains are `routes` entries in `wrangler.jsonc`, so every deploy keeps them, and the workers.dev address is off.
The Worker also answers at `www.portfoliorank.dev` and at the old address `portfoliorank.n8builds.dev` (until 2026-11), only to redirect them to the same path on https://portfoliorank.dev (`worker/canonical-host.ts`: 301 for GET and HEAD, 308 for other methods, so an API caller on the old address keeps working while it moves).
Staging does the same from `staging.portfoliorank.n8builds.dev` to https://staging.portfoliorank.dev.

- **Deploy by hand:** `npm run deploy` (builds, then `wrangler deploy`).
  The build prerenders the home page, so run it with `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `SHOTS_BASE_URL=/shots` in the environment, or the first render after a deploy shows no ranking until ISR refreshes it (5 minutes).
- **Deploy from GitHub:** `.github/workflows/deploy.yml` ships every push to main to production, and `.github/workflows/staging.yml` keeps staging on main plus the pull requests labeled `staging` ("How a change ships" below), once the repository has a `CLOUDFLARE_API_TOKEN` secret (an API token with the "Edit Cloudflare Workers" permission); until then it skips the deploy with a notice.
- **Preview locally:** `npm run preview` runs the built Worker on workerd, reading secrets from `.dev.vars`.
- **Secrets** (`npx wrangler secret put <NAME>`, never in a file): `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `PSI_API_KEY`, plus two for the end-of-day run ([AUTOMATION.md](AUTOMATION.md#end-of-day-run)):
  `GEMINI_API_KEY` (send it with `pass-env pipe portfolio-rank/GEMINI_API_KEY -- npx wrangler secret put GEMINI_API_KEY`) and `GITHUB_DISPATCH_TOKEN` (a fine-grained token for `n8watkins/portfolio-rank` only with "Actions: Read and write"; `pass-env pipe portfolio-rank/GITHUB_DISPATCH_TOKEN -- npx wrangler secret put GITHUB_DISPATCH_TOKEN`), which also starts "grade my portfolio" captures.
  Required on both Workers: `TURNSTILE_SECRET_KEY` for Cloudflare Turnstile on poll votes, grade requests and report emails (AUTOMATION.md "Polls", "Grade my portfolio" and "Games, badges, claims, live stats and reports"); without it those requests are refused, and the token's hostname must match the Worker's `SITE_URL`.
  Email (grade reports, report links, owner alerts) goes through the `send_email` binding `SEND_EMAIL` from the `EMAIL_FROM` variable; owner alerts need the `OWNER_EMAIL` secret ("Grade my portfolio: owner steps" below).
  Email sign-in links go through the shared mailroom: the service binding `MAILROOM` (`wrangler.jsonc` `services`, app `portfoliorank`), on both Workers; the mailroom must list the kind `signin` for that app and be deployed first (n8watkins/mailroom, `deployments/n8builds/apps.ts`), or every sign-in email is refused and the form says email isn't available.
  Optional: `GITHUB_API_TOKEN` (a fine-grained token with no permissions, public data only) raises the GitHub API rate limit for claims and the live stats.
  Without `GITHUB_DISPATCH_TOKEN` the nightly checks are not started from Cloudflare (one log line says so) and their GitHub schedule runs as the fallback.
  `SHOTS_BASE_URL` and `SITE_URL` (the site's one address setting) are plain variables in `wrangler.jsonc`.
  `SITE_URL` gives canonical URLs, share links, the sitemap, robots.txt, RSS, email links, the origin and Turnstile checks and Auth.js's callback URL (`auth.ts` copies it to `AUTH_URL`); pages built ahead of time use the same address from `lib/site.ts`, and `tests/site-url.test.mjs` keeps the two equal.
  So are the end-of-day run's switches (`RANKING_V2`, `RUBRIC_REGRADE`, `GEMINI_RPM`, `NIGHTLY_REFRESH`), `ADMIN_GITHUB_ID` (the admin's numeric GitHub id), `MIN_GITHUB_ACCOUNT_AGE_DAYS`, `GRADER_ENABLED`, `GAMES_V2`, `EMAIL_FROM` and the content engine's ceiling (`CONTENT_MODE`, `CONTENT_DRAFTS_PER_WEEK`; the owner schedules within it on `/admin/blog`): change them in `wrangler.jsonc` through a pull request, since a deploy resets variables to what the file says.
- **Games (`GAMES_V2`, off):** the games, badges, claims, live stats and report routes answer 404 until the variable `GAMES_V2` is `"true"` in `wrangler.jsonc` (both environments).
  Report links by email go through the same email gate and `SEND_EMAIL` binding as grade reports, so they need nothing more.
  Optional: `EARLY_SUPPORTER_UNTIL` (`YYYY-MM-DD`, Pacific), the last day the Early supporter badge is given.
- **Newsletter (`NEWSLETTER_ENABLED`, off in production, on in staging):** the sign-up forms, its API and the ten-minute cron (AUTOMATION.md "Newsletter").
  Kit keeps the list and sends: set the `KIT_API_KEY` secret on each Worker (`pass-env pipe portfolio-rank/KIT_API_KEY -- npx wrangler secret put KIT_API_KEY --env staging`, and without `--env` for production).
  The sign-up form is the Kit account's only form unless `KIT_FORM_ID` says which; `KIT_BROADCAST_MODE` is `"send"` in production (staging always makes drafts).
  The "draft ready in Kit" note goes to `OWNER_EMAIL`; keep it out of this public file as a secret: `! pass-env set portfolio-rank/OWNER_EMAIL`, then `pass-env pipe portfolio-rank/OWNER_EMAIL -- npx wrangler secret put OWNER_EMAIL --env staging`.
- **Cron Triggers and the Workflow:** `triggers.crons` and `workflows` in `wrangler.jsonc`; `npx wrangler triggers deploy` is not needed, a deploy registers them (they can take up to 15 minutes to reach every location).
  Check them in the dashboard (Workers & Pages, portfolio-rank, Settings, Triggers) or with `npx wrangler workflows instances list portfolio-rank-night`.
- **Screenshots and favicons:** the Worker answers `/shots/<shot_key>/<file>` and `/favicon/<domain>` itself, before the app (`worker/assets.ts`), from the edge cache when it can.
  Screenshots come from the `SHOTS` binding (the `portfolio-rank` R2 bucket the pipeline uploads to); pages add `?v=<capture time>`, so a recapture gets a new URL and each version is served with `Cache-Control: public, max-age=31536000, immutable`.
  Favicons come from Google's favicon service for roster domains only, with a placeholder when a site has none, cached for a week.
  The bucket's public r2.dev address is for the pipeline (the `SHOTS_BASE_URL` repository secret); pages never link it.
- **Database schema:** `lib/schema.mjs` holds every table, index and added column; the deploy workflow runs `node scripts/migrate.mjs` before it builds.
  At runtime `ensureSchema()` only compares the database's recorded schema fingerprint with the code's (one query per isolate) and migrates when they differ, such as a fresh local file.
  To change the schema, add the statement or column there; the fingerprint (a hash of every statement) changes by itself, so no number has to be picked and parallel branches that add tables combine without a conflict over the version.
  `SCHEMA_VERSION` stays as a record of what each number added; the database keeps the highest one it has seen.
- **Sentry source maps:** add the `SENTRY_AUTH_TOKEN` secret (a Sentry auth token with project release access) and the `SENTRY_ORG` and `SENTRY_PROJECT` repository variables.
  The deploy then builds browser source maps, uploads them for the release (the commit SHA) and deletes them before publishing; without those settings it skips the step.
- **ISR:** the home page (`revalidate = 300`) is cached in the `portfolio-rank-opennext-cache` R2 bucket, and a Durable Object queue deduplicates its background re-renders.
  The deploy log prints "A DurableObjectNamespace in the config referenced the class "DOQueueHandler", but no such Durable Object class is exported from the worker".
  It is a false alarm: `opennextjs-cloudflare deploy` starts a local Miniflare proxy (wrangler's `getPlatformProxy`) only to read the config's variables, and that proxy runs none of our code.
  The uploaded Worker does export the class (`worker/index.ts`), and CI proves it on every change (`scripts/check-worker-exports.mjs` on the dry-run bundle).
- **GitHub sign-in:** the OAuth app's homepage is `https://portfoliorank.dev` and its callback URL `https://portfoliorank.dev/api/auth/callback/github`; staging has its own OAuth app ("Staging" below).
- **Actions:** the pipeline jobs talk to Turso and R2 directly and are unaffected.
  `prewarm.yml` calls the site's API at the `PROD_BASE_URL` repository variable (`https://portfoliorank.dev`).

## Grade my portfolio: owner steps

The back end ships switched off (`GRADER_ENABLED` is `"false"` in `wrangler.jsonc`, AUTOMATION.md "Grade my portfolio").
These steps can be done any time before it is switched on; each one is safe on its own.

1. **Turnstile widget** (done 2026-11-10: the widget `PortfolioRank` exists and `TURNSTILE_SECRET_KEY` is on both Workers; the site key `0x4AAAAAAF8GDSY7kmBfRpoD` goes into `wrangler.jsonc` with the redesign).
   An agent couldn't create it: the Cloudflare connection lacks write access to Turnstile.
   In the Cloudflare dashboard, open Turnstile, Add widget: name `PortfolioRank`, hostnames `portfoliorank.dev`, `staging.portfoliorank.dev`, `portfoliorank.n8builds.dev`, `staging.portfoliorank.n8builds.dev` and `localhost`, widget mode **Managed**, no pre-clearance.
   The pages render it with `appearance: "interaction-only"` and execution on page load, so most visitors never see it; the actions are `grade`, `grade-email` and `poll-vote`.
   Keep the secret in pass and send it to both Workers without it ever being shown:
   ```bash
   ! pass-env set portfolio-rank/TURNSTILE_SECRET_KEY        # paste the widget's secret key
   pass-env pipe portfolio-rank/TURNSTILE_SECRET_KEY -- npx wrangler secret put TURNSTILE_SECRET_KEY
   pass-env pipe portfolio-rank/TURNSTILE_SECRET_KEY -- npx wrangler secret put TURNSTILE_SECRET_KEY --env staging
   ```
   From then on every grade request, report-email request and poll vote needs a Turnstile token, so the redesign's forms must render the widget before this goes on in production.
   Put the public site key in `wrangler.jsonc` as the variable `TURNSTILE_SITE_KEY` (production and staging) in the redesign's pull request, where the pages read it.
2. **Email sender:** nothing to set up for the sender itself: `n8builds.dev` is onboarded for Cloudflare Email Sending (Wren sends from it), and the Worker sends from `portfoliorank@n8builds.dev` through its `send_email` binding `SEND_EMAIL`.
   Check after the first deploy that the domain still shows as onboarded under Email, Email Sending in the dashboard; sending is in beta with a daily limit for new accounts, which the gate's caps (100 a day) stay under.
3. **Owner alerts by email:** your verified address is the Worker secret `OWNER_EMAIL` (sends to it are free).
   It is a secret, not a `vars` entry, so a deploy keeps it and the address stays out of the repository: `pass-env pipe portfolio-rank/OWNER_EMAIL -- npx wrangler secret put OWNER_EMAIL` (set on production 2026-11-13).
4. **Dispatch token:** `GITHUB_DISPATCH_TOKEN` on the production Worker (step "Secrets" above) also starts the grader's captures.
   Without it every grade stops after the free checks with the state `unavailable`.
   Never add it to staging.
5. **Gemini key:** `GEMINI_API_KEY` on the production Worker (already set) finishes queued grades in the hourly people-queue cron; the `GEMINI_API_KEY` repository secret (already set) grades on the runner.
   `grade.yml` uses the existing `TURSO_*` and `R2_*` repository secrets; nothing new.
6. **Switch it on** once the redesign's `/grade` and `/grade/[id]` pages are merged: set `GRADER_ENABLED` to `"true"` in `wrangler.jsonc` (production, and staging to try it there first without the dispatch token).

Turning it off again is the same variable: the API answers 404 and the five-minute cron does nothing; jobs, reports and emails waiting stay in the database until it is back on.

## How a change ships

Two workflows, so production and staging never overwrite each other:

1. **Production** (`.github/workflows/deploy.yml`, every push to main): migrates the production database, builds, deploys, then runs `node scripts/smoke.mjs https://portfoliorank.dev --moved-from https://portfoliorank.n8builds.dev`.
2. **Staging** (`.github/workflows/staging.yml`): staging runs main plus every open pull request labeled `staging`, merged onto main in pull request order.
   It runs again when main moves (so a merge to main, including the automatic data syncs, never wipes what is being tried), when a pull request gets or loses the label, when a labeled pull request gets new commits, and by hand (`gh workflow run staging.yml`).
   It migrates the staging database, builds with `NEXT_PUBLIC_SITE_ENV=staging`, deploys with `opennextjs-cloudflare deploy --env staging`, then runs `node scripts/smoke.mjs https://staging.portfoliorank.dev --staging --moved-from https://staging.portfoliorank.n8builds.dev`.
   The run's summary lists exactly what is on staging.
   A labeled pull request that does not merge cleanly onto main and the ones before it is left out, named in the summary and told in a comment; rebase it onto the one it conflicts with to bring it back.
   A stacked pull request brings its base along, so label the top of a stack; pushes to a stacked pull request start no run by themselves (GitHub runs only main's copy of the workflow for them), so run it by hand after pushing.

To try a pull request on staging: `gh pr edit <number> --add-label staging`; to take it off: `--remove-label staging`.
Nobody merges branches into a shared staging branch by hand any more.
The smoke check is read-only (GET requests and the start of a GitHub sign-in).
It checks that the home page renders the ranking, `/top` reads the database, a screenshot comes from R2, `/api/polls` answers JSON, robots.txt and the noindex signals match the site, sign-in redirects to GitHub with a client id and the site's own callback URL, and the old address answers a 301 to the same path.
CI (typecheck, lint, the Worker build for both environments, E2E) runs on every pull request into main before it can merge.
Until the `STAGING_TURSO_DATABASE_URL` and `STAGING_TURSO_AUTH_TOKEN` repository secrets exist, the staging workflow skips with a notice.
The release plan, the order open work lands in and the staging fidelity work are in [docs/audits/release-and-staging.md](docs/audits/release-and-staging.md).

## Staging

https://staging.portfoliorank.dev runs the same code as production on its own Worker, `portfolio-rank-staging` (`env.staging` in `wrangler.jsonc`).

- **Database:** its own Turso database, `portfolio-rank-staging`, filled once from a production backup with `scripts/restore-db.mjs`, which only restores into an empty database that is not production.
  The Worker reads it from its own `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` secrets, the deploy workflow from the `STAGING_TURSO_*` repository secrets.
- **Storage:** its own ISR cache bucket, `portfolio-rank-staging-opennext-cache`.
  It reads screenshots from the production `portfolio-rank` bucket; the Worker never writes to that bucket (the pipeline on GitHub Actions uploads captures).
- **No Gemini:** no Cron Triggers, and no `GEMINI_API_KEY` or `GITHUB_DISPATCH_TOKEN` secret, so staging never spends the production quota or starts production's GitHub jobs.
  Its Workflow is `portfolio-rank-night-staging`; nothing starts it, and a run started by hand skips without the key.
  Never add those two secrets to staging.
- **Launch features on:** `GRADER_ENABLED`, `GAMES_V2` and `RANKING_V2` are `"true"` in `env.staging` (production keeps all three `"false"`), so the launch can be walked through on staging first.
  The build reads all three for the Worker it builds (`next.config.ts` `launchSwitch`; the staging job sets `NEXT_PUBLIC_SITE_ENV=staging`), because the pages prerendered at build time (home, `/top` and its views, the sitemap) depend on them.
  Without crons, `RANKING_V2` only switches the leaderboard views; fill them with `scripts/recompute-ratings.mjs` run with the `portfolio-rank/STAGING_TURSO_*` pair.
  Without the dispatch token a grade asked for on staging stops after the free checks ("unavailable").
  To finish one by hand, set its job back to `capturing` in the staging database and run `scripts/grade-jobs.mjs` locally with the staging Turso pair and the Gemini key; it keeps the screenshots on disk without `R2_*`, so upload `hero.jpg` and `mobile.jpg` to `private/grades/<id>/` in the `portfolio-rank` bucket.
- **Not indexed:** the Worker answers robots.txt with `Disallow: /` and adds `X-Robots-Tag: noindex, nofollow` to every response (`worker/staging.ts`).
  The staging build adds a robots meta tag and a red "Staging" ribbon in the bottom-left corner (`components/StagingRibbon.tsx`).
- **Locked:** the Worker locks staging itself, ahead of Next.js (`worker/staging-gate.ts`, only when `SITE_ENV` is `staging`; production never runs it).
  It lets through `/healthz`, the web app manifest and its icons (browsers fetch the manifest without cookies; they are the same public files production serves), a request with the header `X-Staging-Gate` equal to the `STAGING_GATE_KEY` secret, and a request with the `__Host-staging_gate` cookie (an HMAC of an expiry, 30 days).
  `GET /__gate?key=<secret>` sets that cookie and redirects to `/`; every other request gets a plain 404 `not found`.
  Wrong keys count against 10 a day per address in the `rate_limits` table; a missing secret or database failure keeps the site locked.
  The key is `portfolio-rank/STAGING_GATE_KEY` in pass, the `STAGING_GATE_KEY` Actions secret (`scripts/smoke.mjs` sends it as the header) and a secret on the staging Worker: `pass-env pipe portfolio-rank/STAGING_GATE_KEY -- npx wrangler secret put STAGING_GATE_KEY --env staging`.
  To open staging in your browser without printing the key: `pass-env run -e STAGING_GATE_KEY=portfolio-rank/STAGING_GATE_KEY -- node scripts/open-staging.mjs`.
  Anything else that calls staging must send the same header.
- **Sign-in:** a separate GitHub OAuth app, "PortfolioRank (staging)", with the callback `https://staging.portfoliorank.dev/api/auth/callback/github`, so a staging secret never unlocks the production app.
- **Secrets on the staging Worker:** `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, each kept in pass as `portfolio-rank/STAGING_<NAME>` and sent with `pass-env pipe portfolio-rank/STAGING_<NAME> -- npx wrangler secret put <NAME> --env staging`.
  `PSI_API_KEY` is optional; without it PageSpeed runs on Google's keyless quota.
- **Sentry:** events from staging carry the environment `staging`.
- **Keeping the copy fresh:** the copy holds real votes and rater ids, and the nightly retention jobs do not run on staging.
  Replace it at least every 30 days, like a backup: the owner deletes the `portfolio-rank-staging` database in Turso, then steps 2, 3 and 5 below run again.

### Setting staging up (once)

Done already: the Worker, its custom domain, the cache bucket, `AUTH_SECRET` and `TURNSTILE_SECRET_KEY`.
Steps 1 to 3 and the database part of step 5 are done too (2026-11-10): the database holds the backup of 2026-11-10, and the Worker and the repository have the `TURSO_*` and `STAGING_TURSO_*` secrets.
That backup predates full backups (#72), so it filled only `votes`, `ratings` and eight columns of `portfolios` (no `meta`); refresh the copy from a newer backup ("Keeping the copy fresh" above) to get every table.
Left: step 4, the `AUTH_GITHUB_*` part of step 5, and step 6.
Until then the staging smoke check fails at "GitHub sign-in" (no client id), and that failure stops production deploys from main.
The owner runs the steps that need a Turso login or a new OAuth app; an agent can run the restore and `pass-env pipe` steps once the pass entries exist.

1. Log in to Turso in your own terminal: `! turso auth login`.
2. Create the database in the same group (and so the same region, `aws-us-east-2`, where the Worker runs) as production, and keep its address and a token in pass:
   ```bash
   turso db show portfolio-rank                  # note the group and location
   turso db create portfolio-rank-staging --group <that group>
   turso db show portfolio-rank-staging --url | pass-env set portfolio-rank/STAGING_TURSO_DATABASE_URL
   turso db tokens create portfolio-rank-staging | pass-env set portfolio-rank/STAGING_TURSO_AUTH_TOKEN
   ```
3. Copy last night's backup into it before anything else touches the database (the restore refuses a database with any table):
   ```bash
   npx wrangler r2 object get portfolio-rank-backups/backups/portfoliorank-$(date -u +%F).json.gz --remote --file=/tmp/pr-staging.json.gz
   pass-env run -e RESTORE_DATABASE_URL=portfolio-rank/STAGING_TURSO_DATABASE_URL -e RESTORE_AUTH_TOKEN=portfolio-rank/STAGING_TURSO_AUTH_TOKEN -e TURSO_DATABASE_URL=portfolio-rank/TURSO_DATABASE_URL -- node scripts/restore-db.mjs /tmp/pr-staging.json.gz
   ```
   The backup is scheduled for 05:00 UTC (it often starts hours later) and names the file by that UTC date, so before it lands the newest file is the previous day's: change the date in the first command.
   Passing the production `TURSO_DATABASE_URL` only arms the script's check that refuses to restore into production; nothing connects to it.
   Every table prints `N of N`, and the last line is `restored the snapshot of <time>`.
   Then delete `/tmp/pr-staging.json.gz`: it holds every vote with its rater id.
4. Create the staging OAuth app at https://github.com/settings/applications/new: name `PortfolioRank (staging)`, homepage `https://staging.portfoliorank.dev`, callback `https://staging.portfoliorank.dev/api/auth/callback/github`, device flow off.
   Then run `pass-env set portfolio-rank/STAGING_AUTH_GITHUB_ID` and paste the Client ID; press "Generate a new client secret", run `pass-env set portfolio-rank/STAGING_AUTH_GITHUB_SECRET` and paste it.
5. Send the four values to the staging Worker, and the database pair to the repository:
   ```bash
   for n in TURSO_DATABASE_URL TURSO_AUTH_TOKEN AUTH_GITHUB_ID AUTH_GITHUB_SECRET; do
     pass-env pipe portfolio-rank/STAGING_$n -- npx wrangler secret put $n --env staging
   done
   pass-env pipe portfolio-rank/STAGING_TURSO_DATABASE_URL -- gh secret set STAGING_TURSO_DATABASE_URL
   pass-env pipe portfolio-rank/STAGING_TURSO_AUTH_TOKEN -- gh secret set STAGING_TURSO_AUTH_TOKEN
   ```
6. Run `gh workflow run deploy.yml` (or merge the next change): the staging job deploys and its smoke check passes, then production deploys.
   Sign in on staging once to check the round trip through GitHub.

## Reading the logs

Workers Logs keeps every request (`observability` in `wrangler.jsonc`, `head_sampling_rate: 1`).
In the Cloudflare dashboard, open Workers & Pages, then the `portfolio-rank` Worker, then Logs.
To stream them live, run `npx wrangler tail portfolio-rank --format pretty`.
`--search` matches log messages only, not request URLs, so use `--status error` or no filter to see requests.
Failures log one JSON line with `event`, `reason` and `route`: Auth.js errors as `auth_error` with the error type (such as `CallbackRouteError` or `InvalidCheck`), a masked message and the provider's OAuth error code, and errors thrown in pages, route handlers or middleware as `unhandled_exception` with the route (`instrumentation.ts`).
They never carry secrets, tokens, OAuth codes or state values, cookies, emails or other personal data.

## Original Vercel setup (retired 2026-11, kept for reference)

Target: Vercel (app) + Turso (votes, ratings, portfolios, diagnostic caches) + Auth.js
(GitHub login) + Cloudflare R2 (screenshots). All free tier.

## Status (2026-06-20): fully deployed

All of it is live in production (portfoliorank.vercel.app). Persistence runs on libSQL
via `lib/db.ts` — a local file (`data/portfoliorank.db`) in dev, Turso in prod; tables
auto-create on first use (`votes`, `ratings`, `portfolios`, `cache`, `likes`, `lists`, `list_items`). Auth (GitHub login,
vote tiers, rate limits) is shipped. Screenshots are captured by Playwright and served
from Cloudflare R2 (mShots is only a fallback now). The whole pipeline runs itself via
daily GitHub Actions — see **AUTOMATION.md**.

## Steps (one-time)

1. **Turso** — https://turso.tech (free: 9 GB storage, 1B row reads/mo)
   ```bash
   # interactive login — run yourself: ! turso auth login   (or brew/curl install first)
   turso db create portfolio-rank
   turso db show portfolio-rank --url        # → TURSO_DATABASE_URL
   turso db tokens create portfolio-rank     # → TURSO_AUTH_TOKEN
   ```

2. **Env vars** — the app (`.env.local` for dev, Vercel project settings for prod):
   ```
   TURSO_DATABASE_URL=libsql://...
   TURSO_AUTH_TOKEN=...
   PSI_API_KEY=...        # console.cloud.google.com → enable PageSpeed Insights API → key
   AUTH_SECRET=...        # openssl rand -base64 33
   AUTH_GITHUB_ID=...     # GitHub OAuth app (callback → /api/auth/callback/github)
   AUTH_GITHUB_SECRET=...
   SHOTS_BASE_URL=/shots   # the app links captures on its own domain (next dev: app/shots)
   ```
   The pipeline + GitHub Actions also need these as **repo secrets** (and in `.env.local`
   for local runs): `GEMINI_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `SHOTS_BASE_URL`. AUTOMATION.md lists which
   workflow uses what.

3. **Vercel** — import `n8watkins/portfolio-rank` at vercel.com/new (or `vercel` CLI),
   set the env vars, deploy. Custom domain later.

4. **Seed production** — `TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/migrate-json-to-db.mjs`
   ports any local votes up (optional; skips cleanly if no JSON files remain).

## Scalability picture (free-tier limits vs. expected load)

| Piece | Free limit | A viral day (~50k visitors, ~200k votes) |
|---|---|---|
| Vercel bandwidth/functions | 100 GB/mo, 1M invocations | fine — pages are small, API responses are tiny JSON |
| Turso | 9 GB storage, 1B row reads/mo, 25M writes/mo | a vote is 2 writes → 400k writes ≈ 1.6% of monthly quota in a day. Years of headroom on storage |
| Auth.js | self-hosted, no vendor limit | fine |
| PSI API | 25k/day with free key | fine (results cached 30 days) |
| Gemini (AI judge) | free-tier req/day | **the real ceiling** — grading is budget-capped + voting is 30/day, both abort cleanly on quota; staggered Actions avoid self-collision |
| Screenshots — own (R2) | 10 GB storage, free egress | live: ~570 MB of serve-frames + ~0.2 MB/day DB backups — far under cap; mShots is only a fallback now |

Bottom line: votes/DB scale effortlessly on Turso's free tier and screenshots are owned
on R2; the only metered resource to watch is the shared Gemini daily budget, which the
Actions are capped to respect.
