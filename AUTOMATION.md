# Automation & Architecture

How PortfolioRank stays current with **no manual work**. This is the source of
truth for the data flow and the GitHub Actions.

## Data flow

```
emmabostian/developer-portfolios (upstream, community-curated)
        │  (only MERGED entries - upstream review is the trust gate)
        ▼
  sync-upstream Action  ──rebuild──►  data/feed.json
        │                               = upstream − excluded.json + additions.json
        ▼
  roster sync  ──►  rows not in feed.json marked delisted (Turso portfolios.delisted_at)
        ▼
  capture.mjs (new + --refresh)  ──►  screenshots ──► Cloudflare R2   + diagnostics, page text, facts ──► Turso
  fullpage-backfill.mjs (capped)  ──►  tall images for older captures ──► R2 (+ portfolios.meta.fullPage)
  evidence.mjs, detect-changes.mjs  ──►  old rows' text and facts, page changes (rating_resets)
        ▼   (all of the above: the free checks on Actions, started by Cloudflare at 20:30 Pacific)
  end-of-day Workflow (Cloudflare)  ──►  new and changed sites graded (rubric v2) ──► Turso (portfolios.ai_rubric)
                                    ──►  AI ranking comparisons (RANKING_V2) ──► Turso (comparisons, site_ratings)
                                    ──►  re-grades, on what is left of the day's quota
        ▼
  Next.js app (Cloudflare Workers)  ──►  grid · /rank face-off · /top leaderboard · /p/[slug] · /removed

  weekly health check  ──►  live → suspect → down  ──►  data/excluded.json (bot PR)
                                                   ──►  monthly report on the community list (PR opt-in, off)
```

## The list (two intake doors + a takedown)

`data/feed.json` is rebuilt daily as **`upstream − excluded.json + additions.json`**
(deduped by normalized URL; original URL strings preserved so DB keys never break).

| Source | Trust | Mechanism |
|---|---|---|
| **Upstream merge** | High (Emma reviewed it) | Auto-pulled by `sync-upstream` |
| **Direct submission** | Unvetted | Issue form → `data/additions.json` |
| **Takedown / opt-out** | - | "Remove my portfolio" issue → `data/excluded.json` (dropped forever) |
| **Our own cleanup** | Health check, confirmed over 2+ weeks | `health.yml` → `data/excluded.json` (reason, dates, evidence) |

### Our list wins (owner decision 2026-11-10)

PortfolioRank runs its own cleanup instead of relying on the community list being right, and background jobs only work on sites on the current list.

- **Roster sync** (`pipeline/roster.mjs`, run by capture, judge, prewarm and the health check): database rows whose URL is no longer in `feed.json` get `delisted_at`; a URL that comes back is restored.
  Grading, the AI voting pool, prewarm and the site only use listed rows that are not confirmed down.
  After 30 days delisted, `purge-delisted.mjs` deletes the row's R2 screenshots and the row (and its `psi:`/`inspect:` cache entries).
  Votes and ratings stay: the vote log is the source of truth for ELO, and the leaderboard only shows roster URLs, so rankings stay consistent.
- **Health check** (`pipeline/health.mjs`, weekly): every listed site is checked for loading, parking, blank pages, duplicates and a stored `is_portfolio=false`.
  States: `live` → `suspect` (any failure) → `down` (3 failed checks in a row spanning at least 13 days); a pass resets to `live`.
  Bot walls (403/429 challenges) are inconclusive and leave the state alone; free-tier apps answering 502/503/504 get a second look after 30 seconds.
  A redirect to another domain is a move, not a failure: the run summary lists moves (and flags targets that don't carry the person's name) so the stored URL can be updated.
  When more than 30% of sites fail in one run the runner is the likelier culprit, so nothing is recorded and the job fails.
- **Portfolio-likeness** (`pipeline/signals.mjs`, part of the health check): from each loaded page's HTML (the rendered DOM for single-page apps) it records six yes/no signals in `portfolios.signals`: projects/work section, about, contact (mailto, form or social links), resume/CV, a GitHub profile link, and the person's name in the title or h1.
  A page with at most one is flagged `needs_review`: never removed or hidden for it, listed in the run summary, and graded first by the rubric so Gemini's `is_portfolio` confirms or clears it.
  The other way round, a grade that says `is_portfolio=false` for a page with at least 4 of the 6 signals is not acted on ([pipeline/portfolio-guard.mjs](pipeline/portfolio-guard.mjs), applied in `gradeRecord`): it is stored as a portfolio, so it stays listed and ranked, with the AI's answer in `ai_is_portfolio`, the reason in `review`, and the site flagged `needs_review` for a person to look at.
- **Exclusions**: newly confirmed-down sites are appended to `data/excluded.json` as `{url, name, reason, kind, removed, first_failed, last_checked, checks}` and dropped from `feed.json` in one bot pull request (branch `data/health-exclusions`, auto-merge), at most 10% of the list at once.
  `generate_feed.py` reads both these objects and the older plain URL strings.
  `/removed` lists them with the reason and date; takedown requests are counted there but never named.
- **Site visibility** (`lib/roster.ts hiddenUrls`): a roster site is hidden when it is confirmed down, or when its capture failed and the health check hasn't passed it since.
  Captures that fail are retried with backoff (1, 2, 4, 8, 16, then 30 days), and a passing health check schedules a recapture at once, so one transient error never hides a site for good.
- **Owner review queue** ([lib/reviews/store.mjs](lib/reviews/store.mjs), `/admin/review`): a re-check (the first is "recheck-543") writes one `status_reviews` row per site whose listed or ranked state it would change, with fresh screenshots, each grader's verdict, the code's signals, the group and the reason.
  Rows where the graders agree come ticked; disagreements are flagged and unticked; nothing changes until the owner confirms.
  Confirm goes through the paths above: a "not a portfolio" grade with a tier is kept and flipped (the AI's answer in `ai_is_portfolio`, the owner's decision in `review`, re-ranked with `rankForWrite`), one without a tier is cleared for the nightly grade queue, a remove stores "not a portfolio" so the health check takes the site off the list, a site held out only for its grade gets its health back, a broken one gets a recapture, and a delisted one goes into `data/additions.json` through the weekly health pull request ([pipeline/review-additions.mjs](pipeline/review-additions.mjs)).
  The owner's verdict holds over later grades (`withOwnerVerdict` in the night run, the judge and the re-grade scripts); who decided and when is kept on the row.
  While rows wait, the Monday goals email carries their count and the link (see Owner goals).
- **Feed shrink guard**: `generate_feed.py --max-shrink 0.05` refuses to write a feed more than 5% smaller than the current one, which fails the sync run instead of wiping the list.
- **Upstream report** (`upstream-removals.yml`, monthly, report-only): the community list runs its own link checker every Saturday that removes broken and parked links (its CONTRIBUTING.md, sample report emmabostian/developer-portfolios#3696), so a removal PR for those would only duplicate it.
  The monthly run summary lists only what that checker misses: entries we confirmed down for a reason a link checker can't see (blank page, redirect to a social profile, re-checked right before), entries graded "not a portfolio", and possible hijacks (redirects to an unrelated domain, recorded by the health check); entries their checker will catch are only counted.
  Opening one pull request for the first group (never `suspect` or AI-only entries, at most 25, in the list's own removal format, from the fork `n8watkins/developer-portfolios`) is off: it needs a manual run with `dry_run` off, or the repository variable `UPSTREAM_PR_ENABLED` set to `true` for the schedule, plus the `UPSTREAM_PR_TOKEN` secret.

## When checks re-run

Owner decision of 2026-11-11 ([docs/DECISIONS.md](docs/DECISIONS.md#infrastructure)): if a site hasn't changed, don't measure it again; if it has, measure it again.
It isn't about saving free API requests: re-runs take time, and a changed site should not show old results.
It has a launch switch, `FRESHNESS_ENABLED` ([lib/freshness-flag.ts](lib/freshness-flag.ts)): `"false"` in production and `"true"` on staging.
While it is off, the hourly cron makes no fingerprint fetches and profiles say "Measured on <date>" as before, without "site unchanged since" or "re-measuring"; the reuse rules below apply either way.
The rule and its numbers live in one place, [lib/freshness.mjs](lib/freshness.mjs).

**The rule, for every check on a portfolio:** reuse the stored result while the site is unchanged.
Run it again when:

- the site's change fingerprint changed after the result was measured;
- the admin pressed "Re-measure" on the portfolio's page, or its verified owner asked for a re-grade;
- the result is older than its maximum age (below), because some things break without the page changing;
- the result is a failure and its short retry window has passed.

| Check | Where it is stored | Maximum age | A failure is retried after | When a due result runs again |
| --- | --- | --- | --- | --- |
| Lighthouse (PageSpeed) | `cache` `psi:<url>` | 90 days | 1 hour | On the next view of the portfolio page (the old result shows at once, then the new one), and the daily `prewarm.yml` for S, A and B sites |
| Polish checklist and share card | `cache` `inspect:<url>` | 30 days (the share image and favicon can break on their own) | 1 hour | On the next view, and `prewarm.yml` |
| Project link checks | `portfolios.facts` (`facts_at`) | 30 days (links rot without the page changing) | the next night | Tonight's free checks (`evidence.mjs --links`, up to 120 a night) |
| Screenshots, page text and facts (the capture) | R2 and `portfolios` (`captured_at`) | 90 days | the next night | Tonight's free checks (`capture.mjs --refresh`, up to 150 a night, changed and asked-for sites first) |
| "Grade my portfolio" free checks | `cache` `grader:quick:<site>` | links 30 days | 10 minutes (the visitor may have just fixed the site) | A request is a grade: the page is always fetched again, and only its link checks are reused while the page is unchanged |

**The change fingerprint** ([lib/freshness.mjs](lib/freshness.mjs) `pageFingerprint`), from one ordinary page fetch, the same one the polish check and the grader's free checks make (`safeFetch`, the body capped at 800 KB):

- a hash of the HTML with per-request noise removed: inline scripts, comments, CSP nonces, CSRF and trace tokens (and Sentry's trace tags), timestamps and epoch numbers, UUIDs and long hex or base64 ids, numbers in counter ids (`bits-5`, React's ids), Cloudflare's per-response links and email obfuscation, `@font-face` rules (font CDNs reorder their subsets), whitespace between tags, and the order of the `<head>` (streaming renderers emit it in a different order);
- plus the sorted script and stylesheet URLs (without per-request query parameters such as `?t=<epoch>`), whose build hashes change on every deploy;
- ETag and Last-Modified count only when the body is byte-for-byte the same as last time (a redeploy of identical HTML); a Last-Modified equal to the response's own time is a dynamic page and never counts.

The first fingerprint of a site is its baseline, never a change.
About 1.5% of sites really differ on every request (a live clock, a random quote, a "now playing" track): they look changed at each weekly check and get re-measured weekly.
A client-rendered page whose HTML shell and asset names stay the same across deploys looks unchanged; the maximum ages catch it.

**The weekly check** ([worker/freshness.ts](worker/freshness.ts)): the hourly Cron Trigger (`15 * * * *`) fingerprints the listed, live sites attempted longest ago, about a 168th of the list each hour (14 of 2,106), so each site is checked once a week, and a site attempted in the last day is never fetched again.
The polish check and the grader's free checks record the fingerprint of the page they already fetched, so a change found there counts at once.
A fetch that fails keeps the stored fingerprint and only notes the attempt.
The state is `site_freshness`: per address the fingerprint, `checked_at`, `attempted_at`, `changed_at` (and why), and `forced_at`.

**What it costs** (2,106 listed sites, measured on 400 of them): about 300 page fetches a day, about 400 subrequests with redirects plus 3 Turso requests a tick (about 17 to 20 subrequests per hourly run, far under a run's limit); the fingerprint takes about 1 ms of CPU at the median and 8 ms at the 90th percentile, so with the fetch's own work about 1.5 to 3 seconds of Workers CPU a day, roughly 0.1 to 0.3 million ms a month of the 30 million included.
Turso: the due query reads about 4,200 rows a tick (about 3 million a month of 500 million) and writes about 300 rows a day.

**What people see:** under Lighthouse and the polish checklist, "Measured Nov 11 · site unchanged since" when a later check found the page the same, or "Re-measuring, the site changed · last measured Nov 3" while a due result runs again (the page asks again until the new result is in).
**The admin:** a "Re-measure" button on every portfolio page (shown only to `ADMIN_GITHUB_ID`, `POST /api/admin/remeasure`), and the counts in `GET /api/admin/quota` `freshness` and on `/admin/usage`: sites unchanged, changed this week, never checked, checked today, and re-measured today (Lighthouse, polish, captures, link checks).

## End-of-day run

Owner decisions of 2026-11-10 ("people first, AI with the leftovers"); the reasons are in [docs/DECISIONS.md](docs/DECISIONS.md#gemini-budget-one-key).
Gemini's free quota resets at midnight Pacific and unused requests are lost, so people's requests get the day and background AI gets what is left, once a night, just before the reset.
GitHub's own schedule starts jobs 4 to 10 hours late, so the clock is Cloudflare's.

| When (Pacific) | Where | What |
| --- | --- | --- |
| All day, as they arrive | Worker and `grade.yml` | People's grade requests ("Grade my portfolio" below, [pipeline/people.mjs](pipeline/people.mjs)): the whole day's quota minus the evening reserve, 3.5 only; a request 3.5 can't answer waits in a queue |
| Every hour at :15 | Worker cron | Finishes queued people's requests when 3.5 is available (their report emails go out on the grader's next tick), checks the change fingerprint of a 168th of the list ("When checks re-run" above), then the image library's hourly batch: up to 2 images, none from 20:00 to midnight ([worker/library.ts](worker/library.ts)) |
| Every 5 minutes | Worker cron | The grader's tick ([worker/grader.ts](worker/grader.ts)): report emails, captures that didn't start, requests waiting for a later day, cleanup; nothing while `GRADER_ENABLED` is off |
| 20:30 | Worker cron, Workflow `portfolio-rank-night` | Starts tonight's run ([worker/night.ts](worker/night.ts)) |
| 20:30 to 21:15 at the latest | GitHub Actions, started by the Workflow | The free checks: `sync-upstream.yml` (feed, capture of new sites, re-capture of up to 150 sites whose screenshots are due, page evidence, link checks that are due, fingerprint changes); on Sundays also `health.yml` (not waited for) |
| Then until 23:30 | Workflow | The AI stages, in order, on what is left ([pipeline/night.mjs](pipeline/night.mjs)) |
| 23:30 | Workflow | Hard stop, 30 minutes before the reset; the summary and owner alerts |
| Then | Workflow | Roll-ups and retention of the log tables ([pipeline/retention.mjs](pipeline/retention.mjs)): `gemini_requests` older than 90 Pacific days becomes `gemini_daily`, `night_runs` older than 180 days and the free-text reason of comparisons older than 90 days go |
| Mondays 08:00 or 09:00 | Worker cron `0 16 * * 1` | Model watch (below): Google's model list, deprecations and release notes; no Gemini generate calls |

The cron: Cron Triggers run in UTC, so `wrangler.jsonc` has `30 3 * * *` (20:30 under daylight time) and `30 4 * * *` (20:30 under standard time); the handler starts the run only from the one that is 20:30 in Los Angeles, so the run starts at the same local time all year ([pipeline/budget.mjs](pipeline/budget.mjs) `isNightStart`, tested for every day of 2026 and 2027).
The Workflow instance is `night-<Pacific date>` and the night is claimed in the `night_runs` table, so a night runs once: a failed or stopped run never restarts itself.

### The stages

| Order | Stage (job name in `gemini_requests`) | Works on | Cap a day | Time cap |
| ---: | --- | --- | ---: | ---: |
| 1 | Grade new sites (`grade-new`) | listed, captured, ungraded, with page text and facts | 300 | 60 min |
| 2 | Grade changed sites (`grade-changed`) | graded before their page fingerprint changed (the free checks re-capture sites and record changes in `rating_resets`) | 100 | 30 min |
| 3 | AI ranking comparisons (`compare`) | ranking v2 one-on-one and batched comparisons, then the boards are rebuilt; only when the Worker variable `RANKING_V2` is `"true"` | 200 | 45 min |
| 4 | Content (`content`) | the weekly polls (below): at most one request a night and two a week; then, while `CONTENT_MODE` is not "off", the content engine (below): the week's pick on Sunday, one post on Monday and Wednesday nights | 100 | 30 min |
| 5 | Image library (`library`) | no work in the night: the cap for the library's Gemini checks, which run once a day on the hourly cron, only in the UTC hour `LIBRARY_RUN_HOUR_UTC` (23, so 23:15 UTC, 3:15 pm Pacific in winter), using whatever the owner's Make now left of the 40 AI images a UTC day and stopping before 23:55 UTC; [docs/CONTENT-ENGINE.md](docs/CONTENT-ENGINE.md#the-image-library)) | 40 | 25 min |
| 6 | Re-grades (`regrade`) | 3.1 grades on 3.5, then (`RUBRIC_REGRADE`) older rubrics; off by default (cap 0) until rubric v3, turned on with `GEMINI_BUDGET` `{"stages":{"regrade":{"cap":300}}}` ([docs/audits/gemini-prompting.md](docs/audits/gemini-prompting.md)) | 0 | 60 min |
| 7 | Experiments (`experiment`) | none scheduled | 50 | 15 min |

"AI ranking comparisons" are Gemini comparing sites.
Human face-off votes use no Gemini and are never scheduled.
Rows without page text and facts (captured before rubric v2) are measured by the free checks (`pipeline/evidence.mjs`, which needs a browser) and graded the same night.

### The budget accountant

[pipeline/budget.mjs](pipeline/budget.mjs) is the only place that decides how much Gemini a job may spend.
It counts `gemini_requests` since midnight Pacific, retries included.

- A background stage may spend min(its cap minus what it used today, the quota left minus the reserve).
- The reserve is max(25, 2 x people's requests in the last hour): it grows with demand and is never spent by the background.
- People may spend everything left minus the reserve until 20:30, and the reserve too from then on.
- The run works in batches of 20 requests and re-reads the quota and people's demand before each one; when people sent a request in the last 10 minutes, it pauses 5 minutes.
- Re-grade requests (people): once every 7 days, at once when the page changed after the last grade (`regradeAllowed`).
- Settings: `GEMINI_BUDGET` (JSON over `DEFAULT_PLAN`: reserve, batch, caps, time caps, retry budget), a Worker variable and a repository variable for the manual fallbacks; `GEMINI_DAILY_QUOTA`; `GEMINI_RPM` (8 a minute).
- `judge.mjs`, `compare.mjs` and `eval-rubric` ask the same accountant, so a manual run never takes the reserve.

### No endless retries

- Each request: the client's own retries for a busy 3.5 (10, 30 and 60 seconds) and for per-minute limits.
- Each night: at most 20 retries in total; past that the run stops for the night.
- Each stage: 5 failures in a row stop it for the night (the circuit breaker), and the next stage starts.
- Each item: tried once a night; an item that fails on 3 nights in a row is parked in `night_item_failures` and listed in every summary until someone deletes its row.
  A busy 3.5 is not the item's fault and never counts towards parking.
- A spent daily quota stops the run as waiting for tomorrow, never as a failure; a rejected key fails it.

### The summary and the admin view

Each run writes its summary to `night_runs` and to the Worker's logs: the estimate at the start (requests and minutes at the pace), the actual at the end, each stage's requests, results and minutes, why it stopped, and the parked items.
`GET /api/admin/quota` (only for the GitHub account whose numeric id is `ADMIN_GITHUB_ID`) returns Gemini use by quota day, job and model for the last 30 days, what each stage and people may spend now, the last 14 runs, parked items, owner alerts and people's queue; the redesign's admin page will show it.

### Owner alerts

After every run, [pipeline/alerts.mjs](pipeline/alerts.mjs) checks: the quota used up before the run, a stage stopped by the circuit breaker, parked items, and traction (people's grade requests or human votes in a day past `ALERT_TRACTION`, default 50 and 300).
A condition that holds sends one email a day, every day, until it clears; the state is the `owner_alerts` table.
They go through Cloudflare Email Service and the shared email gate ("Grade my portfolio", Email) to `OWNER_EMAIL`, the owner's verified address, which is free and doesn't count against the monthly sends.
Until `OWNER_EMAIL` is set the sender is off: alerts are recorded, logged and shown in the admin view, and none is marked sent; a send the gate refuses or the provider fails stays unsent and is tried on the next run.

A night that never runs can't check itself, so the hourly cron (`15 * * * *`) also runs a dead-man check ([pipeline/night-watch.mjs](pipeline/night-watch.mjs)) on the latest night that should have started.
It raises `night-watch:missed` when that night has no `night_runs` row an hour after 20:30 Pacific (the cron didn't fire, the Workflow couldn't be created, or `GEMINI_API_KEY` is missing).
It raises `night-watch:stuck` when the night still says `running` an hour after its hard stop and its Workflow instance is not paused; a run the owner paused on purpose is left alone.
Both clear once a later night finishes.
Creating tonight's Workflow treats only the duplicate-id error as "already ran"; any other error is logged as `night.cron.failed` and reaches Sentry.

### What stays on GitHub Actions, and why

- Capture and the health check load sites in Playwright's Chromium, which a Worker can't run; they stay on Actions and the Workflow starts them with a `workflow_dispatch` (the Worker secret `GITHUB_DISPATCH_TOKEN`).
  Without the secret, the start is skipped with one log line and the AI stages work with what is already captured.
- Measuring page evidence for old rows needs a browser for client-rendered pages, so it runs in the free checks too.
- Grading, comparisons and the board rebuild run on Cloudflare: they need only the database (libSQL over HTTP), the `SHOTS` bucket and `fetch` to Gemini.

### Polls

Owner decision of 2026-11-10 ([docs/DECISIONS.md](docs/DECISIONS.md#polls)): one poll a week that people vote on, written from PortfolioRank's data.
The back end is built; the poll card on home and the `/polls` page come with the redesign.

- **Weeks:** each poll owns one Pacific week, Monday 00:00 to the next Monday 00:00 ([lib/polls/week.mjs](lib/polls/week.mjs)); its id is that Monday's date.
- **Kinds:** `hero` (two real screenshots side by side, "Which hero section is better?", options Left and Right with the portfolio's URL) and `text` (2 to 4 written options).
- **Every night, free** ([pipeline/polls.mjs](pipeline/polls.mjs) `schedulePolls`, called by `planNight` before the AI stages): this week has a poll, and so does next week when it starts before the next run.
  When nothing was written ahead, code makes one without Gemini: a hero poll between two sites graded S or A whose screenshots exist, or the next unused evergreen text poll.
  It also deletes per-person vote rows 30 days after a poll closes (the totals stay) and old rate-limit windows.
- **Content stage, Gemini** (`pollsContent`): when fewer than 2 future weeks have a poll, one request to 3.5 Flash-Lite writes 4 candidates from aggregate data only (percentages of graded sites with a resume link, GitHub link, contact and so on; never a name or a site).
  Code then checks each one: known kind and topic, question length, 2 to 4 distinct options, no negative wording, no links, handles or roster names or domains, not a repeat of any earlier poll, at most one hero poll; code picks the hero poll's two sites (S or A only, not shown in the last 12 weeks, screenshots checked in R2).
  Up to 3 accepted polls get the next free weeks.
- **Limits:** one generation a night, at most 2 requests in any 7 days (retries included), recorded in `poll_generations` with what was proposed, accepted and rejected and why; the Content stage cap in `GEMINI_BUDGET` (set it to 0 to stop generation) still applies.
- **Tables** ([lib/polls/schema.mjs](lib/polls/schema.mjs)): `polls`, `poll_options` (with the running total, kept by a trigger), `poll_votes` (only for the one-vote rule), `poll_generations`, `rate_limits`; all but `rate_limits` are in the nightly backup.
- **Withdrawing a poll:** set its `status` to `withdrawn`; it disappears from every API and keeps its week, so nothing replaces it automatically.

The API ([app/api/polls](app/api/polls)):

| Request | Answer | Cache |
| --- | --- | --- |
| `GET /api/polls?past=12` | `{ active, past, at }`: this week's poll or null, and closed polls newest first (1 to 52) | public, 60 s, and the Worker's edge cache |
| `GET /api/polls/<id>` | `{ poll }` for an active or closed poll; 404 for an unknown, upcoming or withdrawn one | public, 60 s, edge cache |
| `GET /api/polls/<id>/vote` | `{ mine, open, turnstile }`: the visitor's own option index or null | private, no-store |
| `POST /api/polls/<id>/vote` `{ option, turnstileToken? }` | 200 `{ mine, poll }` with fresh totals; 409 `already_voted` with `mine`; 400, 403 `bad_origin` or `turnstile_failed`, 404, 410 `closed`, 429 `rate_limited` | private, no-store |

A poll is `{ id, kind, question, detail, opensAt, closesAt, status, total, options: [{ index, label, votes, percent, site? }] }`, where a hero option's `site` is `{ url, name, domain, path, shot, hero }` (`hero` is the screenshot's URL, null without one).

- **One vote per visitor:** per signed-in account and per browser (the signed `pr_anon` cookie, issued on the first vote), enforced by unique indexes, so concurrent requests can't vote twice.
  Signing in or out on the same browser, or using the same account on another browser, doesn't give a second vote.
- **Guards on a vote:** the `Origin` header must be the site's own; at most 20 attempts per browser and 60 per IP an hour (`rate_limits`, the IP stored only as a keyed hash); Cloudflare Turnstile (widget action `poll-vote`); the deployed Workers refuse a vote while the `TURNSTILE_SECRET_KEY` secret is missing, and only local runs skip it.
- **Privacy:** no API returns who voted for what; results are totals and percentages.
- **Results feed:** `pollResults(db, { since })` in [lib/polls/store.mjs](lib/polls/store.mjs) returns closed polls with totals, the winning option and the margin in points, for the content engine and the AI vs people comparisons; the public `past` list carries the same totals.
- **Turso reads:** a public read is a handful of indexed rows, at most once a minute per data center; a vote is one insert (plus the trigger's update) and two rate-limit upserts.

### Content engine

The automatic blog's back end ([docs/CONTENT-ENGINE.md](docs/CONTENT-ENGINE.md), [pipeline/content/engine.mjs](pipeline/content/engine.mjs)), built and off.

- **The switch:** the Worker variable `CONTENT_MODE`: "off" (the default in both environments; the stage does no post work), "dry-run" (drafts stay private, status `draft`) or "publish" (posts go live at the next 08:00 Pacific); only the owner sets "publish".
  It is the ceiling for the owner's Automation panel on `/admin/blog` (on or off, nights, drafts a week up to `CONTENT_DRAFTS_PER_WEEK`, review or publish, a topic queue), saved in the database and read by every night; unreadable settings mean no drafts ([docs/CONTENT-ENGINE.md](docs/CONTENT-ENGINE.md#automation)).
- **Schedule:** Sunday night picks the week's 2 ideas and a reserve (one request, or none when there is only one idea); Monday and Wednesday nights each draft one post for Tuesday and Thursday; a dropped or deferred draft is made up on a later night of the week.
- **A draft:** facts from code, then the write request, the claim listing, the claim judgement (only with Tavily results) and the final review; at most two revisions, then it is stored as `dropped` with its failed checks; about 3 to 9 requests when it passes, never more than its batch has left.
- **Caps:** 1 draft a night, 2 revisions, Tavily 10 a post and 50 a week, 1 fresh illustration, 2 Pexels searches and 3 Gemini image checks a post, 2 published posts in any 7 days (counted in the insert that publishes), and the stage's 100 requests and 30 minutes; the owner's "Write a draft now" adds at most 5 drafts a Pacific day under the same per-post caps.
- **Never pay for images:** at most 40 AI images a UTC day (`MAX_AI_IMAGES_PER_DAY`) with no hourly cap of its own (the `portfoliorank-ai` AI Gateway's 40 an hour is the burst backstop), and behind it at most 2,500 neurons (`AI_NEURON_CEILING`) of the account's free 10,000; every Workers AI call reserves its image and neurons first and is skipped when there is no room; a setting above its maximum is rejected and turns Workers AI off ([lib/content/neurons.mjs](lib/content/neurons.mjs)).
- **Optional keys** (Worker secrets): `TAVILY_API_KEY` (without it outside claims are cut) and `PEXELS_API_KEY` (without it no stock photos); the `AI` binding (Workers AI) makes illustrations.
- **Tables:** `posts` (body, fact sheet, checks, images with source, licence and credit, claims with sources, `publish_at`, `newsletter_pending`) and `content_runs` (each night's picks and drafts, and the Gemini, Tavily and Workers AI calls they used).
- **The owner:** `GET /api/admin/content[?status=draft|published|dropped|unpublished|all]` (admin only) lists posts with their fact sheet, checks and images, the latest runs and the mode; on Sunday nights while the engine is on, an owner alert `content-weekly` summarises the week.

## Games, badges, claims, live stats and reports (built, off)

Owner decisions of 2026-11-10 ([docs/DECISIONS.md](docs/DECISIONS.md#games-badges-and-claims)).
The back end is built in [lib/games](lib/games); the screens come with the redesign (branch `preview/redesign`).
Every route below answers 404 until the Worker variable `GAMES_V2` is `"true"` (`wrangler.jsonc`, `"false"` today); the end-to-end tests run with it on.

- **Who plays:** the signed-in account (`gh:<id>`), else the guest's signed `pr_anon` cookie (issued on a guest's first write).
  At sign-in, `/api/claim` moves a guest's quizzes, badges and badge counters to the account ([lib/games/merge.mjs](lib/games/merge.mjs)); where both have the same quiz, the account's answers stand.
- **The quiz pool** ([lib/games/pool.mjs](lib/games/pool.mjs)): every graded site the boards show, with its shown rank in Merged, AI and People.
  A "top X%" is the shown rank over the sites shown in that view.
  Before the first recompute (no `site_ratings`), all views fall back to the rating each AI grade seeds, and People has no percentile.
  Sites whose owners removed them or hid their grade are never quizzed.
  The pool is rebuilt at most every 3 hours (the `cache` table) and kept 5 minutes per isolate.
- **Quizzes** ([lib/games/quiz.mjs](lib/games/quiz.mjs)): five portfolios, one drawn from each fifth of the board, in shuffled order.
  The Daily 5 (`daily-YYYY-MM-DD`, Pacific day) is drawn from the date alone and stored at its first request, so it is the same for everyone all day.
  A random quiz (`r-` and 10 random characters) is stored too, so its challenge link replays the same five.
  A guess is checked on the server: a hit is within 15 points, points are 100 minus 2.5 per point off (never below 20), each round counts once, and the fifth answer finishes the play.
  No response carries a percentile before its guess.
- **Badges** ([lib/games/badges.mjs](lib/games/badges.mjs)): 20, each a target on one counter.
  Counters come from votes, quiz plays and guesses, poll votes (last 5 weeks), lists and likes (signed in only), plus `player_counters` (shares, and grade requests `POST /api/grade` accepted, counted through `recordEvent(db, player, "grade")`) and `player_visits` (up to 50).
  Night owl is a vote between midnight and 5 a.m. Pacific.
  Hidden gem compares a saved site's percentile when a check first saw it saved with its percentile now.
  Early supporter goes to anyone active on or before `EARLY_SUPPORTER_UNTIL` (a Worker variable, `YYYY-MM-DD`; unset gives none).
  Awards are idempotent (the `badges` primary key) and stay when a counter drops.
  A check is reused for 15 seconds (`badge_checks`), and each read is capped (1,000 votes, plays and guesses).
- **Your eye:** the share of a player's face-off votes whose winner ranks higher on the People board (or the AI board), plus quiz guesses within 15 points of that view's percentile.
- **Save to list:** the games use the existing lists API (`/api/lists`, `/api/lists/<id>/items`); nothing new.
- **Claims** ([lib/games/claims.mjs](lib/games/claims.mjs)): signed in with GitHub, a claim is verified automatically when the portfolio is `<login>.github.io` (`github_pages`: GitHub itself says whose site it is), or when its home page links to `github.com/<login>` (not for a site built from a known template, not on another account's github.io site, and only if the page didn't redirect elsewhere; the current login comes from the GitHub API by numeric id, cached a day, `GITHUB_API_TOKEN` optional).
  Every proof is checked on the listed address's own page, so a fork or copy at another address (the copier's github.io or domain) can't claim or remove the original.
  The GitHub profile's Website field is never proof: anyone can set it to any domain, and claims once verified that way count as pending and give no owner rights (`RETIRED_PROOFS`).
  Otherwise the owner adds `<meta name="portfoliorank-verify" content="<token>">` and asks again with `method: "meta"`, or asks for manual review, which the admin decides through `/api/admin/claims`.
  An account verifies at most 3 portfolios by itself; more go to review.
- **Owner actions:** remove, hide or show the grade, and re-grade.
  A link to the GitHub profile is enough only to ask for a re-grade: pages link collaborators', designers' and template authors' profiles too.
  Hiding or showing the grade and removing need proof only the site's owner can give (`controlProof`): the meta tag, `github_pages`, or a claim the admin reviewed; and a removal is held for 24 hours: the hourly cron alerts the owner of PortfolioRank about each held removal (`worker/owner-removals.ts`), the claimant can cancel it, and the admin can undo it before or after it takes effect (`/api/admin/removals`).
  Once the day is up the site is hidden (`lib/roster.ts`), then added to `data/excluded.json` as `owner_request` with reason "owner request" by the weekly health workflow's bot pull request ([pipeline/owner-removals.mjs](pipeline/owner-removals.mjs)); `/removed` counts these and never names them.
  A hidden grade is left out of the portfolio page, the print report (except for the owner) and the quiz pool.
  A re-grade is a row in `regrade_requests` for the grade service, which applies its own cooldown; one open request per site.
  Every claim step and action is written to `claim_log`, the audit log.
- **Live stats** ([lib/games/stats.mjs](lib/games/stats.mjs)): the list numbers (graded, graded this week, % own domain and % resume link from the grades' facts, most common role from taglines, average tier, sites changed this month from `rating_resets`, the newest entry) come from one pass over the listed portfolios, cached an hour.
  Stars and the community list's contributors come from the GitHub API, cached a day.
  Votes today (Pacific, through the `votes_created_idx` index), all votes and quizzes finished are read on each edge-cache miss.
- **Report download** (`printView` and `renderReportHtml` in [lib/grader/report.mjs](lib/grader/report.mjs)): a print-optimised HTML page with a "Save as PDF" button, not a PDF made on the Worker (a Worker PDF library ships Latin-1 fonts only, or a megabyte-scale font).
  It shows a listed portfolio's grade with the same facts and judgments as a "grade my portfolio" report.
  Signed-in visitors open any listed report; others get a one-time link by email, which lets that browser open that one report for an hour.
- **Report links by email:** the same machinery as grade reports ("Grade my portfolio", Email below).
  The link is a `report-link` one-time link ([lib/grader/links.mjs](lib/grader/links.mjs)): signed, valid 24 hours, works once, only a hash of its nonce stored, and it never opens a grade report (nor a grade link a print report).
  The email goes through the shared gate ([lib/email/gate.mjs](lib/email/gate.mjs), kind `report-link`); a refused send answers 503 `email_unavailable` with the reason (`unavailable`, `capped` or `failed`), and the unused link simply expires.
- **Abuse guards:** every write checks the `Origin` header; rate limits per browser and per hashed IP live in `rate_limits` (new quizzes 30 an hour per browser, guesses 300, badge events 120, claims 10 an account, owner actions 20, report emails 5 an hour); the email gate adds its daily caps, including 3 emails a day to one address; Turnstile guards report emails when `TURNSTILE_SECRET_KEY` is set (action `report-email`, [lib/turnstile.ts](lib/turnstile.ts)).
- **Turso reads:** a quiz or guess reads a few rows by primary key; a badge check reads at most about 3,000 rows and is reused for 15 seconds; live stats cost about 2,100 rows an hour plus a few indexed rows a minute per data center.

The API:

| Request | Answer |
| --- | --- |
| `GET /api/games/quiz` | `{ quiz }`: today's Daily 5 with the visitor's progress; 503 `no_portfolios` |
| `POST /api/games/quiz` | 201 `{ quiz }`: a new random quiz; 403, 429 |
| `GET /api/games/quiz/<id>` | `{ quiz }` (a challenge link or a past Daily 5); 404 |
| `POST /api/games/quiz/<id>/guess` `{ index, guess }` | `{ result: { index, guess, merged, ai, people, points, hit }, finished, badges }`; `finished` is null or `{ score, hits, perfect }`; 409 `already_guessed` with `result`; 400, 403, 404, 429 |
| `GET /api/games/eye` | `{ eye: { crowd, ai, votes, guesses } }`, each `{ agree, of, pct }` |
| `GET /api/badges` | `{ badges: [{ id, name, how, hue, counter, target, progress, earned, earnedAt, new }], counters, eye, signedIn }` |
| `POST /api/badges` `{ kind: "share" }` or `{ kind: "visit", url }` | `{ recorded, badges }` |
| `GET /api/owner/claims` | `{ claims: [{ url, status, method, meta, state }] }`; 401 |
| `POST /api/owner/claims` `{ url, method?, note? }` | `{ claim }` with status `verified`, `pending`, `review` or `rejected`; 400, 401, 403, 429 |
| `POST /api/owner/actions` `{ url, action, confirm? }` | `{ state: { hideGrade, removedAt, removeAfter }, regrade? }`; action `remove`, `cancel_remove`, `hide_grade`, `show_grade` or `regrade`; 400 `confirm_required`, 401, 403 `not_owner`, `account_too_new` or `remove_needs_meta`, 429 |
| `GET`/`POST /api/admin/removals` `{ url, action: "undo" }` | the admin's view of held and done removals, and their undo; `{ state, wasRemoved, note? }` (when `wasRemoved`, the weekly exclusions pull request takes its `data/excluded.json` entry out again, logged as `removal_restored`; the daily sync lists the site again) |
| `GET /api/admin/claims`, `POST /api/admin/claims` `{ id, decision, note? }` | the review queue, and a decision; admin login only |
| `GET /api/stats/live` | the live numbers; public, 60 s, edge cache |
| `POST /api/report/email` `{ url, email, turnstileToken? }` | 202 `{ sent }`; 400, 403, 429, 503 `email_unavailable` with `reason` |
| `GET /report/print?url=<portfolio>` or `?t=<token>` | the print page; 401, 403 (grade hidden), 404, 410 (link used, expired or forged) |

A quiz is `{ id, kind, day, challenge, hit, rounds: [{ index, url, name, tagline, domain, path, shot, hero }], progress: { results, finished, score, hits } }`.

The tables are in [lib/games/schema.mjs](lib/games/schema.mjs) (schema version 5).
`tests/games.test.mjs` covers the rules without a server and `tests/games-api.test.mjs` every route on the production build, with `GAMES_V2=true` and a local stand-in for the GitHub API on its own port (`GAMES_TEST_GITHUB_API`, which `lib/grader/server.ts` ignores on the deployed Workers).

## Grade my portfolio

Owner decisions of 2026-11-10 ([docs/DECISIONS.md](docs/DECISIONS.md#grade-my-portfolio)): anyone can grade a portfolio with no account, on Gemini's free tier or their own key.
The back end is built and off: every route answers 404 and the five-minute cron does nothing until the Worker variable `GRADER_ENABLED` is `"true"`, which waits for the redesign's `/grade` and `/grade/[id]` pages.

```
visitor ── POST /api/grade ──► Worker: address checks, rate limit, Turnstile, own key checked (free)
                               free checks at once (plain fetch; link checks reused while unchanged)
                               re-grade cooldown, daily caps (one transaction), job row
                               workflow_dispatch grade.yml (no inputs)
                                      │
GitHub Actions grade.yml ◄────────────┘  claims every waiting job, captures it in Chromium
                                         behind a filtering proxy, uploads the screenshots
                                         to private/grades/<id>/ in the SHOTS bucket
          ├─ free tier ─► people queue (pipeline/people.mjs): 3.5 only, people's allowance
          │               busy or out of quota: waits; the hourly drain finishes it
          └─ own key ───► "awaiting_key": the visitor's browser sends the key once
                          (POST /api/grade/<id>/finish) and the Worker grades on it
report ◄── GET /api/grade/<id> (progress, then the report) ── email: one-time link
```

### The request

`POST /api/grade { url, turnstileToken?, geminiKey? }` ([app/api/grade/route.ts](app/api/grade/route.ts)), in this order, each step refusing before the next costs anything:

1. The flag, the `Origin` header (the site's own) and a JSON body of at most 8 KB.
2. The address ([lib/grader/url.mjs](lib/grader/url.mjs)): http or https (https when no scheme is given), ports 80 and 443 only, no user name or password, a public host name with a dot (never an IP literal, a local name or a private range, [lib/net-guard.mjs](lib/net-guard.mjs)), at most 500 characters; the query and fragment are dropped, so `?x=1` makes no new address for the caches, the caps or the cooldown.
3. A rate limit on attempts, before any work: 20 an hour per visitor and 60 per network (`rate_limits`).
4. Cloudflare Turnstile (action `grade`), refused on the deployed Workers when the `TURNSTILE_SECRET_KEY` secret is missing; the token's hostname must be the Worker's own (`SITE_URL`); only local runs skip it ([lib/turnstile.ts](lib/turnstile.ts)).
5. An own key, if sent, is checked with a free metadata call (`models.get` for `gemini-3.5-flash-lite`, no generate quota).
6. The free checks ([lib/grader/quick.ts](lib/grader/quick.ts)): one plain fetch from the Worker through `safeFetch` (every redirect hop re-checked, 10-second timeout, 1.5 MB cap, and `global_fetch_strictly_public` refuses names that resolve to private addresses), then the facts code can check (`pipeline/facts.mjs`, project links checked through the same fetch) and a fingerprint of the HTML's structure.
   The page is fetched again for every request (its fingerprint is what the cooldown compares); the project link checks are reused while the fingerprint is unchanged, for at most 30 days, and a failure for 10 minutes, in the `cache` table ("When checks re-run" above).
   A page that is unreachable, answers an error, is parked or isn't HTML gets a 422 with the reason and counts against nothing.
7. The re-grade cooldown ([lib/grader/jobs.mjs](lib/grader/jobs.mjs) `regradeCheck`, the budget's `regradeAllowed`): one grade per address every 7 days, sooner when the free checks' fingerprint changed since, and never two at once.
   Only the browser that owns the earlier report is told its id.
   Grading a listed site reuses nothing from the leaderboard's grade: it is always captured and graded fresh.
8. The daily caps ([lib/grader/caps.mjs](lib/grader/caps.mjs)), reserved in one write transaction so all three counters are taken or none: 3 a day per visitor (the signed-in account or the signed `pr_anon` browser cookie), 6 per network (the IPv4 address or the IPv6 /64, stored only as a keyed hash) and 100 site-wide, per Pacific day like the Gemini quota (`GRADER_CAPS` overrides them).
   Past the site-wide share a request is not refused: it waits for a later day (`waiting`, at most 200 at once) and its report is emailed.
9. The job: a row in `grade_jobs` whose id is 128 random bits, the report's only key; the browser gets the signed `pr_grades` cookie that makes it the report's owner.
10. The capture is handed to GitHub Actions ([lib/grader/dispatch.mjs](lib/grader/dispatch.mjs)): a `workflow_dispatch` of `grade.yml` with the Worker secret `GITHUB_DISPATCH_TOKEN`.
    Without the token the job is `unavailable` with a clear reason and the free checks are the answer.

The answer is 202 with the job (the same shape as `GET /api/grade/<id>`), or 400, 403, 404, 409 (`in_progress`, `cooldown` with `nextAt`), 422, 429 (`rate_limited`, `daily_limit` with the scope and `resetAt`) or 503 (`busy`).

### The capture on GitHub Actions

`grade.yml` runs [scripts/grade-jobs.mjs](scripts/grade-jobs.mjs) on a standard runner (free for this public repository), one run at a time (`grade-capture` concurrency group, never the nightly `gemini` group).

- **No inputs, public-safe logs:** the repository is public, so a run's inputs and log are public; the dispatch carries no inputs, the run claims every waiting job from the database (two runs never take the same one, a claim older than 20 minutes is taken over), and the log prints counts only, never an address, a job id or page text.
  A burst of requests rides on one run: a request within 45 seconds of a dispatch that hasn't been claimed yet doesn't dispatch again.
- **No private network:** Chromium's every request goes through a local filtering proxy ([pipeline/net-guard-node.mjs](pipeline/net-guard-node.mjs)) that resolves each host itself, refuses any that resolves to a private, loopback, link-local or metadata address, connects to the very address it checked (so DNS can't switch in between), allows only ports 80 and 443, refuses WebSocket upgrades and caps the page weight at 60 MB.
  Chromium runs with no secrets in its environment, service workers blocked, downloads off, dialogs dismissed and pop-ups closed.
  The link checks use `guardedFetch`, which follows redirects by hand and checks every hop the same way.
- **The capture** ([pipeline/grade-capture.mjs](pipeline/grade-capture.mjs)): the settled top of the page at 1440 x 900 and at 390 x 844, the rendered text, the facts, motion, dark mode, overflow and the page fingerprint, as the nightly capture does for listed sites.
  The screenshots go to the `SHOTS` bucket under `private/grades/<id>/`, which the site's public `/shots` route never serves; the report serves them at `/api/grade/<id>/shot/<file>` with private caching.
- **Retries:** a capture GitHub hasn't started within 10 minutes is dispatched again by the grader's tick or when someone checks the progress, at most 3 times, then the job fails with a reason.

### The grade

- **Free tier:** the captured job goes through the people queue ([lib/grader/queue.mjs](lib/grader/queue.mjs), [pipeline/people.mjs](pipeline/people.mjs)) on the runner: `gemini-3.5-flash-lite` only, the same rubric as the leaderboard (`pipeline/rubric.mjs`, contact details stripped from the page text first), logged as `people-grade` in `gemini_requests`, inside the budget accountant's people allowance (the whole day minus the evening reserve).
  A busy 3.5 is retried (10, 30, 60 seconds); then, or with today's quota spent, the job is `queued` and the Worker's hourly people-queue cron finishes it when 3.5 is available, with no fallback to 3.1.
  The same request also reads the roles the page claims (at most three).
- **Own key:** the job waits as `awaiting_key`; the visitor's browser, which keeps the key, sends it once in the JSON body of `POST /api/grade/<id>/finish { geminiKey }`, and the Worker grades on it at once with the same model and rubric (the grade says `own_key: true`).
  The key is never stored, logged, put in a URL or sent as a header to us (Workers Logs records request headers), and goes to Google only in the `x-goog-api-key` header; its requests are not written to `gemini_requests`, since they spend the visitor's quota.
  A rejected key, a spent quota or a busy Gemini leaves the job waiting with the reason; `{ freeTier: true }` hands it to the free tier instead.
- **The report** ([lib/grader/report.mjs](lib/grader/report.mjs)), built once when the grade is written: the measured facts and the AI's judgments apart, up to three strengths and three fixes (code, weighted by what each costs), the estimated rank and "top N%" among the listed graded portfolios (on the same level the leaderboard is seeded with, `lib/ranking/engine.mjs` `seedFromGrade`), up to four similar portfolios (same tier, closest level, shared roles first) and portfolios scoring 5 on the visitor's two weakest axes.
  The pool of graded portfolios is cached for an hour, so a report view never scans the `portfolios` table.

### Reading and owning a report

| Request | Answer |
| --- | --- |
| `GET /api/grade/<id>` | `{ id, url, domain, status, reason, ownKey, mine, steps, checks, shots, email: { requested, sent }, report }`; poll it every few seconds while `status` is `capturing`, `grading` or `queued` |
| `GET /api/grade/<id>/shot/hero.jpg` (and `mobile.jpg`) | the screenshot, private caching |
| `POST /api/grade/<id>/email { email, turnstileToken? }` | `{ requested, sent }`: the one-time link goes out when the report is ready |
| `GET /api/grade/link?t=<token>` | 303 to `/grade/<id>`; the first open makes this browser the owner |
| `POST /api/grade/<id>/finish { geminiKey }` or `{ freeTier: true }` | finishes an own-key grade |
| `DELETE /api/grade/<id>` | 204, the report's owner only; the screenshots go too |

`status` is one of `capturing`, `waiting`, `unavailable`, `grading`, `queued`, `awaiting_key`, `done` and `failed`; `steps` is the progress list (`checks`, `capture`, `grade`, each `done`, `running`, `waiting`, `pending`, `needs_key`, `off` or `failed`).
Reports are unlisted: the id is the only way in, every answer says `X-Robots-Tag: noindex, nofollow` and `Cache-Control: private, no-store`, and nothing returns the page text, the visitor or the network.
Reports and their screenshots are deleted after 180 days.

### The pages

- `/grade` is the form ("Grade yours" in the header and the phone tab bar); a grade started there or from home goes to `/grade/<id>`.
- `/grade/<id>` shows the progress while the grade runs (polling `GET /api/grade/<id>`, "get it by email", the own-key step) and then the report ([app/grade/[id]/page.tsx](app/grade/[id]/page.tsx), wording in [lib/grader/present.mjs](lib/grader/present.mjs)): the result, what a hiring manager sees, the five Gemini axes, the fixes with their expected effect, one portfolio doing it better, similar portfolios, and the owner's re-grade, delete and claim.
- "Download PDF" is the browser's own print on the page's print styles; the share image is `/grade/<id>/opengraph-image`, privately cached.
- Every `/grade/<id>` answer says noindex (the page's metadata and an `X-Robots-Tag` from next.config.ts).
- `/claim?url=<listed portfolio>` (GAMES_V2) runs the claim and the owner actions in the browser on `/api/owner/claims` and `/api/owner/actions`.
- The shell links to `/grade` only while `GRADER_ENABLED` is on: next.config.ts reads it at build time (the variable, else wrangler.jsonc's value for the Worker being built) into `ROUTES.grade`.
- `tests/grade-ui.test.mjs` covers the form, progress, report, empty state, print view, share image, the emailed one-time link, owner delete and the claim on the production build.

### Email

- **"Get it by email", no account needed:** the address waits in `grade_emails` until the report is ready (also after waiting in a queue or for a later day), then the grader's tick sends a one-time link and erases the address, keeping only a keyed hash so the same address isn't added twice; at most 2 addresses a report.
- **The link** ([lib/grader/links.mjs](lib/grader/links.mjs)): signed with `AUTH_SECRET`, expires in 7 days, works once (only a hash of its nonce is stored); opening it makes that browser the report's owner, and a used or expired link still leads to the report without granting anything.
  The same module makes the games' print report links (scope `report-link`, a day); each scope is signed apart, so a link of one never opens the other, and both live in `grade_links` with its `scope` column.
- **One gate** ([lib/email/gate.mjs](lib/email/gate.mjs)): every email (grade reports, the games' report links, owner alerts, the newsletter later) is counted in `email_sends` and stops at hard daily caps: 100 in all, 80 grade reports, 40 report links, 20 owner alerts and 3 to any one address (`EMAIL_CAPS` overrides them), under Cloudflare Email Service's beta daily limit.
  A refused or failed send counts too, so a broken provider can't become a retry storm; the log keeps a keyed hash, never the address.
  A report email the gate keeps refusing is given up after 3 days and its address erased.
- **The sender:** Cloudflare Email Service through the Worker's `send_email` binding `SEND_EMAIL`, from `EMAIL_FROM` (`portfoliorank@n8builds.dev`; n8builds.dev is onboarded for sending, as for Wren).
  Owner alerts go to `OWNER_EMAIL`, the owner's verified address, which is free.

### The grader's tick

A Cron Trigger every five minutes (`*/5 * * * *`, [worker/grader.ts](worker/grader.ts)) sends the report emails that are due, dispatches captures that didn't start again, starts requests that waited for a later day while that day's share has room, and once an hour deletes reports past 180 days with their screenshots, expired links, old cap counters and addresses waiting longer than 30 days.
While `GRADER_ENABLED` is not `"true"` it returns before reading anything.

### Tables

`grade_jobs`, `grade_caps` (a day of counters, left out of the backup), `grade_emails`, `grade_links` (every one-time link, the games' too; expired ones are also deleted by the nightly retention), `email_sends` and `email_outbox` (test runs only, left out of the backup), in [lib/grader/schema.mjs](lib/grader/schema.mjs).

### Testing

`tests/grader.test.mjs` (caps, cooldown, claims, dispatch, links, the email gate, report emails, the report, own keys and the people queue, with a mocked GitHub and Gemini), `tests/grader-capture.test.mjs` (the proxy and guarded fetch against private addresses, and a real Chromium capture through the proxy) and `tests/grader-api.test.mjs` (every route on the production build, with local stand-ins for the sites, GitHub and Gemini that `scripts/test-e2e.sh` turns on; `lib/grader/server.ts` ignores them on the deployed Workers).

## Email sign-in

Owner request of 2026-11-12: besides GitHub, anyone can sign in with an emailed one-time link; email accounts' votes count fully (owner decision: deal with fake accounts only if it actually happens).
It has its own launch switch (decision D3): `EMAIL_SIGNIN_ENABLED` in wrangler.jsonc, `"false"` in production and `"true"` on staging, inlined at build time as `NEXT_PUBLIC_EMAIL_SIGNIN_ENABLED` ([lib/signin/flag.ts](lib/signin/flag.ts)).
While it is off the sign-in dialog and Settings offer GitHub only, `/signin/email` and `POST /api/signin/email` answer 404, and the `email-link` provider is not registered, so nothing is sent.

- **The request** (`POST /api/signin/email { email, turnstileToken?, callbackUrl? }`, [app/api/signin/email/route.ts](app/api/signin/email/route.ts)): this site's Origin, a plausible address, 10 attempts an hour and 30 a day per network (the IPv4 address or IPv6 /64), Turnstile (action `signin-email`, refused on the deployed Workers without the secret), then 3 links an hour and 6 a day per address; networks and addresses are kept only as keyed hashes in `rate_limits`.
  The answer is the same `{ sent: true }` for any address that gets that far, new or known; 400 `bad_email`, 403 `bad_origin` or `turnstile_failed`, 429 `rate_limited` with `retry-after`, 503 `email_unavailable`.
- **The link** ([lib/signin/store.mjs](lib/signin/store.mjs)): 256 random bits, only its SHA-256 stored, 15 minutes to live, used once in one `UPDATE ... RETURNING`; a same-site `callbackUrl` brings you back to the page you were on.
- **The email** goes through the shared gate (kind `signin`: 40 a day, 10 of them kept for sign-in, 6 to one address a day, counted apart from reports) and then the mailroom service binding `MAILROOM` (app `portfoliorank`, kind `signin`, with the mailroom's priority share for sign-in); test runs keep it in `email_outbox`.
- **The landing page** `/signin/email?t=<token>` only reads the link and shows the masked address; its button uses it (Auth.js Credentials provider `email-link` in [auth.ts](auth.ts)), so a mail scanner that opens links can't sign anyone in or use the link up.
  A used, expired or unknown link says which, and offers a new one.
- **The account** (`email_accounts`): created at the first sign-in, one per address (a keyed hash is unique); the rater id is `em:<random id>`, which says nothing about the address; the session's `login` is the address, shown only to its owner.
- **What needs GitHub:** claiming a portfolio and the owner's actions (the proof is a link to the GitHub profile or a meta tag tied to it; an email account sees a note and continues with GitHub), and the admin pages (`ADMIN_GITHUB_ID`).
  `MIN_GITHUB_ACCOUNT_AGE_DAYS` applies to GitHub accounts only, so email accounts' votes count from the first day; the grader's trusted share (`TRUSTED_ACCOUNT_DAYS`) stays GitHub-only.
  Settings shows "Email" and the address; deleting the account asks for the address instead of a username, and deletes `email_accounts` and pending links with everything else.
- **Retention:** links leave the database at the next request and in the nightly retention a day after they expire; they are left out of the backup, accounts are in it.

## Newsletter

Owner request of 2026-11-12: people sign up on the blog and get each new post by email; the owner sees who signs up.
It replaces the planned weekly digest (docs/DECISIONS.md "A weekly newsletter"): one email per published post, at most two a week (the blog's publish cap).
Two switches, both needed (owner, 2026-11-13): `NEWSLETTER_ENABLED`, the deploy-level kill switch (wrangler.jsonc: `"false"` in production until launch, `"true"` on staging; the build also inlines it for the forms as `NEXT_PUBLIC_NEWSLETTER_ENABLED`, so while it is off pages make no status request at all), and the owner's stored switch, "Turn newsletter on/off" on `/admin/blog/newsletter` (off until turned on, no deploy needed).
The stored switch ([lib/newsletter/switch.mjs](lib/newsletter/switch.mjs), `POST /api/admin/newsletter/switch`, admin only) logs every change with who and when in `newsletter_switch_log`.
While either is off, or there is no `KIT_API_KEY`, no sign-up form shows anywhere (the forms and the settings note ask `GET /api/newsletter/status` once per page load, because the blog's pages are cached at the edge), `POST /api/newsletter/subscribe` answers 404, and the newsletter's tick queues and creates nothing, returning before any database read; Kit stays connected.
Kit (kit.com, free plan) keeps the list and sends the emails (owner, 2026-11-12, replacing the self-sent version through mailroom); our database keeps no address.

- **The forms** ([components/newsletter/NewsletterSignup.tsx](components/newsletter/NewsletterSignup.tsx)): after a post, on `/blog`, and in the site footer on every other page.
  An address ("Email for new posts") and Turnstile (action `newsletter`, loaded on first hover or focus).
- **The request** (`POST /api/newsletter/subscribe { email, turnstileToken?, source?, form? }`, [app/api/newsletter/subscribe/route.ts](app/api/newsletter/subscribe/route.ts)): this site's Origin, a plausible address, 10 attempts an hour and 30 a day per network, Turnstile (refused on the deployed Workers without the secret), then 3 sign-ups a day per address, all as keyed hashes in `rate_limits` like email sign-in.
  Then Kit ([lib/newsletter/kit.mjs](lib/newsletter/kit.mjs)): the address is created as an `inactive` subscriber and added to the sign-up form, with the page it came from as the referrer.
  The answer is the same `{ ok: true }` for a new, pending or confirmed address; 400 `bad_email`, 403 `bad_origin` or `turnstile_failed`, 429 `rate_limited`, 503 `email_unavailable` (Kit not set up or not answering).
- **Double opt-in and unsubscribe** are Kit's: the form has double opt-in on, so Kit sends its confirm email and only confirmed subscribers get posts; every broadcast carries Kit's unsubscribe link (`{{ unsubscribe_url }}`) and one-click header, and Kit handles bounces and complaints.
- **The form:** `KIT_FORM_ID` when set, else the account's only active form (asked once a day, cached); with several forms and no `KIT_FORM_ID`, sign-ups answer 503.
- **New posts** ([lib/newsletter/send.mjs](lib/newsletter/send.mjs), [worker/newsletter.ts](worker/newsletter.ts)): publishing a post sets `posts.newsletter_pending`; the newsletter's tick (on the five-minute grader cron `*/5 * * * *`, no trigger of its own; production and staging) turns each such post, once it is live, into an issue and the issue into one Kit broadcast to every subscriber.
  `KIT_BROADCAST_MODE` `"send"` (production) schedules it 10 minutes ahead (the V4 API has no "send now"); `"draft"` saves a draft, and so does a 403 when scheduling.
  A draft emails the owner one line, "Newsletter: draft ready in Kit", through the owner-alert gate to `OWNER_EMAIL`.
  Staging always makes drafts, with `[staging]` in the subject: it shares the owner's one Kit account.
  A post that went live more than 3 days before the newsletter saw it is recorded as "Not sent", so switching the newsletter on never mails a backlog; an unpublished post's issue stops.
  Each email ([lib/newsletter/emails.mjs](lib/newsletter/emails.mjs)): the title, the post's newsletter blurb (else its subtitle), the cover image, "Read the post", Kit's unsubscribe link and Kit's mailing address (`{{ address }}`).
- **Never twice:** an issue is claimed (`queued` to `creating`) before its one Kit call; a 429 puts it back in the queue, any other failure stops it with "check Kit", and a call that never reported back is stopped after an hour, never retried.
- **Admin** (`/admin/blog/newsletter`, linked from Blog drafts and the overview with the confirmed count): Kit's confirmed subscribers (asked fresh), whether the key and form are set, each post's broadcast (scheduled with its send time, draft ready, stopped with why), a link to Kit's broadcasts and a preview of the latest post's email (`GET /api/admin/newsletter/preview`).
  "Test the newsletter (Kit)" on the same page says newsletters go through Kit and site alerts through Cloudflare Email Service, shows the setup check (sender, its domain, the sign-up form, the confirmed count) and "Create a test draft in Kit" (`POST /api/admin/newsletter/test-draft`): the latest post as a draft marked `[test]`, never scheduled, with a link to it in Kit for Kit's own "Send test email".
  The setup check `GET /api/admin/newsletter/kit` (admin, or on staging the staging gate key in `x-staging-gate`) reads through the Worker: the Kit account and sending address, every form, the templates, the latest broadcasts, the confirmed count and the switches; `?probe=draft` makes a draft broadcast and deletes it at once, to prove the plan allows creating them.
  The overview, the Blog drafts link and the owner goals use the count cached for a day (`subscriberCount`, [lib/newsletter/server.ts](lib/newsletter/server.ts)).
- **Privacy:** no address is stored here; `newsletter_issues` holds only posts and broadcast ids, and the first version's subscriber tables are dropped by the schema; settings "Cookies and privacy" says Kit keeps the list.
- **Setup:** the `KIT_API_KEY` secret (V4 key, `pass-env pipe portfolio-rank/KIT_API_KEY -- npx wrangler secret put KIT_API_KEY [--env staging]`); `KIT_FORM_ID` only once the account has more than one form.
- **Tests:** [tests/newsletter.test.mjs](tests/newsletter.test.mjs) (the Kit client against a mocked API, broadcasts in both modes, the 403, 429 and 500 paths, stuck calls, the migration, the email) and [tests/newsletter-e2e.test.mjs](tests/newsletter-e2e.test.mjs) (production build with a Kit stand-in: guards, rate limits, what reaches Kit, no address in any table, Kit down, the admin page and preview, the forms at 1440 and 390 px).
- **Launching in production:** set `NEWSLETTER_ENABLED` to `"true"` in wrangler.jsonc (a deploy), add `KIT_API_KEY`, then turn on the owner's switch. From then on every page view asks `GET /api/newsletter/status` once (cached 60 seconds in the browser): one more Worker request per page view.


## Model watch

Owner decision of 2026-11-10: model watch is news only; nothing switches on its own.
Every Monday at 16:00 UTC (08:00 or 09:00 Pacific) a Cron Trigger on the Worker (`0 16 * * 1` in `wrangler.jsonc`, [worker/model-watch.ts](worker/model-watch.ts)) runs [pipeline/model-watch.mjs](pipeline/model-watch.mjs).

| Source | What it gives | Cost |
| --- | --- | --- |
| [models.list](https://aistudio.google.com/api-reference/models/list-models) (`GET /v1beta/models`, key in `x-goog-api-key`) | every model the key can use, with version, token limits, methods and thinking | nothing: a metadata call with no model and no tokens, so no model's generate quota (requests per day are counted per model) and no token price applies; it is not logged in `gemini_requests` |
| [Deprecations page](https://aistudio.google.com/docs/deprecations) | release date, earliest shutdown date and replacement per model | nothing (a public page) |
| [Release notes](https://aistudio.google.com/docs/changelog) | one section per date | nothing (a public page) |

Google serves both pages as Markdown, which the module parses; a page that stops parsing, a model list with fewer than 10 models, or an HTTP error is a failed source, never "every model was retired".
A failed source keeps last week's copy and raises its own alert.

Each run compares the sources with the last snapshot in `model_watch_runs` (one row a week, the last 60 kept) and reports: new models, models retired or deprecated (with their dates), other changes (version, token limits, replacement), Flash-Lite changes on their own, new or edited release notes (marked when they name a model in use), and the status of the models in use: `gemini-3.5-flash-lite` for grades and comparisons, `gemini-3.1-flash-lite` for labelled experiments.
The first run records a baseline instead of reporting every model as new.

It goes to the owner through the owner alerts, keys `model-watch:*`:

- `model-watch:report` (kind `news`): the week's report in plain words, while there are changes; a quiet week clears it.
- `model-watch:in-use:<model>` (kind `problem`): a model in use is missing from the list, deprecated, or within 90 days of its shutdown date; it holds every week until that is resolved.
- `model-watch:source:<source>` (kind `problem`): a source could not be read.

The weekly run reconciles only the `model-watch:*` keys and the end-of-day run never clears them.
They are emailed like every owner alert once `OWNER_EMAIL` is set ("Owner alerts" above); `GET /api/admin/quota` returns `modelWatch` (the latest report with its text, and the last 8 runs).
By hand: `pass-env run -- node scripts/model-watch.mjs [--dry-run]`.

## Owner goals

Milestones that call for a decision once they are reached, listed in [lib/goals/config.mjs](lib/goals/config.mjs) (owner decision 2026-11-13).
The first two:

- "Newsletter: 100 subscribers": 100 or more confirmed subscribers in Kit, which keeps the list; the count comes from Kit's API with `KIT_API_KEY` and is cached a day (`cache` row `kit:confirmed`), and without the key it is unknown and never reached.
- "Library: 5,000 graded portfolios": 5,000 or more listed portfolios with an AI grade (not counting sites judged "not a portfolio").

A goal is reached when any of its conditions holds; a condition may ask for two finished weeks in a row.
The check ([pipeline/goals.mjs](pipeline/goals.mjs), [worker/goals.ts](worker/goals.ts)) runs on the weekly Cron Trigger with model watch, Mondays at 16:00 UTC (8 am Pacific in winter, 9 am in summer), and is plain code with no Gemini.
It measures the week that just finished (Monday to Monday, Pacific) and records each goal's numbers in `goal_progress`.
The first time a goal is reached it records the event in `goal_events` and emails the owner through the owner-alert path (the email gate, kind `owner-alert`, to `OWNER_EMAIL`), with an `.ics` invite for a 30-minute decision slot three days later at 10:00 Pacific (moved to Monday from a weekend).
Once that email went out the goal never emails again, even if its number drops and climbs back; an email that couldn't go out is tried again the next Monday.
The same Monday email carries the owner review queue (`/admin/review`): while rows are pending, their count and the link go into the first goal email that goes out, or, when no goal fires, into a short email of their own; with nothing pending nothing is sent.
`GET /api/admin/goals` (admin only) returns every goal with its numbers measured now, its last 12 weeks, its event and, for a goal that is reached and not yet emailed, the email the next check would send.
By hand, always a dry run that writes and sends nothing (beyond refreshing the cached Kit count): `node scripts/goals-check.mjs [--now=2026-11-16T16:00:00Z] [--json]` (production numbers with `pass-env run --`).
To add a goal, add an entry with a new id to the list; never reuse an id, since the id is what records that a goal fired.

## GitHub Actions

All run on GitHub-hosted runners. The repo is **public → unlimited free Actions
minutes**; the only real budget is the Gemini free tier. Every scheduled job
files (and de-dupes) a GitHub **issue on failure**, so nothing fails silently.

| Workflow | Trigger | What it does | Secrets |
|---|---|---|---|
| **`ci.yml`** | PR → main | `tsc --noEmit` and the Worker build; gates what the next deploy ships | none |
| **`sync-upstream.yml`** | the end-of-day Workflow at 20:30 Pacific; fallback schedule 06:00 UTC + manual | The free checks: rebuild `feed.json` from upstream's merged README, open the sync PR if it changed, capture new sites and re-capture the oldest (`--refresh`), measure page evidence, record page changes. No Gemini, except as the fallback: the manual `grade` input, or a scheduled run (Cloudflare didn't start it) grades within the accountant's shares | TURSO, R2, SHOTS_BASE_URL (GEMINI only for `grade`) |
| **`health.yml`** | the end-of-day Workflow on Sunday nights; fallback schedule Mondays 12:00 UTC + manual | Roster sync, health check of every listed site, exclusions bot PR, purge of rows delisted 30+ days. No Gemini | TURSO, R2, SYNC_BOT |
| **`judge-vote.yml`** | manual only | Fallback: the ELO-era AI votes, or (repository variable `RANKING_V2`) the ranking v2 comparisons and recompute, within the accountant's share | TURSO, GEMINI, SHOTS_BASE_URL |
| **`grade-compare.yml`** | Sundays 18:00 UTC + manual | 3.1-vs-3.5 grade comparison report from `rubric_history`. No Gemini | TURSO |
| **`backup.yml`** | daily 05:00 UTC + manual | Gzip snapshot of every table but `cache` and `matchups`, with the schema, → private R2 bucket `portfolio-rank-backups`; restore with `scripts/restore-db.mjs` ([docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) section G) | TURSO, R2_ACCOUNT_ID, R2_BACKUP_* |
| **`prewarm.yml`** | daily 09:00 UTC + manual | Warm the PSI (Lighthouse) + inspect (polish) caches for every listed graded portfolio (whatever Gemini's letter; not "not a portfolio") without a fresh PSI result (never measured first, then oldest), up to 400 a day, by hitting the prod API | TURSO |
| **`grade.yml`** | started by the Worker for each "grade my portfolio" request (no schedule, no inputs) | Captures every waiting grade request behind the filtering proxy, uploads the screenshots to the private prefix, grades free-tier requests through the people queue ("Grade my portfolio" above) | TURSO, R2, GEMINI |
| **`upstream-removals.yml`** | 2nd of the month 17:00 UTC + manual | Report of what the community list's own Saturday checker misses; optionally (off) one PR for those | TURSO (read), UPSTREAM_PR_TOKEN (optional) |

The fallback schedules of `sync-upstream.yml` and `health.yml` are kept on purpose: a `fallback-guard` job skips the scheduled run when Cloudflare started the workflow in the last 20 hours (30 for the health check), so they only run when Cloudflare could not start them (no token, or the Worker down); a scheduled `sync-upstream.yml` run then also grades, so grading never stops.
Until the Worker has `GEMINI_API_KEY`, the Workflow skips the night without claiming it and this fallback does the night's work.
`judge-vote.yml` lost its schedule: AI comparisons run in the end-of-day run, and the ELO-era AI votes (30 a day into the shared ELO pool) no longer run on their own, since the owner's decision keeps background comparisons for `RANKING_V2`.
`grade-compare`, `backup`, `prewarm` and `upstream-removals` call no Gemini and nothing depends on their exact time, so they keep their GitHub schedules.
`sync-upstream` and `judge-vote` share the `gemini` concurrency group, so a manual fallback run and the nightly checks never overlap on the runner.

## Budget model

- **Gemini (free tier, shared):** the end-of-day run's accountant (above) for every job, people first.
- **R2 (10 GB free):** 143 KB of images a site (tall desktop and phone AVIF with thumbnails), plus 117 KB while hero.jpg and mobile.jpg are still uploaded (measured on 23 sites on 2026-11-13; [docs/audits/fullpage-images.md](docs/audits/fullpage-images.md)).
  About 0.6 GB for 2,300 sites, plus ~0.2 MB/day of backups: under the cap, $0.
  Lean, 10,000 sites take 1.4 GB and 50,000 take 7.2 GB (`lib/admin/limits.mjs` PROJECTIONS).
- **GitHub Actions:** unlimited (public repo).
- **PSI/Lighthouse:** 25k runs/day - ample.
- **Cloudflare:** Workers Paid; the Workflow uses one step per batch (about 30 to 60 a night) and a few minutes of CPU a month.

## AI judge (Gemini)

`pipeline/judge.mjs` calls Gemini through `pipeline/gemini.mjs`.

- **Rubric v2** (owner rule 2026-11-10: "code checks facts; Gemini judges quality"; criteria in GRADING_CRITERIA.md section 6, defined once in `pipeline/rubric.mjs`):
  `capture.mjs` stores each site's visible text (at most 4,000 characters, `portfolios.page_text`) and the facts code can check (`pipeline/facts.mjs`, `portfolios.facts`: resume, GitHub, contact, project links that load, own domain, footer year, pages and sections, template, motion, portfolio signals).
  A grade sends one image (the settled top of the page, local capture or R2 `hero.jpg`), the facts and the page text in a `<site_data>` block the system instruction marks as untrusted, with thinking at `minimal` and a strict JSON schema.
  Rows captured before v2 get their text and facts measured when graded (plain HTTP, or a browser when the server sends under 200 characters; `--no-browser` turns that off) and stored.
  Every grade records `rubric_version`, the model, token usage (input, output, thinking), the facts, the code checks, `quality_score` and `checks_score`.
- **Rubric eval:** `npm run eval:rubric -- --sample 30` estimates v1 and v2 tokens and cost offline for a seeded sample of graded sites (no Gemini); add `--live` to grade the sample with v2 on 3.5 only and compare with the stored grades (it checks today's quota first, logs as job `eval-rubric`, and never writes grades).
  Run it with the database and key through `pass-env run -- npm run eval:rubric -- --sample 30 --live`.

- **Key:** sent in the `x-goog-api-key` header, never as `?key=` in the URL.
  Newer AI Studio keys ("AQ." style) are rejected in the URL, and a URL key leaks into logs.
- **Models:** grades and AI votes come from `gemini-3.5-flash-lite` only, never from a lower model (owner's decision, 2026-11-10).
  An overloaded (5xx), timed-out or unreachable 3.5 is retried, same model, after 10, 30 and 60 seconds (jittered); if the last retry still fails, that item is left for the next run and the run stops.
  A 429 for a spent per-day quota (`RESOURCE_EXHAUSTED` on a `PerDay` quota) stops the run; the rest waits for tomorrow's quota.
  Any other 429 (per-minute) means slow down: wait Google's `RetryInfo` delay (or 60 seconds) and retry 3.5, up to 5 times.
  Why a run stopped early goes to its job summary ("Stopped early: ..."), including that there was no fallback.
  A rejected key (401, 403, 400 `API_KEY_INVALID`) or a bad request fails the call.
  `gemini-3.1-flash-lite` is only for explicitly labelled experiments (such as the 3.1-vs-3.5 comparison) and non-ranking analysis, never written into grades or ratings.
- **`GEMINI_FALLBACK`:** `off` by default; `on` brings back the per-call fallback to 3.1 from #54 (a call that still fails after its retries goes once to 3.1, and a spent 3.5 quota moves the run to 3.1).
  It exists for labelled experiments run by hand only: the run prints an "experiment mode" warning, and every answer keeps the model that gave it.
  `sync-upstream.yml` and `judge-vote.yml` pin it to `"off"` in their env, so no repository variable can turn it on for production grades or votes.
  `--model M` uses only `M`, with no fallback; for `pairwise`, any model other than 3.5 also needs `--allow-model`.
- **Pacing:** one limiter per run spaces every request evenly, retries included: `--rpm`, else the `GEMINI_RPM` repository variable, else 8 per minute.
  `sync-upstream` (grading) and `judge-vote` (voting) share the `gemini` concurrency group, so they never run at the same time.
- **Monitoring:** every Gemini HTTP request is a row in the `gemini_requests` table (time, job, run id, model, status, reason, latency, input, output and thinking tokens from `usageMetadata`, retry and fallback flags).
  Each run's job summary shows the requests per model, 5xx and 429 answers, retries, fallbacks, tokens and an estimated cost, plus the quota day's requests per model (midnight to midnight Pacific, when the free quota resets) against the daily free quota, with a warning from 80%.
  Each row's `job` is the budget's job name (`grade-new`, `grade-changed`, `compare`, `regrade`, `people-grade`, ...; older rows say `rubric` and `pairwise`).
  The quotas default to 500 a day for 3.5 and 500 for 3.1 (the owner's numbers) and can be changed with the `GEMINI_DAILY_QUOTA` repository variable (JSON, `{"model": requests}`).
  Cost estimates use `GEMINI_PRICES` (JSON, `{"model": {"in": usd_per_1M, "out": usd_per_1M}}`), else Google's published paid rates on 2026-11-10 (3.5 Flash-Lite $0.30 in / $2.50 out, 3.1 Flash-Lite $0.25 / $1.50); thinking tokens are billed as output.
- **Budget:** every grade, comparison and re-grade asks the budget accountant ([pipeline/budget.mjs](pipeline/budget.mjs), "End-of-day run" above); `GEMINI_GRADING_BUDGET` is gone.
  `judge.mjs rubric` (the manual fallback) starts a grade only with room for its 4 possible requests in the "Grade new sites" share, then re-grades in the "Re-grades" share.
  Sites past the budget are deferred to tomorrow, which is not a failure.
- **No catch-up mode:** catch-up mode (grading on 3.1's budget once 3.5's was used) was removed on 2026-11-10; the code no longer reads `GEMINI_CATCHUP`, and the repository variable is `"false"`.
- **Re-grade queue:** after new and ungraded sites, the rubric re-grades grades not made by 3.5 (oldest first) with whatever room 3.5's grading budget has left today; re-grades only ever run on 3.5.
  Lowest priority after that: 3.5 grades from an older rubric version (`rubric_version` below `pipeline/rubric.mjs` `RUBRIC_VERSION`; grades from before v2 count as 1), oldest first, only when the repository variable `RUBRIC_REGRADE` is `true` (off until the owner turns it on; about 2,000 grades, 4 to 5 days of 3.5's grading budget).
  Re-grading stops as soon as an answer comes from a model other than 3.5.
  The old grade (model, tier, `is_portfolio`, scores, date) moves to `rubric_history` instead of being overwritten, so each re-grade is a free 3.1-vs-3.5 pair; `--force` keeps history the same way, and `--no-regrade` turns the queue off.
  No new 3.1 grades are made, so the queue only shrinks: it holds the 3.1 grades written before 2026-11-10.
- **Comparisons:** a spent 3.5 quota or budget in `compare.mjs` is deferred too: the run exits 0 and counts the rest as waiting (the same rule as `judge.mjs` since #63).
- **Grade comparison:** `grade-compare.yml` (Sundays 18:00 UTC, database reads only) writes the number of 3.1-vs-3.5 pairs (same rubric version only), exact and within-one tier agreement, the mean absolute difference per axis and the `is_portfolio` disagreement rate to its run summary (`scripts/grade-compare.mjs`).
- **Failing loudly:** `judge.mjs` exits 1 when the key is rejected, when there was work and nothing was judged, or when most rows (or pairs) were skipped because their screenshots were unavailable, so the "Notify on failure" step files an issue.
  Skipped rows are counted on their own, never as attempted.
  The counts (queued, judged, abstained, errors, skipped, deferred) go to the run's job summary.
  A spent 3.5 quota or grading budget is planned waiting, not a failure: the rest is counted as deferred and the run exits 0, even with nothing judged.
  A 3.5 that stays busy through its retries stops the run too; it exits 0 if it judged something, and 1 if it judged nothing.
- **Which model judged:** each rubric stores the model that actually answered in `ai_rubric.model`, and each AI vote stores it in `votes.model`.
- **One AI voter:** every vote the flash-lite chain casts uses one logical rater id, `ai:flash-lite`, whichever model answered.
  `rater_id` is a voter's identity: the unique `(rater_id, pair_key)` index allows one vote per voter per matchup, and the judge skips pairs its rater id already voted on.
  Per-model rater ids would let the backup vote a second time on a pair the primary already judged, giving the AI two votes on that matchup and skewing ELO toward the AI.
  With one logical id, the database guarantees one AI vote per matchup, and the leaderboard (`ratings`, which never looks at `rater_id`) stays consistent.
  The first pairwise run moves the earlier `ai:gemini-3.1-flash-lite` votes to `ai:flash-lite` with `model = 'gemini-3.1-flash-lite'`, so the new judge does not re-vote those pairs.
  A model outside the chain (`--model M --allow-model`) is a different judge and votes as `ai:M`.

## Ranking v2 (built, not switched on)

The OpenSkill leaderboards (People, AI and Merged), the comparison log, the matchmaking and the stability analytics are described in [RANKING.md](RANKING.md).
Their tables are additive (`comparisons`, `site_ratings`, `rank_history`, `site_fingerprints`, `rating_resets`, `ranking_runs`) and nothing on the site reads them yet.
The daily comparison job (`pipeline/compare.mjs`) does nothing until the repository variable `RANKING_V2` is `true`.

## Required repo secrets

`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `GEMINI_API_KEY`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
`R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY` (an R2 token with Object Read & Write on `portfolio-rank-backups` only),
`SHOTS_BASE_URL` (public R2 base). Optional: `GH_SYNC_TOKEN` (keep the upstream
fork mirror synced too). The app reads `SHOTS_BASE_URL` from `wrangler.jsonc` vars to
serve images.

## Local pipeline scripts

- `pipeline/capture.mjs [--upload-only] [--only s] [--force]` - Playwright capture + R2 upload
- `pipeline/judge.mjs rubric|pairwise [flags]` - Gemini grading / voting (`node --test tests/gemini-judge.test.mjs tests/judge-run.test.mjs tests/rubric.test.mjs` tests it offline with a mocked Gemini)
- `npm run eval:rubric -- --sample 30 [--live]` - rubric v2 eval (offline token and cost estimate; `--live` grades the sample)
- `npm run docs:rubric [-- --check]` - regenerate (or check) the rubric table in GRADING_CRITERIA.md from `pipeline/rubric.mjs`
- `pipeline/generate_feed.py <readme> <out> [--exclude f] [--add f] [--max-shrink 0.05]` - build feed.json
- `pipeline/health-check.mjs [--limit N] [--no-browser] [--exclusions] [--dry-run]` - weekly health check (`LOCAL_DB_FILE=...` for a scratch database)
- `pipeline/purge-delisted.mjs [--dry-run]` - delete screenshots and rows delisted for 30+ days
- `node pipeline/owner-removals.mjs [--dry-run]` - add portfolios their verified owners removed to `data/excluded.json` (the weekly health workflow runs it)
- `node pipeline/review-additions.mjs [--dry-run]` - add sites the owner confirmed as portfolios on `/admin/review` that are off the list to `data/additions.json` (the weekly health workflow runs it)
- `pipeline/upstream-removals.mjs --readme <upstream README> --out <dir> [--cap 25]` - the monthly community-list report (and the optional PR)
- `node scripts/recompute-ratings.mjs [--read-only] [--export f] [--from f]` - rebuild the ranking v2 boards from the stored comparisons (RANKING.md)
- `node pipeline/compare.mjs` - ranking v2 AI comparisons by hand (off unless `RANKING_V2=true`)
- `node scripts/model-watch.mjs [--dry-run]` - the weekly model watch by hand (needs `GEMINI_API_KEY` for the model list; no generate calls)
- `node pipeline/fullpage-backfill.mjs [--limit N] [--minutes M] [--concurrency C] [--only s] [--dry-run]` - tall desktop and phone images with thumbnails (AVIF, `<shot_key>/<v>/`) for up to N listed sites captured before the capture made them; changes no grade, hero.jpg or capture date (the nightly free checks run it with a cap)
- `node pipeline/capture.mjs --refresh N` - also re-capture up to N sites whose screenshots are due: changed or asked for, then 90 days old (finds redesigns)
- `node pipeline/evidence.mjs [--limit N] [--links N] [--no-browser]` - measure page text and facts for rows waiting for a grade without them; `--links N` also measures again up to N sites whose project link checks are due
- `node scripts/detect-changes.mjs` - record page fingerprint changes (`rating_resets`)
- `node scripts/simulate-ranking.mjs [--grades csv] [--votes-log log] [--out dir]` - offline evaluation of ranking v2
- `scripts/backup-db.mjs` - DB → R2 snapshot · `scripts/restore-db.mjs` - snapshot → a new, empty database · `scripts/export-grades.mjs` - grades → CSV
- `scripts/r2-check.mjs` - R2 connectivity · `scripts/r2-upload-one.mjs <key>` - single-site upload
