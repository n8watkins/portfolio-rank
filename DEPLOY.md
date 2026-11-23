# Deploying PortfolioRank

## Cloudflare Workers

The app runs on a Cloudflare Worker built with OpenNext (`@opennextjs/cloudflare`) at https://portfoliorank.dev; `wrangler.jsonc` and `open-next.config.ts` hold the config.
The custom domains are `routes` entries in `wrangler.jsonc`, so every deploy keeps them, and the workers.dev address is off.
The Worker also answers at `www.portfoliorank.dev` and at the old address `portfoliorank.n8builds.dev` (until 2026-11), only to redirect them to the same path on https://portfoliorank.dev (`worker/canonical-host.ts`: 301 for GET and HEAD, 308 for other methods, so an API caller on the old address keeps working while it moves).
There is no staging site (removed 2026-11-22, [docs/DECISIONS.md](docs/DECISIONS.md) "No staging site"); "Trying a change" below says how changes are tried.

- **Deploy by hand:** `npm run deploy` (builds, then `wrangler deploy`).
  The build prerenders the home page, so run it with `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `SHOTS_BASE_URL=/shots` in the environment, or the first render after a deploy shows no ranking until ISR refreshes it (5 minutes).
- **Deploy from GitHub:** `.github/workflows/deploy.yml` ships each release to production ("How a change ships" below), once the repository has a `CLOUDFLARE_API_TOKEN` secret (an API token with the "Edit Cloudflare Workers" permission); until then it skips the deploy with a notice.
- **Preview locally:** `npm run preview` runs the built Worker on workerd, reading secrets from `.dev.vars`.
- **Secrets** (`npx wrangler secret put <NAME>`, never in a file): `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `PSI_API_KEY`, plus two for the end-of-day run ([AUTOMATION.md](AUTOMATION.md#end-of-day-run)):
  `GEMINI_API_KEY` (send it with `pass-env pipe portfolio-rank/GEMINI_API_KEY -- npx wrangler secret put GEMINI_API_KEY`) and `GITHUB_DISPATCH_TOKEN` (a fine-grained token for `n8watkins/portfolio-rank` only with "Actions: Read and write"; `pass-env pipe portfolio-rank/GITHUB_DISPATCH_TOKEN -- npx wrangler secret put GITHUB_DISPATCH_TOKEN`), which also starts "grade my portfolio" captures.
  Required: `TURNSTILE_SECRET_KEY` for Cloudflare Turnstile on poll votes, grade requests and report emails (AUTOMATION.md "Polls", "Grade my portfolio" and "Games, badges, claims, live stats and reports"); without it those requests are refused, and the token's hostname must match the Worker's `SITE_URL`.
  Email (grade reports, report links, owner alerts) goes through the `send_email` binding `SEND_EMAIL` from the `EMAIL_FROM` variable; owner alerts need the `OWNER_EMAIL` secret ("Grade my portfolio: owner steps" below).
  Email sign-in links go through the shared mailroom: the service binding `MAILROOM` (`wrangler.jsonc` `services`, app `portfoliorank`); the mailroom must list the kind `signin` for that app and be deployed first (n8watkins/mailroom, `deployments/n8builds/apps.ts`), or every sign-in email is refused and the form says email isn't available.
  Optional: `GITHUB_API_TOKEN` (a fine-grained token with no permissions, public data only) raises the GitHub API rate limit for claims and the live stats.
  Without `GITHUB_DISPATCH_TOKEN` the nightly checks and the hourly re-check of sites that stopped working are not started from Cloudflare (one log line says so) and their GitHub schedules run as the fallback.
  `SHOTS_BASE_URL` and `SITE_URL` (the site's one address setting) are plain variables in `wrangler.jsonc`.
  `SITE_URL` gives canonical URLs, share links, the sitemap, robots.txt, RSS, email links, the origin and Turnstile checks and Auth.js's callback URL (`auth.ts` copies it to `AUTH_URL`); pages built ahead of time use the same address from `lib/site.ts`, and `tests/site-url.test.mjs` keeps the two equal.
  So are the end-of-day run's switches (`RANKING_V2`, `GEMINI_RPM`, `NIGHTLY_REFRESH`), `ADMIN_GITHUB_ID` (the admin's numeric GitHub id), `MIN_GITHUB_ACCOUNT_AGE_DAYS`, `GRADER_ENABLED`, `GAMES_V2`, `EMAIL_FROM` and the content engine's ceiling (`CONTENT_MODE`, `CONTENT_DRAFTS_PER_WEEK`; the owner schedules within it on `/admin/blog`): change them in `wrangler.jsonc` through a pull request, since a deploy resets variables to what the file says.
- **Games (`GAMES_V2`, off):** the games, badges, claims, live stats and report routes answer 404 until the variable `GAMES_V2` is `"true"` in `wrangler.jsonc`.
  Report links by email go through the same email gate and `SEND_EMAIL` binding as grade reports, so they need nothing more.
  Optional: `EARLY_SUPPORTER_UNTIL` (`YYYY-MM-DD`, Pacific), the last day the Early supporter badge is given.
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
  OpenNext keeps each build's entries under `incremental-cache/<build id>/` and a Worker reads only its own build's folder, so after the smoke check the deploy removes every build folder but the newest two (`scripts/prune-build-cache.mjs`).
  It is not an R2 lifecycle rule because the live build's prerendered entries are written once, at deploy, and an age rule would expire them after enough days without a deploy.
  A rollback with `wrangler rollback` to a version older than the previous one finds no cache, so its first requests render the pages again.
  The deploy log prints "A DurableObjectNamespace in the config referenced the class "DOQueueHandler", but no such Durable Object class is exported from the worker".
  It is a false alarm: `opennextjs-cloudflare deploy` starts a local Miniflare proxy (wrangler's `getPlatformProxy`) only to read the config's variables, and that proxy runs none of our code.
  The uploaded Worker does export the class (`worker/index.ts`), and CI proves it on every change (`scripts/check-worker-exports.mjs` on the dry-run bundle).
- **GitHub sign-in:** the OAuth app's homepage is `https://portfoliorank.dev` and its callback URL `https://portfoliorank.dev/api/auth/callback/github`.
- **Actions:** the pipeline jobs talk to Turso and R2 directly and are unaffected.
  `prewarm.yml` calls the site's API at the `PROD_BASE_URL` repository variable (`https://portfoliorank.dev`).

## Grade my portfolio: owner steps

The back end ships switched off (`GRADER_ENABLED` is `"false"` in `wrangler.jsonc`, AUTOMATION.md "Grade my portfolio").
These steps can be done any time before it is switched on; each one is safe on its own.

1. **Turnstile widget** (done 2026-11-10: the widget `PortfolioRank` exists and `TURNSTILE_SECRET_KEY` is on the Worker; the site key `0x4AAAAAAF8GDSY7kmBfRpoD` goes into `wrangler.jsonc` with the redesign).
   An agent couldn't create it: the Cloudflare connection lacks write access to Turnstile.
   In the Cloudflare dashboard, open Turnstile, Add widget: name `PortfolioRank`, hostnames `portfoliorank.dev`, `portfoliorank.n8builds.dev` and `localhost`, widget mode **Managed**, no pre-clearance.
   The pages render it with `appearance: "interaction-only"` and execution on page load, so most visitors never see it; the actions are `grade`, `grade-email` and `poll-vote`.
   Keep the secret in pass and send it to the Worker without it ever being shown:
   ```bash
   ! pass-env set portfolio-rank/TURNSTILE_SECRET_KEY        # paste the widget's secret key
   pass-env pipe portfolio-rank/TURNSTILE_SECRET_KEY -- npx wrangler secret put TURNSTILE_SECRET_KEY
   ```
   From then on every grade request, report-email request and poll vote needs a Turnstile token, so the redesign's forms must render the widget before this goes on in production.
   Put the public site key in `wrangler.jsonc` as the variable `TURNSTILE_SITE_KEY` in the redesign's pull request, where the pages read it.
2. **Email sender:** nothing to set up for the sender itself: `n8builds.dev` is onboarded for Cloudflare Email Sending (Wren sends from it), and the Worker sends from `portfoliorank@n8builds.dev` through its `send_email` binding `SEND_EMAIL`.
   Check after the first deploy that the domain still shows as onboarded under Email, Email Sending in the dashboard; sending is in beta with a daily limit for new accounts, which the gate's caps (100 a day) stay under.
3. **Owner alerts by email:** your verified address is the Worker secret `OWNER_EMAIL` (sends to it are free).
   It is a secret, not a `vars` entry, so a deploy keeps it and the address stays out of the repository: `pass-env pipe portfolio-rank/OWNER_EMAIL -- npx wrangler secret put OWNER_EMAIL` (set on production 2026-11-13).
4. **Dispatch token:** `GITHUB_DISPATCH_TOKEN` on the production Worker (step "Secrets" above) also starts the grader's captures.
   Without it every grade stops after the free checks with the state `unavailable`.
5. **Gemini key:** `GEMINI_API_KEY` on the production Worker (already set) finishes queued grades in the hourly people-queue cron; the `GEMINI_API_KEY` repository secret (already set) grades on the runner.
   `grade.yml` uses the existing `TURSO_*` and `R2_*` repository secrets; nothing new.
6. **Switch it on** once the redesign's `/grade` and `/grade/[id]` pages are merged: set `GRADER_ENABLED` to `"true"` in `wrangler.jsonc`.

Turning it off again is the same variable: the API answers 404 and the five-minute cron does nothing; jobs, reports and emails waiting stay in the database until it is back on.

## How a change ships

A merge to main deploys nothing.
Production is the release that was last deployed and smoke checked, and changes only when a release is deployed.

- **Merge** a pull request into main: production does not change.
- **Deploy** with `npm run release -- --push` (RELEASING.md "Cutting a release") once the merges on main are ready to go out together.
  It lists what will ship (`--dry-run` shows the list without cutting anything), opens the release pull request, waits for CI on it, tags the merged commit `vX.Y.Z`, and the tag deploys production.
- **Go back** to an older release: `gh workflow run deploy.yml -f code=vX.Y.Z`.
  It stays in force, for the site and the jobs, until another release is deployed.
  Schema changes are additive, so older code runs on the newer database.

The `production` branch is the record of what production runs.
The last step of a deploy moves it to the release's commit, only after the smoke check passed, and nothing else writes it.
So a release whose deploy failed (the data check, the migration, the build or the smoke check) is not production: the branch stays on the previous release, the run is red, and a person decides.
If the failure came after the new site went live (a failed smoke check), deploy the previous tag again to put the site back as well.
Only a plain `vX.Y.Z` tag on a commit that is on main is deployed.

"Production" means the same code everywhere:

- **The site** is deployed from the release.
- **The scheduled jobs** that work on the production database (the nightly sync and capture, grading, the health check, discovery, backups and the others) run that release's code too, through `.github/actions/release-code`, although GitHub starts them from main.
  They read the `production` branch, so a merged pipeline change reaches them once its release has been deployed, with the database changes it needs, not on the night it merged and not when its tag appears.
  A failure to reach GitHub fails the job; it never falls back to main's code.
  To try a branch's job by hand, run its workflow with `code=checkout`.
- **The workflow files** are the exception: GitHub always runs main's copy of a file in `.github/workflows/`, so an edit to one is live when it merges.
  Keep them thin, and put logic in the scripts they call.
  A new step that calls a script production's release does not have fails every night until that release is deployed, so a pull request adding one makes the step skip while the script is missing (`if [ -f pipeline/new-step.mjs ]`).
- **The data** (`data/`, the portfolio list) always comes from main, where the nightly sync puts it.
  Pages import the list into the build, so a change to `data/` on main rebuilds production's release over the new data and deploys it, with no unreleased code.
  That build first runs `node scripts/check-data.mjs`, the released code's own check of what it can read, kept no stricter than the code that reads each file; when it fails nothing is deployed, the site stays as it was and the run fails.
  A pull request that changes both the data's shape and the code reading it must keep the old code able to read the new data, or its data waits for the release.

Because main is always the next release, a change visitors can see either sits behind a flag that is off in production, or was tried as "Trying a change" below says before it merged.
Flags live in `wrangler.jsonc`, so turning one on in production is a merge and then a release.
Until the first release has been deployed (`npm run release -- --baseline` tags it, and the tag deploys it), there is no `production` branch, and the site and the jobs keep running main's code: a change to `data/` deploys main as it is, as before.

One workflow deploys: **Production** (`.github/workflows/deploy.yml`; a release tag, a change to `data/` on main, or by hand) migrates the production database, builds, deploys, then runs `node scripts/smoke.mjs https://portfoliorank.dev --moved-from https://portfoliorank.n8builds.dev`.

The smoke check is read-only (GET requests and the start of a GitHub sign-in).
It checks that the home page renders the ranking, `/top` reads the database, a screenshot comes from R2, `/api/polls` answers JSON, robots.txt is open and nothing says noindex, sign-in redirects to GitHub with a client id and the site's own callback URL, and the old address answers a 301 to the same path.
What a visitor cannot see is checked in the unit tests instead, on every pull request and release (`tests/production-config.test.mjs`): the Worker's job crons are production's triggers, `SITE_ENV` is `production`, and production runs on the default email caps.
Those three ran only inside the staging tests until #282.
CI runs on every pull request into main before it can merge, sized to the change (`.github/workflows/ci.yml`, `scripts/ci-lanes.mjs`).
It follows the site's code to sort the changed files: docs that no code reads run nothing; code the site cannot reach (a script, the nightly capture, a workflow file, a unit test) runs typecheck, lint and the unit tests; anything the site reaches, `data/`, and anything unknown runs everything, with the Worker build and the browser tests (E2E).
It errs towards everything: a file is the site's when the site or a site test imports it, names its path in a string, or builds a path into its folder.
A release pull request always runs everything, which is the full check on the batch before production deploys.
`npm run test:unit` runs the tests that need no running site (about two minutes, no build); `npm run test:e2e` builds the app and runs every test, or with `E2E_TESTS=site` only the ones that need it, as CI does.
A test file needs the running site when it reads one of `scripts/test-e2e.sh`'s `E2E_` variables; every other top-level `tests/*.test.mjs` is a unit test, and a test in a subfolder is run by neither, so keep tests at the top level.
The main ruleset still requires `typecheck`, `Worker build` and `E2E` by name: GitHub counts a job CI skipped as passed, the unit tests run inside `typecheck`, and a job is skipped only when the sorting answered "false" for it, so a sorting that fails runs every job.
The release plan and the order open work lands in are in [docs/audits/release-and-staging.md](docs/audits/release-and-staging.md), written while staging existed.

## Trying a change

There is no staging site: the owner removed it on 2026-11-22 ("Let's just kill staging, we're just gonna get rid of staging completely", [docs/DECISIONS.md](docs/DECISIONS.md) "No staging site").
A change is tried in this order:

1. **Locally:** `npm run dev` against a local database file, `npm run test:unit`, and `npm run test:e2e`, which builds the app and runs every test on a throwaway local database (`scripts/test-e2e.sh`).
2. **In CI:** every pull request runs typecheck, lint, the unit tests, the Worker build and bundle, and the end-to-end suite, sized to the change ("How a change ships" above).
3. **On production, small and on the owner's word:** what only real data or Cloudflare can show is tried on production as a small trial.
   A new feature ships behind its switch in `wrangler.jsonc`, off, and is turned on when the owner says so; a pipeline step is run by hand on a few sites with `code=checkout` on its workflow; a scheduled job is run once by hand before its schedule is turned on.
   Each release is smoke checked right after its deploy, and going back is `gh workflow run deploy.yml -f code=vX.Y.Z`.

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
