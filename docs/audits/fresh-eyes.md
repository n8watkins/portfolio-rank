# Fresh-eyes audit (2026-11-12)

This is a read-only review of `preview/staging-all` (3711a91) and the live sites, done the way a senior engineer would spend a first day on the codebase.
Some areas were left out on purpose because other reviews cover them: Gemini prompting, release and staging process, free-tier limits, the blog engine, the discovery pipeline, and bots, SEO and caching.
The same report, with more layout, is the artifact "PortfolioRank Fresh-Eyes Audit".

Most of the code holds up well under a first review.
Every admin page and API checks the admin's numeric GitHub id, mutating routes check Origin, Turnstile fails closed, the SSRF guard re-checks every redirect hop, and the nightly backup has run every day.
The real gaps are in finding out when something breaks.
There is also one route that still lets a visitor start our Gemini key, and the backups and the missing privacy page break promises the privacy draft makes.

## Prioritized action plan

| # | Do | Closes | Size |
| --- | --- | --- | --- |
| 1 | Set `OWNER_EMAIL` in production vars, add a dead-man alert to the hourly cron, and stop swallowing `NIGHT.create` errors | H1, H2, L3 | S |
| 2 | Make the free-tier finish queue-only, and add a test that no visitor route calls Gemini | H3 | S |
| 3 | Publish `/privacy` and `/removal`, and add a 35-day lifecycle rule to the backup bucket | H4, M1 | M |
| 4 | Move all tables into `lib/schema.mjs`, make the version write monotonic, and add a CI version check | M2, M3 | M |
| 5 | Isolate each hourly task, throw on a missing Turso URL, triage Sentry and add an alert rule | M6, L1 | S |
| 6 | Fix the "private" profile copy, cap unclaimed adds, and always filter the sitemap to graded sites | M4, M8 | S |
| 7 | Give the admin short sessions and add per-account session revocation | M5 | M |
| 8 | Move to a nonce CSP, allow-list test seams, give staging its own mailroom apps, and fix contrast and CLS | M7, L2, L4, L5 | M |

## P0 status (STRATEGY.md, approved 2026-11-13)

| P0 item | Status |
| --- | --- |
| Alerts: `OWNER_EMAIL` on production | Done 2026-11-13: a Worker secret from `pass-env` (`portfolio-rank/OWNER_EMAIL`), so deploys keep it. |
| Alerts: dead-man check for a missed or stuck night; only a duplicate id is "already exists" (H1, H2, L3) | Merged: #153. |
| Alerts: prove delivery end to end | #160 adds `/admin/alerts` with a Send test alert button; after deploy the owner presses it once (production had never sent an email). |
| Privacy: `/privacy`, `/terms`, `/removal`, footer links (H4) | #155: pages name n8builds, with email and @n8watkins on X. |
| Privacy: backups expire after 35 days (M1) | Done 2026-11-13: R2 rule `expire-backups-35d` on `portfolio-rank-backups` (prefix `backups/`); the history uploaded 2026-11-03 expires around 2026-12-08. |
| Visitor-to-Gemini gap in "use the free tier" (H3) | #159: the route only enqueues; `tests/gemini-reach.test.mjs` fails if any visitor route can reach Gemini on our key. |
| Workers CPU | Measured: account at 14.6M of 30M ms on 2026-11-13, on pace for 35.8M. portfolio-rank #156 (anonymous session answered by the Worker), n8builds-web #201 (Sentry relay before Next). Page caching is the edge-caching lane's. |
| Owner goals (added 2026-11-13) | #161: weekly check, one email with an .ics invite per goal, `GET /api/admin/goals`. |

## Medium and low status (2026-11-13)

Each item was checked against `main` (592ae06) first; every fix is its own PR based on `main`, waiting for the release lane.
All of them were green in CI on 2026-11-13. #176 (subpixel tolerance in the 44px target checks) fixes a flake one of those runs hit.

| Finding | PR | Status |
| --- | --- | --- |
| M1 Backups kept forever | - | Done (P0 above): R2 rule `expire-backups-35d`. |
| M2 Tables outside the schema | #165 | Open. Pipeline and ranking tables move into `lib/pipeline-schema.mjs` and `lib/ranking/schema.mjs`, which `lib/schema.mjs` includes; the next deploy's migration adds `night_runs`, `owner_alerts`, `gemini_daily` and the rest to staging. A test fails when any module creates a table the schema lacks. |
| M3 Schema version per branch | - | Already fixed on `main` by #143: migration follows a schema fingerprint and the version write is `MAX(v, excluded.v)`, so no CI version check is needed. |
| M4 "Private" profile copy | #140 (3ad8822) | Committed on #140's branch: the profile and the form say "unlisted and out of search engines", not private. Ownership proof: re-check (`/api/recheck`) and claims, hiding and removal (`/api/owner/*`) need a verified claim, but claims only accept listed portfolios (`isKnownPortfolio`), so an added, not yet listed site has no ownership proof and no removal path until it joins the list. Unclaimed adds use the grader's own caps, with no separate cap. Both stay for #140. |
| M5 Sessions can't be revoked | #175 | Open. "Sign out everywhere" in Settings, account deletion signs out every device, and the admin's session ends 12 hours after sign-in (`session_revocations`, checked on read, memoized a minute). |
| M6 One hourly error skips the rest | #166 | Open. Each hourly task runs on its own (`pipeline/hourly.mjs`); a failure goes to Sentry tagged with the task. |
| M7 CSP allows inline scripts | #173 | Open, partial by design. A nonce would end ISR and the edge cache, so `'unsafe-inline'` stays for script elements; `script-src-attr 'none'` and `object-src 'none'` are added and the report's print button no longer uses `onclick`. |
| M8 Ungraded sites in the sitemap | #169 | Open. The sitemap always lists only graded real portfolios; a database error keeps yesterday's sitemap. #140 keeps this filter when it rebases. |
| L1 Quiet local-file fallback | #167 | Open. On Workers a missing `TURSO_DATABASE_URL` throws a clear error. After deploy: resolve PORTFOLIORANK-2 and add a Sentry alert rule for new issues (owner). |
| L2 Test seams deny-list | #168 | Open. Seams and the email outbox are an allow-list (`lib/test-mode.mjs`): `SITE_ENV=test`, or `next dev` for the seams. |
| L3 Token expiry without an alert | #170 | Open. The night reads GitHub's token-expiry header and raises `dispatch-token:expiring` from 14 days out, and `dispatch-token:missing` when the token isn't set. A night that dies is already caught by #153. |
| L4 Staging uses production's email caps | #171 | Open, partial. Staging gets its own lower `EMAIL_CAPS` (20 a day). The shared mailroom apps are only on #124, #133 and #164; a staging mailroom app needs n8watkins/mailroom and its deploy (owner). |
| L5 Faint text and layout shift | #174, #140 (f3130a5) | Open. Profile checks and social links no longer move the page (mobile CLS 0.63 to 0 in a throttled test). `text-mute/70` fixed on #140; #136 still has it in `PortfolioCheck.tsx` and `ShareResult.tsx`. |
| L6 Page weight | - | Nothing needed now. |

## High

### H1. Production owner alerts are never emailed (observability)

Evidence: `wrangler secret list` on `portfolio-rank` has no `OWNER_EMAIL`, and the production `vars` in `wrangler.jsonc` do not set it either.
Staging does have it.
Every alert path passes `to: env.OWNER_EMAIL ?? null`, in `worker/night.ts:249`, `worker/email-alerts.ts:23`, `worker/owner-removals.ts:26` and `worker/model-watch.ts:27`.
Impact: circuit breakers, quota stops, held removals, email caps and model-watch alerts only land in a table that someone has to open `/admin` to see.
Fix: set `OWNER_EMAIL` as a production var, and fail the deploy smoke test when it is missing.

### H2. Nothing notices a night that never ran or died partway (reliability)

Evidence: alerts are only built at the end of a finished Workflow (`worker/night.ts:236-255`).
`startTonight` catches every error from `env.NIGHT.create` and logs it as "already exists" (`worker/night.ts:296-305`), so a Workflows outage or a bad binding looks normal.
A run that dies leaves `night_runs.status = 'running'`, and nothing follows up on it.
Impact: the core nightly job can stop for days with no email, no Sentry event and no GitHub issue.
Fix: add a dead-man check to the hourly cron that raises an owner alert when no night has finished in 26 hours or one has been running for more than 6 hours, and treat only a duplicate-id error as "already exists".

### H3. "Use the free tier" calls our Gemini key from the visitor's request (product rule)

Evidence: `POST /api/grade/[id]/finish` with `{ freeTier: true }` builds `peopleContext` with `env.GEMINI_API_KEY` and runs `queueFreeGrade` in the background (`app/api/grade/[id]/finish/route.ts:56-65`).
`queueFreeGrade` sets `tryNow = Boolean(ctx.apiKey)` and grades at once (`lib/grader/queue.mjs:51-67`).
The button is in `components/grade/GradeProgress.tsx:101` and `components/me/Queued.tsx:108`.
Commit 6d1864f fixed the same pattern for `/api/add` only.
Impact: nothing happens yet because `GRADER_ENABLED` is false in production, but the route breaks the "no visitor-triggered Gemini" rule as soon as the grader launches.
Fix: queue only (`tryNow: false`) and let the hourly `drainPeople` finish it, and add a test that no visitor route ever reaches the Gemini stand-in.

### H4. No privacy page is live (privacy)

Evidence: `/privacy`, `/terms` and `/removal` answer 404 in production.
`docs/legal/README.md` says the privacy page is needed "now", but the drafts are neither built nor linked.
The site already stores GitHub sign-ins, votes with rater ids and Sentry reports, and staging runs the newsletter and email sign-in.
Fix: ship `/privacy` and `/removal` from the drafts, link them in the footer, and make them a release gate for `NEWSLETTER_ENABLED` and `GRADER_ENABLED`.

## Medium

### M1. Backups are kept forever, so deletions never fully happen (privacy)

Evidence: the backup writes a new object every day (`scripts/backup-db.mjs:64`, `backups/portfoliorank-YYYY-MM-DD.json.gz`).
`wrangler r2 bucket lifecycle list portfolio-rank-backups` shows only the multipart-abort rule.
The privacy draft promises to delete hashed network ids, poll votes and report emails within 30 days (`docs/legal/privacy.md:22,85,109`).
Fix: add an R2 lifecycle rule that expires `backups/` after 35 days, and say so on the privacy page.

### M2. About ten tables live outside the schema file (data integrity)

Evidence: there are `CREATE TABLE` statements in `pipeline/night.mjs`, `pipeline/retention.mjs`, `pipeline/alerts.mjs`, `pipeline/rubric-history.mjs`, `pipeline/gemini-log.mjs`, `pipeline/people.mjs`, `pipeline/model-watch.mjs`, `pipeline/roster.mjs` and `worker/staging-gate.ts`.
Measured: the staging database has no `night_runs`, `night_item_failures`, `gemini_daily`, `owner_alerts` or `rubric_history` tables, and production has all five.
Impact: staging cannot exercise the night or alert paths, a fresh restore misses tables, and `SCHEMA_VERSION` does not describe the real schema.
Fix: move every `CREATE` into `lib/schema.mjs` (or modules it imports), and have the pipeline call `ensureSchema`.

### M3. Schema versions are a single integer that each branch bumps (data integrity)

Evidence: production and `main` are at version 12.
`preview/staging-all` is at 17, with five bumps from different feature branches (`lib/schema.mjs:20-38`), so two open PRs can claim the same number.
`migrate()` writes `v = excluded.v` (`lib/schema.mjs:266-269`), so deploying a rollback lowers the recorded version.
Fix: write `MAX(v, excluded.v)`, and add a CI check that fails when a PR's version is not exactly one above the version on `main`.

### M4. "Add your portfolio" accepts anyone's site, and the "private" profile is guessable (product rule)

Evidence: `/api/add` takes any reachable URL, saves it and queues a Gemini grade on our key (`app/api/add/route.ts:28-46`).
Nothing checks that the site belongs to the visitor.
The profile then says "This page is private until the site is graded: only people with the link can see it" (`app/p/[slug]/page.tsx:302`), but that link is just the site's own address, URL-encoded.
Fix: change the copy to "not listed or indexed", and give unclaimed adds a small separate daily Gemini cap, or require a claim before grading.

### M5. Sessions cannot be revoked, including the admin's (security)

Evidence: sessions are JWTs with the Auth.js defaults of 30 days, renewed every 24 hours.
The only way to end sessions is the global `SESSION_VERSION`, and deleting an account (`app/api/account/route.ts`) leaves its cookie valid.
`next-auth` is still `5.0.0-beta.32`.
Fix: give the admin a short `maxAge`, such as 12 hours, and check a per-account "sessions valid after" timestamp in the `jwt` callback so account deletion and "sign out everywhere" work.

### M6. One error in the hourly cron skips the rest of it (reliability)

Evidence: the `15 * * * *` branch awaits six tasks in a row (`worker/index.ts:91-103`).
`drainPeople` has no try/catch (`worker/night.ts:276-282`), so a Turso or Gemini error there skips freshness, tiers and the image library for that hour.
Fix: run each task in its own try/catch, or use `Promise.allSettled`, and report failures to Sentry.

### M7. The CSP allows inline scripts (security)

Evidence: `next.config.ts` sets `script-src 'self' 'unsafe-inline' ...`, and the live response headers confirm it.
With inline scripts allowed, the CSP does not stop an XSS.
Fix: move to a nonce-based CSP, with middleware setting a per-request nonce, or hash the few inline scripts such as the theme init.

### M8. Ungraded sites are public and in the live sitemap (product rule)

Evidence: 36 of the 2,010 profile URLs in the live `/sitemap.xml` have no `ai_rubric` in production, for example `/p/https%3A%2F%2Fjacksonm.dev`, which has no noindex.
`staging-all` adds noindex to those profiles, but its sitemap filters to graded sites only when `TOOLS_ENABLED` is on (`app/sitemap.ts:60`).
The SEO review owns the details.
Fix: always filter the sitemap to graded real portfolios, whatever the launch switches say.

## Low

### L1. The database quietly falls back to a local file (observability)

Evidence: Sentry issue PORTFOLIORANK-2 is unresolved, with 83 events on 2026-11-10 of `got "file:"`.
The cause is `lib/db.ts:12-19`, which uses a local file whenever `TURSO_DATABASE_URL` is missing.
It is the only open issue in the project, so a quiet Sentry does not prove the site is healthy.
Fix: throw a clear error on deployed Workers when the Turso URL is missing, resolve the issue, and add a Sentry alert rule for new issues.

### L2. Test seams use a deny-list (security)

Evidence: `testSeam()` turns off the `GRADER_TEST_*` seams only when `SITE_ENV` is "production" or "staging" (`lib/grader/server.ts:108-114`).
A Worker without `SITE_ENV` would honor seams that redirect the Gemini, GitHub and site fetches.
Fix: allow the seams only when `SITE_ENV === "test"`.

### L3. An expired token stops the nightly checks without an alert (reliability)

Evidence: a failed `dispatchWorkflow` only becomes a line in the night's summary (`worker/night.ts:185-187`), not an alert condition.
`GITHUB_DISPATCH_TOKEN` is a fine-grained PAT, and those tokens expire.
Fix: make "checks not started" an owner alert, and record the token's expiry date in `OWNER-TODO.md`.

### L4. Staging uses up production's email caps (reliability)

Evidence: staging binds the same mailroom apps, `portfoliorank` and `portfoliorank-news` (`wrangler.jsonc`, `env.staging.services`).
A day of testing on staging can use up production's 60 sign-in links.
Fix: give staging its own mailroom apps with small caps.

### L5. Faint text and a profile layout shift (accessibility)

Evidence: `text-mute/70` measures 3.4:1 against cards in both themes, which is below AA for body text, and it is used in two places.
The "Polish checks" grid on profiles moves when its client data arrives, and mobile CLS measured 0.04 to 0.15 on `/p/https%3A%2F%2Fchriscoyier.net`.
The skip link, landmarks, single h1, labelled controls and alt text all passed on `/`, `/play`, `/top` and a profile.
Fix: use `text-mute` at full strength, and reserve the grid's height with a skeleton until its data loads.

### L6. Page weight is fine, with some room (performance)

Evidence: every page loads about 210 KB of JS (Brotli, 660 KB raw).
The `/top` HTML is 605 KB raw (40 KB Brotli) with 104 images.
With 4x CPU and slow-4G throttling, mobile LCP was 2.1 to 2.6 s and CLS was 0 on `/`, `/play` and `/top`.
Fix: nothing is needed now, but check the shared client bundle for large imports, such as lucide icons and the Sentry browser SDK, before adding features.

## Checked and fine

- Every `/admin` page and `/api/admin/*` route checks `ADMIN_GITHUB_ID` by numeric id, and every admin POST checks Origin.
- Every public route that changes data checks Origin, except the RFC 8058 one-click unsubscribe, which should not.
- Turnstile fails closed on deployed Workers and checks both the action and the hostname (`lib/turnstile.ts`).
- `safeFetch` re-checks each redirect hop, caps the body size and runs under `global_fetch_strictly_public`, and `/api/inspect` and `/api/psi` accept only roster URLs.
- Network ids are stored as keyed hashes, and `rate_limits` and the votes of closed polls are pruned.
- The daily backup to the private R2 bucket succeeded on each of the last 8 days, and the snapshot finds tables dynamically.
- Staging answers 404 without its gate key and never runs the Gemini crons.
- CI had no same-commit flakes in the last 100 runs, and its 25 failures were real test failures on feature branches.

## Method

This review read the code at 3711a91 and ran read-only Turso queries (`schema_meta`, table lists and row counts).
It also used `wrangler secret list`, `wrangler versions list`, the R2 lifecycle listing, the `gh` run history, the Sentry issue list and the live HTTP headers.
Playwright probes measured LCP, CLS and basic accessibility.
PageSpeed Insights was over its anonymous quota at the time.
