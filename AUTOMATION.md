# Automation & Architecture

How PortfolioRank stays current with **no manual work**. This is the source of
truth for the data flow and the GitHub Actions.

## Data flow

```
emmabostian/developer-portfolios (upstream, community-curated)
        │  (only MERGED entries — upstream review is the trust gate)
        ▼
  sync-upstream Action  ──rebuild──►  data/feed.json
        │                               = upstream − excluded.json + additions.json
        ▼
  roster sync  ──►  rows not in feed.json marked delisted (Turso portfolios.delisted_at)
        ▼
  capture.mjs (new + --refresh)  ──►  screenshots ──► Cloudflare R2   + diagnostics, page text, facts ──► Turso
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
| **Takedown / opt-out** | — | "Remove my portfolio" issue → `data/excluded.json` (dropped forever) |
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
- **Exclusions**: newly confirmed-down sites are appended to `data/excluded.json` as `{url, name, reason, kind, removed, first_failed, last_checked, checks}` and dropped from `feed.json` in one bot pull request (branch `data/health-exclusions`, auto-merge), at most 10% of the list at once.
  `generate_feed.py` reads both these objects and the older plain URL strings.
  `/removed` lists them with the reason and date; takedown requests are counted there but never named.
- **Site visibility** (`lib/roster.ts hiddenUrls`): a roster site is hidden when it is confirmed down, or when its capture failed and the health check hasn't passed it since.
  Captures that fail are retried with backoff (1, 2, 4, 8, 16, then 30 days), and a passing health check schedules a recapture at once, so one transient error never hides a site for good.
- **Feed shrink guard**: `generate_feed.py --max-shrink 0.05` refuses to write a feed more than 5% smaller than the current one, which fails the sync run instead of wiping the list.
- **Upstream report** (`upstream-removals.yml`, monthly, report-only): the community list runs its own link checker every Saturday that removes broken and parked links (its CONTRIBUTING.md, sample report emmabostian/developer-portfolios#3696), so a removal PR for those would only duplicate it.
  The monthly run summary lists only what that checker misses: entries we confirmed down for a reason a link checker can't see (blank page, redirect to a social profile, re-checked right before), entries graded "not a portfolio", and possible hijacks (redirects to an unrelated domain, recorded by the health check); entries their checker will catch are only counted.
  Opening one pull request for the first group (never `suspect` or AI-only entries, at most 25, in the list's own removal format, from the fork `n8watkins/developer-portfolios`) is off: it needs a manual run with `dry_run` off, or the repository variable `UPSTREAM_PR_ENABLED` set to `true` for the schedule, plus the `UPSTREAM_PR_TOKEN` secret.

## End-of-day run

Owner decisions of 2026-11-10 ("people first, AI with the leftovers"); the reasons are in [docs/DECISIONS.md](docs/DECISIONS.md#gemini-budget-one-key).
Gemini's free quota resets at midnight Pacific and unused requests are lost, so people's requests get the day and background AI gets what is left, once a night, just before the reset.
GitHub's own schedule starts jobs 4 to 10 hours late, so the clock is Cloudflare's.

| When (Pacific) | Where | What |
| --- | --- | --- |
| All day, as they arrive | Worker | People's grade and re-grade requests ([pipeline/people.mjs](pipeline/people.mjs), for "grade my portfolio" when it ships): the whole day's quota minus the evening reserve, 3.5 only; a request 3.5 can't answer waits in a queue |
| Every hour at :15 | Worker cron | Finishes queued people's requests when 3.5 is available, and emails the person |
| 20:30 | Worker cron, Workflow `portfolio-rank-night` | Starts tonight's run ([worker/night.ts](worker/night.ts)) |
| 20:30 to 21:15 at the latest | GitHub Actions, started by the Workflow | The free checks: `sync-upstream.yml` (feed, capture of new sites, re-capture of the 150 sites captured longest ago, page evidence, fingerprint changes); on Sundays also `health.yml` (not waited for) |
| Then until 23:30 | Workflow | The AI stages, in order, on what is left ([pipeline/night.mjs](pipeline/night.mjs)) |
| 23:30 | Workflow | Hard stop, 30 minutes before the reset; the summary and owner alerts |
| Then | Workflow | Roll-ups and retention of the log tables ([pipeline/retention.mjs](pipeline/retention.mjs)): `gemini_requests` older than 90 Pacific days becomes `gemini_daily`, `night_runs` older than 180 days and the free-text reason of comparisons older than 90 days go |

The cron: Cron Triggers run in UTC, so `wrangler.jsonc` has `30 3 * * *` (20:30 under daylight time) and `30 4 * * *` (20:30 under standard time); the handler starts the run only from the one that is 20:30 in Los Angeles, so the run starts at the same local time all year ([pipeline/budget.mjs](pipeline/budget.mjs) `isNightStart`, tested for every day of 2026 and 2027).
The Workflow instance is `night-<Pacific date>` and the night is claimed in the `night_runs` table, so a night runs once: a failed or stopped run never restarts itself.

### The stages

| Order | Stage (job name in `gemini_requests`) | Works on | Cap a day | Time cap |
| ---: | --- | --- | ---: | ---: |
| 1 | Grade new sites (`grade-new`) | listed, captured, ungraded, with page text and facts | 300 | 60 min |
| 2 | Grade changed sites (`grade-changed`) | graded before their page fingerprint changed (the free checks re-capture sites and record changes in `rating_resets`) | 100 | 30 min |
| 3 | AI ranking comparisons (`compare`) | ranking v2 one-on-one and batched comparisons, then the boards are rebuilt; only when the Worker variable `RANKING_V2` is `"true"` | 200 | 45 min |
| 4 | Content (`content`) | the weekly polls (below): at most one request a night and two a week; the content engine's posts join later | 100 | 30 min |
| 5 | Re-grades (`regrade`) | 3.1 grades on 3.5, then (`RUBRIC_REGRADE`) older rubrics | 300 | 60 min |
| 6 | Experiments (`experiment`) | none scheduled | 50 | 15 min |

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
`GET /api/admin/quota` (only for the GitHub login in `ADMIN_GITHUB_LOGIN`) returns Gemini use by quota day, job and model for the last 30 days, what each stage and people may spend now, the last 14 runs, parked items, owner alerts and people's queue; the redesign's admin page will show it.

### Owner alerts

After every run, [pipeline/alerts.mjs](pipeline/alerts.mjs) checks: the quota used up before the run, a stage stopped by the circuit breaker, parked items, and traction (people's grade requests or human votes in a day past `ALERT_TRACTION`, default 50 and 300).
A condition that holds sends one email a day, every day, until it clears; the state is the `owner_alerts` table.
The provider is Cloudflare Email Service (docs/DECISIONS.md), and alerts will go to the owner's verified address, which is free and doesn't count against the monthly sends; the Worker has no email binding yet, so the sender is off: alerts are recorded, logged and shown in the admin view, and none is marked sent until a sender is wired in `emailSender()` (with `OWNER_EMAIL`).

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
- **Guards on a vote:** the `Origin` header must be the site's own; at most 20 attempts per browser and 60 per IP an hour (`rate_limits`, the IP stored only as a keyed hash); Cloudflare Turnstile when the `TURNSTILE_SECRET_KEY` Worker secret is set (widget action `poll-vote`), skipped without it.
- **Privacy:** no API returns who voted for what; results are totals and percentages.
- **Results feed:** `pollResults(db, { since })` in [lib/polls/store.mjs](lib/polls/store.mjs) returns closed polls with totals, the winning option and the margin in points, for the content engine and the AI vs people comparisons; the public `past` list carries the same totals.
- **Turso reads:** a public read is a handful of indexed rows, at most once a minute per data center; a vote is one insert (plus the trigger's update) and two rate-limit upserts.

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
| **`prewarm.yml`** | daily 09:00 UTC + manual | Warm the PSI (Lighthouse) + inspect (polish) caches for listed S/A/B sites without a fresh PSI result (never measured first, then oldest), by hitting the prod API | TURSO |
| **`upstream-removals.yml`** | 2nd of the month 17:00 UTC + manual | Report of what the community list's own Saturday checker misses; optionally (off) one PR for those | TURSO (read), UPSTREAM_PR_TOKEN (optional) |

The fallback schedules of `sync-upstream.yml` and `health.yml` are kept on purpose: a `fallback-guard` job skips the scheduled run when Cloudflare started the workflow in the last 20 hours (30 for the health check), so they only run when Cloudflare could not start them (no token, or the Worker down); a scheduled `sync-upstream.yml` run then also grades, so grading never stops.
Until the Worker has `GEMINI_API_KEY`, the Workflow skips the night without claiming it and this fallback does the night's work.
`judge-vote.yml` lost its schedule: AI comparisons run in the end-of-day run, and the ELO-era AI votes (30 a day into the shared ELO pool) no longer run on their own, since the owner's decision keeps background comparisons for `RANKING_V2`.
`grade-compare`, `backup`, `prewarm` and `upstream-removals` call no Gemini and nothing depends on their exact time, so they keep their GitHub schedules.
`sync-upstream` and `judge-vote` share the `gemini` concurrency group, so a manual fallback run and the nightly checks never overlap on the runner.

## Budget model

- **Gemini (free tier, shared):** the end-of-day run's accountant (above) for every job, people first.
- **R2 (10 GB free):** ~570 MB of serve-frames (hero/mobile/full) + ~0.2 MB/day
  backups → far under the cap, $0.
- **GitHub Actions:** unlimited (public repo).
- **PSI/Lighthouse:** 25k runs/day — ample.
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

- `pipeline/capture.mjs [--upload-only] [--only s] [--force]` — Playwright capture + R2 upload
- `pipeline/judge.mjs rubric|pairwise [flags]` - Gemini grading / voting (`node --test tests/gemini-judge.test.mjs tests/judge-run.test.mjs tests/rubric.test.mjs` tests it offline with a mocked Gemini)
- `npm run eval:rubric -- --sample 30 [--live]` - rubric v2 eval (offline token and cost estimate; `--live` grades the sample)
- `npm run docs:rubric [-- --check]` - regenerate (or check) the rubric table in GRADING_CRITERIA.md from `pipeline/rubric.mjs`
- `pipeline/generate_feed.py <readme> <out> [--exclude f] [--add f] [--max-shrink 0.05]` - build feed.json
- `pipeline/health-check.mjs [--limit N] [--no-browser] [--exclusions] [--dry-run]` - weekly health check (`LOCAL_DB_FILE=...` for a scratch database)
- `pipeline/purge-delisted.mjs [--dry-run]` - delete screenshots and rows delisted for 30+ days
- `pipeline/upstream-removals.mjs --readme <upstream README> --out <dir> [--cap 25]` - the monthly community-list report (and the optional PR)
- `node scripts/recompute-ratings.mjs [--read-only] [--export f] [--from f]` - rebuild the ranking v2 boards from the stored comparisons (RANKING.md)
- `node pipeline/compare.mjs` - ranking v2 AI comparisons by hand (off unless `RANKING_V2=true`)
- `node pipeline/capture.mjs --refresh N` - also re-capture the N sites captured longest ago (finds redesigns)
- `node pipeline/evidence.mjs [--limit N] [--no-browser]` - measure page text and facts for rows waiting for a grade without them
- `node scripts/detect-changes.mjs` - record page fingerprint changes (`rating_resets`)
- `node scripts/simulate-ranking.mjs [--grades csv] [--votes-log log] [--out dir]` - offline evaluation of ranking v2
- `scripts/backup-db.mjs` - DB → R2 snapshot · `scripts/restore-db.mjs` - snapshot → a new, empty database · `scripts/export-grades.mjs` - grades → CSV
- `scripts/r2-check.mjs` — R2 connectivity · `scripts/r2-upload-one.mjs <key>` — single-site upload
