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
  capture.mjs  ──►  screenshots ──► Cloudflare R2 (public)   + diagnostics, page text, facts ──► Turso
        ▼
  judge.mjs rubric  ──►  rubric v2: Gemini tier + 5 quality scores, code checks ──► Turso (portfolios.ai_rubric)
        ▼
  judge.mjs pairwise  ──►  Gemini ELO votes ──► Turso (votes, ratings)
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

## GitHub Actions (8 scheduled)

All run on GitHub-hosted runners. The repo is **public → unlimited free Actions
minutes**; the only real budget is the Gemini free tier. Every scheduled job
files (and de-dupes) a GitHub **issue on failure**, so nothing fails silently.

| Workflow | Trigger | What it does | Secrets |
|---|---|---|---|
| **`ci.yml`** | PR → main | `tsc --noEmit` and the Worker build; gates what the next deploy ships | none |
| **`sync-upstream.yml`** | daily 06:00 UTC + manual | Rebuild `feed.json` from upstream's merged README, commit if changed, then **capture + AI-grade** new sites (serve-frames → R2) | TURSO, GEMINI, R2 |
| **`judge-vote.yml`** | daily 13:00 UTC + manual | Gemini **pairwise-metrics voting**: compare S/A/B pairs by hero (from R2) + cached Lighthouse/polish signals, cast ELO votes (≤30/day, flash-lite chain only) | TURSO, GEMINI, SHOTS_BASE_URL |
| **`grade-compare.yml`** | Sundays 18:00 UTC + manual | 3.1-vs-3.5 grade comparison report from `rubric_history`. No Gemini | TURSO |
| **`backup.yml`** | daily 05:00 UTC + manual | Gzip snapshot of `votes`/`ratings`/`ai_rubric` → private R2 bucket `portfolio-rank-backups` (~0.3 MB/run) | TURSO, R2_ACCOUNT_ID, R2_BACKUP_* |
| **`prewarm.yml`** | daily 09:00 UTC + manual | Warm the PSI (Lighthouse) + inspect (polish) caches for listed S/A/B sites without a fresh PSI result (never measured first, then oldest), by hitting the prod API, so the voting robot's comparisons have real metrics | TURSO |
| **`health.yml`** | Sundays 16:00 UTC + manual | Roster sync, health check of every listed site, exclusions bot PR, purge of rows delisted 30+ days. No Gemini | TURSO, R2, SYNC_BOT |
| **`upstream-removals.yml`** | 2nd of the month 17:00 UTC + manual | Report of what the community list's own Saturday checker misses; optionally (off) one PR for those | TURSO (read), UPSTREAM_PR_TOKEN (optional) |

Schedules are staggered: backup (05:00) → sync+grade (06:00) → vote (13:00, clear
of the sync window). `sync-upstream` and `judge-vote` share the `gemini`
concurrency group, so grading and voting never overlap; a run that has to wait
queues (its timeout only counts once it starts).

## Budget model

- **Gemini (free tier, shared):** grading self-limits to *new* sites/day; voting
  capped at 30/day. Both abort cleanly on sustained 429s. See the AI judge
  section below for the models.
- **R2 (10 GB free):** ~570 MB of serve-frames (hero/mobile/full) + ~0.2 MB/day
  backups → far under the cap, $0.
- **GitHub Actions:** unlimited (public repo).
- **PSI/Lighthouse:** 25k runs/day — ample.

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
- **Models:** `gemini-3.5-flash-lite` for everything until its quota is used up; `gemini-3.1-flash-lite` only then (owner's decision, 2026-11-10).
  An overloaded (5xx), timed-out or unreachable 3.5 is retried, same model, after 10, 30 and 60 seconds (jittered); if the last retry still fails, that one call goes to 3.1 and the next call is back on 3.5.
  A 429 for a spent per-day quota (`RESOURCE_EXHAUSTED` on a `PerDay` quota) moves the rest of the run to 3.1, except a grading run outside catch-up mode, which stops and waits for tomorrow.
  Any other 429 (per-minute) means slow down: wait Google's `RetryInfo` delay (or 60 seconds) and retry 3.5, up to 5 times.
  When no model can answer (both daily quotas spent, or still failing after the retries), the run stops cleanly; with nothing judged it exits 1, and the next run picks up the rest.
  A rejected key (401, 403, 400 `API_KEY_INVALID`) or a bad request never falls back.
  `--model M` uses only `M`, with no fallback.
- **Pacing:** one limiter per run spaces every request evenly, retries included: `--rpm`, else the `GEMINI_RPM` repository variable, else 8 per minute.
  `sync-upstream` (grading) and `judge-vote` (voting) share the `gemini` concurrency group, so they never run at the same time.
- **Monitoring:** every Gemini HTTP request is a row in the `gemini_requests` table (time, job, run id, model, status, reason, latency, input, output and thinking tokens from `usageMetadata`, retry and fallback flags).
  Each run's job summary shows the requests per model, 5xx and 429 answers, retries, fallbacks, tokens and an estimated cost, plus today's (UTC) requests per model against the daily free quota, with a warning from 80%.
  The quotas default to 500 a day for 3.5 and 500 for 3.1 (the owner's numbers) and can be changed with the `GEMINI_DAILY_QUOTA` repository variable (JSON, `{"model": requests}`).
  Cost estimates use `GEMINI_PRICES` (JSON, `{"model": {"in": usd_per_1M, "out": usd_per_1M}}`), else Google's published paid rates on 2026-11-10 (3.5 Flash-Lite $0.30 in / $2.50 out, 3.1 Flash-Lite $0.25 / $1.50); thinking tokens are billed as output.
- **Nightly budget:** grading has a daily budget per model (`GEMINI_GRADING_BUDGET`, JSON; default 400 for 3.5, which leaves 100 of its 500 for the 30 daily votes and their retries, and 450 for 3.1).
  It counts every request today (from `gemini_requests`, retries included) and starts a grade only with room for its 4 possible requests; `--limit 1000` is the upper bound.
  Sites past the budget are deferred to tomorrow, which is not a failure.
- **Catch-up mode** (repository variable `GEMINI_CATCHUP`, on unless set to `false`; turn it off once the backlog and the one-time full re-grade are done): grading uses 3.5's budget first and then 3.1's, so both quotas work through the backlog (about 850 grades a day).
  Every 3.1 grade goes on the re-grade queue for 3.5, which keeps the old grade for the comparison report.
  With catch-up off, grading waits for tomorrow's 3.5 quota instead of spending 3.1; a single grade that still fails on 3.5 after its retries goes to 3.1 either way.
  The vote job moves to 3.1 when 3.5's daily quota is spent in both modes.
- **Re-grade queue:** after new and ungraded sites, the rubric re-grades grades not made by 3.5 (oldest first) with whatever room 3.5's grading budget has left today; re-grades only ever run on 3.5.
  Lowest priority after that: 3.5 grades from an older rubric version (`rubric_version` below `pipeline/rubric.mjs` `RUBRIC_VERSION`; grades from before v2 count as 1), oldest first, only when the repository variable `RUBRIC_REGRADE` is `true` (off until the owner turns it on; about 2,000 grades, 4 to 5 days of 3.5's grading budget).
  Re-grading stops as soon as an answer comes from a model other than 3.5.
  The old grade (model, tier, `is_portfolio`, scores, date) moves to `rubric_history` instead of being overwritten, so each re-grade is a free 3.1-vs-3.5 pair; `--force` keeps history the same way, and `--no-regrade` turns the queue off.
- **Grade comparison:** `grade-compare.yml` (Sundays 18:00 UTC, database reads only) writes the number of 3.1-vs-3.5 pairs (same rubric version only), exact and within-one tier agreement, the mean absolute difference per axis and the `is_portfolio` disagreement rate to its run summary (`scripts/grade-compare.mjs`).
- **Failing loudly:** `judge.mjs` exits 1 when the key is rejected, when there was work and nothing was judged, or when most rows (or pairs) were skipped because their screenshots were unavailable, so the "Notify on failure" step files an issue.
  Skipped rows are counted on their own, never as attempted.
  The counts (queued, judged, abstained, errors, skipped) go to the run's job summary.
  Running out of daily quota after some successes still exits 0.
- **Which model judged:** each rubric stores the model that actually answered in `ai_rubric.model`, and each AI vote stores it in `votes.model`.
- **One AI voter:** every vote the flash-lite chain casts uses one logical rater id, `ai:flash-lite`, whichever model answered.
  `rater_id` is a voter's identity: the unique `(rater_id, pair_key)` index allows one vote per voter per matchup, and the judge skips pairs its rater id already voted on.
  Per-model rater ids would let the backup vote a second time on a pair the primary already judged, giving the AI two votes on that matchup and skewing ELO toward the AI.
  With one logical id, the database guarantees one AI vote per matchup, and the leaderboard (`ratings`, which never looks at `rater_id`) stays consistent.
  The first pairwise run moves the earlier `ai:gemini-3.1-flash-lite` votes to `ai:flash-lite` with `model = 'gemini-3.1-flash-lite'`, so the new judge does not re-vote those pairs.
  A model outside the chain (`--model M --allow-model`) is a different judge and votes as `ai:M`.

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
- `scripts/backup-db.mjs` — DB → R2 snapshot · `scripts/export-grades.mjs` — grades → CSV
- `scripts/r2-check.mjs` — R2 connectivity · `scripts/r2-upload-one.mjs <key>` — single-site upload
