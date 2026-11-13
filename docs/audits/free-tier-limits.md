# Free-tier limits audit

Owner rule: never pay, and grow to 50,000 portfolios inside the free tiers.
Measured on 2026-11-12 and 2026-11-13 (Pacific) from the providers' APIs and the databases, read-only on production.
The admin view of the same numbers is `/admin/limits` (PR "feat(admin): a Limits page", branch `feat/admin-limits`).

## Status of each item

| Item | Status |
| --- | --- |
| Measure today's usage of every free limit | done |
| Turso: nightly `site_ratings` writes only changed rows (fix 4) | done, on staging |
| Turso: `rank_history` written once per finished week, only changed rows (fix 5) | done, on staging |
| Turso: `MAX(week)` and the week delete no longer scan all of `rank_history` | done, on staging |
| Turso: hidden-site set reads a partial index instead of scanning `portfolios` | done, on staging |
| Turso: `/top` reads each view's size with one index seek instead of a `GROUP BY` | done, on staging |
| Turso: hourly tiers refresh reads the whole library every hour | needs owner (tiers lane, PR #137) |
| R2: stop storing `full.jpg` (never shown, 70% of the bytes) | done, on staging |
| R2: delete the 2,269 existing `full.jpg` objects (567 MB) | needs owner |
| R2: expire old builds' page-cache objects | needs owner |
| R2: hero as WebP | not started (later, if 50,000 is near) |
| Workers CPU on pace past the account's 30M ms | needs owner (other apps) |
| One admin view against every free limit | done, on staging |
| Daily account snapshot for that view | needs owner (Turso platform token) |

## Today's usage

Month to date is November 1 to 12 (12 of 30 days).

| Resource | Free limit | Used | Share | Month pace | Measured with |
| --- | ---: | ---: | ---: | ---: | --- |
| Turso rows read (whole account) | 500M a month | 7.1M | 1% | 4% | `turso plan show` |
| Turso rows written (whole account) | 10M a month | 0.3M | 3% | 7% | `turso plan show` |
| Turso storage (whole account) | 5 GB | 32 MB | under 1% | | `turso plan show` |
| R2 storage (whole account) | 10 GB | 3.97 GB | 40% | | R2 metrics API |
| R2 Class A operations | 1M a month | 42k | 4% | 11% | GraphQL Analytics |
| R2 Class B operations | 10M a month | 730k | 7% | 18% | GraphQL Analytics |
| Workers requests (whole account) | 10M a month | 246k | 2% | 6% | GraphQL Analytics |
| Workers CPU time (whole account) | 30M ms a month | 14.3M ms | 48% | **119%** | GraphQL Analytics |
| Gemini requests (PortfolioRank) | 500 a day | 488 | 98% | | `gemini_requests` |
| PageSpeed runs | 25,000 a day | under 100 | under 1% | | stored results |
| Email (gate) | 100 a day, 150 a month share | 0 | 0% | | `email_sends` |
| Workers AI neurons (PortfolioRank slice) | 2,500 a day | 0 to 2,320 | up to 93% | | `ai_image_calls` |
| Tavily credits (PortfolioRank share) | 200 a month | small | | | `tavily_credits` |
| Pexels searches | 500 a month (runaway cap) | small | | | `pexels_searches` |

Where each number goes:

- Turso, per database: production 3.07M read and 31k written, staging 3.58M read and 169k written; the other 11 databases together under 30k reads.
- R2, per bucket: `n8builds-web-opennext-cache` 1.82 GB, `portfolio-rank` 0.81 GB, `portfolio-rank-staging-opennext-cache` 0.58 GB, `portfolio-rank-opennext-cache` 0.30 GB, `n8builds-sanity-backups` 0.12 GB, the rest under 0.1 GB each.
- R2 operations: `n8builds-web-opennext-cache` made 30k of the 42k Class A and 684k of the 730k Class B.
- Workers CPU: `n8builds-web` 5.1M ms, unattributed 2.7M, `net-trailers` 1.3M, `feelium` 1.1M, `portfolio-rank` 0.9M, `pivot` 0.8M, `portfolio-rank-staging` 0.7M.
- Gemini fills its daily allowance on purpose (the background budget keeps a reserve for people), so 98% is normal there.

## What a site costs in storage

The screenshots bucket holds 2,270 sites in 6,868 objects, 811 MB.

| Frame | Mean | Median | 90th percentile | Shown anywhere? |
| --- | ---: | ---: | ---: | --- |
| `hero.jpg` (1440 x 900, JPEG 75) | 75 KB | 71 KB | 114 KB | yes, every card and page |
| `mobile.jpg` (390 x 844, JPEG 75) | 31 KB | 32 KB | 48 KB | yes, face-offs on phones |
| `full.jpg` (full page, JPEG 70) | 250 KB | 175 KB | 528 KB | no: no page, job or branch reads it |
| A site | 356 KB | 290 KB | 648 KB | |

Captures already keep one current set per site: the key is a hash of the address, so a recapture overwrites it and old sets never pile up.

The page caches are the other growing line.
OpenNext keeps each deploy's ISR entries under that build's id and never removes them, so production's cache bucket holds 81 builds and staging's 95, at about 150 KB per cached page.
Only the current build is ever read.

## Projections

Per-site rates measured above, other apps held at today's size, with this audit's fixes in place.

| Resource | Limit | Today | 5,000 sites | 20,000 sites | 50,000 sites |
| --- | ---: | ---: | ---: | ---: | ---: |
| Turso rows written, before | 10M a month | 0.5M | 2.8M | 9.5M (95%) | 23M (over) |
| Turso rows written, after | 10M a month | 0.5M | 1.0M | 2.5M | 5.5M (55%) |
| Turso rows read, before | 500M a month | 17M | 120M | 450M (90%) | over 1B (over) |
| Turso rows read, after | 500M a month | 17M | 30M | 70M | 150M (30%) |
| Turso rows read, after, if tiers stay hourly | 500M a month | 25M | 52M | 160M | 370M (74%) |
| R2 storage, before | 10 GB | 3.97 GB | 4.9 GB | 10.3 GB (over) | 21 GB (over) |
| R2 storage, after | 10 GB | 3.40 GB | 3.7 GB | 5.3 GB | 8.5 GB (85%) |
| R2 storage, after, with page-cache expiry and WebP heroes | 10 GB | 2.3 GB | 2.5 GB | 3.6 GB | 5.3 GB |
| PageSpeed runs | 25,000 a day | under 100 | 400 | 1,100 | 2,600 (10%) |
| Workers CPU (account) | 30M ms a month | 36M pace | | | |

Reads before the fixes are dominated by two queries that grow with every site and every visitor: the hidden-site set scanned all of `portfolios` every 5 minutes in every Worker isolate (776k rows on staging in 12 days with almost no traffic), and `/top` read every row of two views on each render.
Both now read only a handful of rows, so their cost no longer grows with the library.

Gemini, email, Workers AI, Tavily and Pexels do not grow with the library: they follow fixed daily budgets or visitors.
At the Gemini budget of about 100 grades a day, grading 50,000 sites takes over a year; that is a pace question, not a limit.

## What changed, with before and after

### Turso writes: the nightly recompute

Before, each recompute deleted and re-inserted every row of every view, then updated every `shown_rank`, then deleted and re-inserted the current week's history.
Measured on staging (2,270 sites, 3 views): one recompute wrote **48,023 rows** and read 46,591.
Turso counts about one write per row inserted, updated or deleted, not one per index entry.

After (`lib/ranking/store.mjs` `writeResults`):

- a row is upserted only when a value changed, with `shown_rank` computed in the same write;
- a site that left a view is deleted;
- history is written once per finished week, only rows that differ.

Measured on staging: a recompute with nothing new now writes **0 board or history rows**.
On a busy night most rows still change, because ranks are dense: one site moving shifts every site between its old and new place.
A simulation of 10,000 sites with the real daily budget shows 96% of rows changing per night, so the nightly cost is about 2.9 writes per site instead of 15, and the month's about 100 per site instead of 450.

Tests: `tests/turso-writes.test.mjs` (nothing new writes nothing; a night writes only moved rows and leaves exactly the board a full rewrite would; a site that leaves is deleted and shown ranks stay gapless; the latest week is an index seek; a week is written once, after it ends).

### Turso reads

- Hidden-site set (`lib/roster.ts`): a partial index `portfolios_hidden_idx` holds only hidden sites, so the query reads those rows instead of every portfolio.
  It is created by `pipeline/roster.mjs` `ensureRosterSchema` on the next capture or health run, and by a new database's migration.
- `/top` (`lib/leaderboard.ts`): each view's size is `MAX(shown_rank)` per view, a single index seek, instead of a `GROUP BY` over both views.
- `rank_history`: the latest week is found per view through the key instead of a bare `MAX(week)` over the whole table.

Tests: `tests/turso-reads.test.mjs` checks both query plans.

### R2

- Captures no longer take or upload `full.jpg` (`pipeline/capture.mjs`), so a new or recaptured site stores about 106 KB instead of 356 KB.
- `scripts/r2-drop-full-frames.mjs` lists the existing `full.jpg` objects (dry run by default) and deletes them only with `--apply`.
  It only ever touches keys of the form `<16 hex>/full.jpg`.

### The admin view

`/admin/limits` shows every resource above against its free limit, amber at 50% (docs/COSTS.md fix 10) and red at 80%, with a monthly count on pace past its limit shown red early, and the projections at 5,000, 20,000 and 50,000 sites.
Live rows (Gemini, PageSpeed, email, Workers AI, Tavily, Pexels) are counted by the app; account-wide rows come from `scripts/limits-snapshot.mjs`, run daily by `.github/workflows/limits.yml` and stored in `limit_snapshots`.
`GET /api/admin/quota` returns the same as `limits`.

## Owner decisions

1. **Workers CPU is on pace for about 36M ms this month, past the 30M included.**
   The overage would cost about $0.12, but the rule is never pay.
   `n8builds-web` uses 35% of it; PortfolioRank production and staging together 11%.
   Options: look at `n8builds-web`'s hot paths, or accept that Workers CPU is the account's one metered line.
2. **Delete the 2,269 `full.jpg` objects (567 MB) from the production screenshots bucket.**
   Run `node scripts/r2-drop-full-frames.mjs` (dry run), then with `--apply`, with the capture's R2 credentials.
3. **Expire old page-cache entries.**
   An R2 lifecycle rule on `portfolio-rank-opennext-cache` and `portfolio-rank-staging-opennext-cache` (and `n8builds-web-opennext-cache`, 1.8 GB) that deletes objects after 30 days would drop old builds' entries; a page whose entry expired is rendered again on its next visit.
   At 50,000 profile pages, one build's cache alone could reach several GB, so this matters before the library grows.
4. **The hourly tiers refresh** (`lib/tiers-store.mjs` `refreshTiers`, PR #137) reads every graded portfolio, its three check results, `rubric_history` and every face-off each hour: about 4,300 reads per site a month, 215M at 50,000 sites.
   Refreshing only when a vote, comparison or grade arrived since the last run, or every 6 hours, keeps it under 40M.
5. **A Turso platform token for the daily snapshot.**
   Create one (`turso auth api-tokens mint portfolio-rank-limits`), store it with `pass-env`, and set it as the `TURSO_PLATFORM_TOKEN` secret with `TURSO_ORG` as a repository variable.
   Check that the `CLOUDFLARE_API_TOKEN` secret has Account Analytics Read and R2 read; without them the workflow logs the Cloudflare rows as skipped.
6. **Weekly instead of nightly board ranks** (optional): the board's dense ranks are most of the remaining writes; recomputing ranks weekly would cut Turso writes by about 4 times again, at the cost of a board that moves once a week.
7. **WebP heroes** (later): converting `hero.jpg` to WebP would save about 40% more of the screenshots, but the share card renderer and every consumer of `hero.jpg` would need checking first.
