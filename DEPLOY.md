# Deploying PortfolioRank

## Cloudflare Workers

The app runs on a Cloudflare Worker built with OpenNext (`@opennextjs/cloudflare`) at https://portfoliorank.n8builds.dev; `wrangler.jsonc` and `open-next.config.ts` hold the config.
The custom domain is a `routes` entry in `wrangler.jsonc`, so every deploy keeps it, and the workers.dev address is off.

- **Deploy by hand:** `npm run deploy` (builds, then `wrangler deploy`).
  The build prerenders the home page, so run it with `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `SHOTS_BASE_URL=/shots` in the environment, or the first render after a deploy shows no ranking until ISR refreshes it (5 minutes).
- **Deploy from GitHub:** `.github/workflows/deploy.yml` ships every push to main, staging first ("How a change ships" below), once the repository has a `CLOUDFLARE_API_TOKEN` secret (an API token with the "Edit Cloudflare Workers" permission); until then it skips the deploy with a notice.
- **Preview locally:** `npm run preview` runs the built Worker on workerd, reading secrets from `.dev.vars`.
- **Secrets** (`npx wrangler secret put <NAME>`, never in a file): `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `PSI_API_KEY`, plus two for the end-of-day run ([AUTOMATION.md](AUTOMATION.md#end-of-day-run)):
  `GEMINI_API_KEY` (send it with `pass-env pipe portfolio-rank/GEMINI_API_KEY -- npx wrangler secret put GEMINI_API_KEY`) and `GITHUB_DISPATCH_TOKEN` (a fine-grained token for `n8watkins/portfolio-rank` only with "Actions: Read and write"; `pass-env pipe portfolio-rank/GITHUB_DISPATCH_TOKEN -- npx wrangler secret put GITHUB_DISPATCH_TOKEN`), which also starts "grade my portfolio" captures.
  Optional: `TURNSTILE_SECRET_KEY` turns on Cloudflare Turnstile for poll votes, grade requests and report emails (AUTOMATION.md "Polls", "Grade my portfolio" and "Games, badges, claims, live stats and reports"); without it the check is skipped.
  Email (grade reports, report links, owner alerts) goes through the `send_email` binding `SEND_EMAIL` from the `EMAIL_FROM` variable; owner alerts need the `OWNER_EMAIL` variable ("Grade my portfolio: owner steps" below).
  Optional: `GITHUB_API_TOKEN` (a fine-grained token with no permissions, public data only) raises the GitHub API rate limit for claims and the live stats.
  Without `GITHUB_DISPATCH_TOKEN` the nightly checks are not started from Cloudflare (one log line says so) and their GitHub schedule runs as the fallback.
  `SHOTS_BASE_URL` and `AUTH_URL` (the site's address) are plain variables in `wrangler.jsonc`; `lib/site.ts` holds the same address for canonical URLs, share links and the sitemap.
  So are the end-of-day run's switches (`RANKING_V2`, `RUBRIC_REGRADE`, `GEMINI_RPM`, `NIGHTLY_REFRESH`), `ADMIN_GITHUB_LOGIN`, `GRADER_ENABLED`, `GAMES_V2` and `EMAIL_FROM`: change them in `wrangler.jsonc` through a pull request, since a deploy resets variables to what the file says.
- **Games (`GAMES_V2`, off):** the games, badges, claims, live stats and report routes answer 404 until the variable `GAMES_V2` is `"true"` in `wrangler.jsonc` (both environments).
  Report links by email go through the same email gate and `SEND_EMAIL` binding as grade reports, so they need nothing more.
  Optional: `EARLY_SUPPORTER_UNTIL` (`YYYY-MM-DD`, Pacific), the last day the Early supporter badge is given.
- **Cron Triggers and the Workflow:** `triggers.crons` and `workflows` in `wrangler.jsonc`; `npx wrangler triggers deploy` is not needed, a deploy registers them (they can take up to 15 minutes to reach every location).
  Check them in the dashboard (Workers & Pages, portfolio-rank, Settings, Triggers) or with `npx wrangler workflows instances list portfolio-rank-night`.
- **Screenshots and favicons:** the Worker answers `/shots/<shot_key>/<file>` and `/favicon/<domain>` itself, before the app (`worker/assets.ts`), from the edge cache when it can.
  Screenshots come from the `SHOTS` binding (the `portfolio-rank` R2 bucket the pipeline uploads to); pages add `?v=<capture time>`, so a recapture gets a new URL and each version is served with `Cache-Control: public, max-age=31536000, immutable`.
  Favicons come from Google's favicon service for roster domains only, with a placeholder when a site has none, cached for a week.
  The bucket's public r2.dev address is for the pipeline (the `SHOTS_BASE_URL` repository secret); pages never link it.
- **Database schema:** `lib/schema.mjs` holds every table, index and added column; the deploy workflow runs `node scripts/migrate.mjs` before it builds.
  At runtime `ensureSchema()` only checks the recorded version (one query per isolate) and migrates a database that is behind, such as a fresh local file.
  To change the schema, add the statement or column there and bump `SCHEMA_VERSION`.
- **Sentry source maps:** add the `SENTRY_AUTH_TOKEN` secret (a Sentry auth token with project release access) and the `SENTRY_ORG` and `SENTRY_PROJECT` repository variables.
  The deploy then builds browser source maps, uploads them for the release (the commit SHA) and deletes them before publishing; without those settings it skips the step.
- **ISR:** the home page (`revalidate = 300`) is cached in the `portfolio-rank-opennext-cache` R2 bucket, and a Durable Object queue deduplicates its background re-renders.
  The deploy log prints "A DurableObjectNamespace in the config referenced the class "DOQueueHandler", but no such Durable Object class is exported from the worker".
  It is a false alarm: `opennextjs-cloudflare deploy` starts a local Miniflare proxy (wrangler's `getPlatformProxy`) only to read the config's variables, and that proxy runs none of our code.
  The uploaded Worker does export the class (`worker/index.ts`), and CI proves it on every change (`scripts/check-worker-exports.mjs` on the dry-run bundle).
- **GitHub sign-in:** the OAuth app's callback URL is `https://portfoliorank.n8builds.dev/api/auth/callback/github`; staging has its own OAuth app ("Staging" below).
- **Actions:** the pipeline jobs talk to Turso and R2 directly and are unaffected.
  `prewarm.yml` calls the site's API at the `PROD_BASE_URL` repository variable (`https://portfoliorank.n8builds.dev`).

## Grade my portfolio: owner steps

The back end ships switched off (`GRADER_ENABLED` is `"false"` in `wrangler.jsonc`, AUTOMATION.md "Grade my portfolio").
These steps can be done any time before it is switched on; each one is safe on its own.

1. **Turnstile widget** (an agent couldn't create it: the Cloudflare connection lacks write access to Turnstile).
   In the Cloudflare dashboard, open Turnstile, Add widget: name `PortfolioRank`, hostnames `portfoliorank.n8builds.dev`, `staging.portfoliorank.n8builds.dev` and `localhost`, widget mode **Managed**, no pre-clearance.
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
3. **Owner alerts by email:** set your verified address as the Worker variable `OWNER_EMAIL` (sends to it are free).
   Add it to `wrangler.jsonc` `vars` in a pull request, since a deploy resets variables to what the file says.
4. **Dispatch token:** `GITHUB_DISPATCH_TOKEN` on the production Worker (step "Secrets" above) also starts the grader's captures.
   Without it every grade stops after the free checks with the state `unavailable`.
   Never add it to staging.
5. **Gemini key:** `GEMINI_API_KEY` on the production Worker (already set) finishes queued grades in the hourly people-queue cron; the `GEMINI_API_KEY` repository secret (already set) grades on the runner.
   `grade.yml` uses the existing `TURSO_*` and `R2_*` repository secrets; nothing new.
6. **Switch it on** once the redesign's `/grade` and `/grade/[id]` pages are merged: set `GRADER_ENABLED` to `"true"` in `wrangler.jsonc` (production, and staging to try it there first without the dispatch token).

Turning it off again is the same variable: the API answers 404 and the five-minute cron does nothing; jobs, reports and emails waiting stay in the database until it is back on.

## How a change ships

A merge to main runs `.github/workflows/deploy.yml`, which has two jobs in a row:

1. **Staging:** migrates the staging database, builds with `NEXT_PUBLIC_SITE_ENV=staging`, deploys with `opennextjs-cloudflare deploy --env staging`, then runs `node scripts/smoke.mjs https://staging.portfoliorank.n8builds.dev --staging`.
2. **Deploy (production):** runs only when staging passed; it migrates, builds and deploys production as before, then runs `node scripts/smoke.mjs https://portfoliorank.n8builds.dev`.

A failed staging deploy or smoke check stops the run before production.
The smoke check is read-only (GET requests and the start of a GitHub sign-in).
It checks that the home page renders the ranking, `/top` reads the database, a screenshot comes from R2, `/api/polls` answers JSON, robots.txt and the noindex signals match the site, and sign-in redirects to GitHub with a client id and the site's own callback URL.
To try a branch on staging before it merges, run the Deploy workflow by hand on that branch (`gh workflow run deploy.yml --ref <branch>`): it deploys staging only, and the next merge to main puts main back.
Pull requests do not deploy on their own: parallel PRs would overwrite each other on the one staging site, and CI (typecheck, lint, the Worker build for both environments, E2E) already runs on every PR.
Until the `STAGING_TURSO_DATABASE_URL` and `STAGING_TURSO_AUTH_TOKEN` repository secrets exist, the staging job skips with a notice and production deploys without it.

## Staging

https://staging.portfoliorank.n8builds.dev runs the same code as production on its own Worker, `portfolio-rank-staging` (`env.staging` in `wrangler.jsonc`).

- **Database:** its own Turso database, `portfolio-rank-staging`, filled once from a production backup with `scripts/restore-db.mjs`, which only restores into an empty database that is not production.
  The Worker reads it from its own `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` secrets, the deploy workflow from the `STAGING_TURSO_*` repository secrets.
- **Storage:** its own ISR cache bucket, `portfolio-rank-staging-opennext-cache`.
  It reads screenshots from the production `portfolio-rank` bucket; the Worker never writes to that bucket (the pipeline on GitHub Actions uploads captures).
- **No Gemini:** no Cron Triggers, and no `GEMINI_API_KEY` or `GITHUB_DISPATCH_TOKEN` secret, so staging never spends the production quota or starts production's GitHub jobs.
  Its Workflow is `portfolio-rank-night-staging`; nothing starts it, and a run started by hand skips without the key.
  Never add those two secrets to staging.
- **Not indexed:** the Worker answers robots.txt with `Disallow: /` and adds `X-Robots-Tag: noindex, nofollow` to every response (`worker/staging.ts`).
  The staging build adds a robots meta tag and a red "Staging" ribbon in the bottom-left corner (`components/StagingRibbon.tsx`).
- **Sign-in:** a separate GitHub OAuth app, "PortfolioRank (staging)", with the callback `https://staging.portfoliorank.n8builds.dev/api/auth/callback/github`, so a staging secret never unlocks the production app.
- **Secrets on the staging Worker:** `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, each kept in pass as `portfolio-rank/STAGING_<NAME>` and sent with `pass-env pipe portfolio-rank/STAGING_<NAME> -- npx wrangler secret put <NAME> --env staging`.
  `PSI_API_KEY` is optional; without it PageSpeed runs on Google's keyless quota.
- **Sentry:** events from staging carry the environment `staging`.
- **Keeping the copy fresh:** the copy holds real votes and rater ids, and the nightly retention jobs do not run on staging.
  Replace it at least every 30 days, like a backup: the owner deletes the `portfolio-rank-staging` database in Turso, then steps 2, 3 and 5 below run again.

### Setting staging up (once)

Done already: the Worker, its custom domain, the cache bucket and `AUTH_SECRET`.
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
   pass-env run -e RESTORE_DATABASE_URL=portfolio-rank/STAGING_TURSO_DATABASE_URL -e RESTORE_AUTH_TOKEN=portfolio-rank/STAGING_TURSO_AUTH_TOKEN -- node scripts/restore-db.mjs /tmp/pr-staging.json.gz
   ```
   Every table prints `N of N`, and the last line is `restored the snapshot of <time>`.
   Then delete `/tmp/pr-staging.json.gz`: it holds every vote with its rater id.
4. Create the staging OAuth app at https://github.com/settings/applications/new: name `PortfolioRank (staging)`, homepage `https://staging.portfoliorank.n8builds.dev`, callback `https://staging.portfoliorank.n8builds.dev/api/auth/callback/github`, device flow off.
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
