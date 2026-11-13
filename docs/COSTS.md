# Costs

What PortfolioRank costs a month at three sizes, and how close each service gets to its limits.
Prices were read on 2026-11-10 from the official pages linked in [ASSUMPTIONS.md](ASSUMPTIONS.md); token counts per request come from [MODEL-LIMITS.md](MODEL-LIMITS.md).
Every number here is an estimate from the stated assumptions; the tests in ASSUMPTIONS.md replace them with measurements.

## Scenarios

| | Today | Modest | Popular |
| --- | --- | --- | --- |
| Portfolios on the list | 2,100 | 2,100 | 2,100 |
| Public grades a month ("grade my portfolio") | 0 | 1,000 | 10,000 |
| Visitors a month | about 300 (10 a day) | 10,000 | 100,000 |
| Gemini tier | free | paid Tier 1 | paid Tier 1 |

Shared assumptions:

- Background Gemini work follows the daily split in DECISIONS.md: 100 one-on-one comparisons, 100 batched comparisons (5 sites), 100 content requests and 50 backlog or re-grade requests a day, so about 10,500 requests a month.
- A public grade is one capture, one Gemini request (plus 5% retries) and about 330 KB of screenshots in R2.
- If graded sites join the leaderboard, each needs about 10 placement comparisons (DECISIONS.md, "Placement experiment"); the tables show both one-on-one placement and one 10-site batched request.
- A visitor makes about 5 Worker page or API requests and 40 screenshot requests.
- Paid Gemini is required from the day the grader is public, whatever the volume: the terms allow only Paid Services for users in the EEA, Switzerland and the UK (ASSUMPTIONS.md A9).
  The modest scenario's 570 or so requests a day would also outgrow a 500-a-day free quota.
- Browser work stays on GitHub Actions (owner, 2026-11-10); Browser Rendering is shown as a later option only.

## Monthly cost

| Line | Today | Modest | Popular | Price basis |
| --- | --- | --- | --- | --- |
| Workers Paid base (the account's plan: the $5 a month add-on, not Pro or a zone plan) | $5.00 | $5.00 | $5.00 | $5 a month |
| Workers requests (10M included) | $0 (about 14k) | $0 (about 450k) | $0 (about 4.5M) | then $0.30 per million |
| Workers CPU (30M ms included) | $0 | $0 | $0 to $0.05 (about 28M ms, measure) | then $0.02 per million ms |
| Workers Logs (20M events included) | $0 | $0 | $0 | then $0.60 per million |
| Workflows, Queues, KV | $0 | $0 | $0 | inside the included amounts |
| R2 storage (10 GB free) | $0 (0.7 GB) | $0 (grows 0.33 GB a month) | $0 for 3 months, then about $0.05 per month added (grows 3.3 GB a month) | $0.015 per GB-month |
| R2 operations | $0 | $0 | $0 (Class A about 40k, Class B under 4M) | 1M Class A and 10M Class B free |
| Workers AI illustrations | $0 | $0 | $0 | 10,000 neurons a day free; PortfolioRank capped at 40 images (2,500 neurons) a day by code ([Workers AI](#workers-ai)) |
| Web Analytics | $0 | $0 | $0 | on every plan, no price listed |
| GitHub Actions (public repository) | $0 | $0 | $0 | standard runners free |
| Turso (Free plan) | $0 | $0 with the fixes in section C (without them reads exceed Free around month 5) | $0 with the fixes; without them Free blocks in the first week and Developer costs about $5 to $10 | section C |
| Gemini background work | $0 (free tier) | $23 ($17 with Batch API) | $23 ($17 with Batch API) | below |
| Gemini public grades | $0 | $1.50 | $15 | $0.0014 a grade plus 5% retries |
| Gemini placement of graded sites | $0 | $11 one-on-one, $4 batched | $110 one-on-one, $42 batched | $0.011 or $0.0042 a site |
| **Total a month** | **$5** | **$34 to $41** | **$85 to $153** | |
| Google Play (one time, if pursued) | $25 | | | |
| Option: captures on Browser Rendering instead of Actions | $0 | $0 (8 of 10 included hours) | about $6.60 (83 hours) | $0.09 per hour over 10 |

Gemini background work at paid rates (3.5 Flash-Lite, $0.30 input and $2.50 output per 1M tokens):

| Job | Requests a month | Cost per request | Month |
| --- | --- | --- | --- |
| One-on-one comparisons | 3,000 | $0.0011 | $3.30 |
| Batched comparisons (5 sites) | 3,000 | $0.0022 | $6.60 |
| Content engine (assumed 4,000 in, 1,000 out) | 3,000 | $0.0037 | $11.10 |
| Backlog and re-grades | 1,500 | $0.0014 | $2.10 |
| **Total** | **10,500** | | **$23.10** |

Comparisons and re-grades can wait a day, so the Batch API (half price) brings them to $6 and the total to about $17; content may need answers within a run and stays at the standard rate.
Flex is also half price, but paid-tier Flex prompts are used to improve Google's products, so it is not used.

Limits to watch on the Gemini side:

- Tier 1 has a $250 monthly billing cap per billing account; the popular scenario with one-on-one placement uses about 60% of it.
  Set the experimental project spend cap in AI Studio and keep the in-app daily cap (DECISIONS.md).
- Requests per day on Tier 1 are not public (ASSUMPTIONS.md test G1); the popular scenario averages about 700 a day, with launch-day peaks several times that.

## Section C: Turso free limits against our growth

Turso Free allows 500 million rows read, 10 million rows written and 5 GB a month; going over any one blocks every query (ASSUMPTIONS.md section C).
The owner decided to stay on Turso for now (2026-11-10), so the job is to keep well under these limits.

How rows are counted matters: a written row counts once for the table and once more for each index on it, an update reads and writes the row, and a read counts every row scanned, so `COUNT(*)` and `GROUP BY` over a table read all of it.
The numbers below are estimates from the code as of 2026-11-10 and should be checked against the Turso dashboard (ASSUMPTIONS.md test T1).
"Month N" counts from the launch of public grading; the popular and modest scenarios assume every graded site joins the board (2,100 plus 1,000 or 10,000 a month) and people's votes land in `votes` at 1 per visitor.
The live `/top` page showed 92 votes in `votes` on 2026-11-10.

### Short answer

- **Logs are not the problem.** `gemini_requests`, `comparisons`, poll votes and (rolled-up) analytics together stay under 2 million writes and a few hundred MB a year even in the popular scenario.
- **Reads hit the limit first, from two queries that scan whole tables on every page view:**
  `/top` runs `SELECT COUNT(*) FROM votes` and a `GROUP BY winner` over `votes` on each render (up to once a minute), and `/api/leaderboard` (`readBoard`) reads every row of a view with no `LIMIT` on every request, uncached.
  Without fixes, reads cross 500 million around month 5 in the modest scenario and in the first week in the popular one.
- **Writes hit the limit next, from the nightly `site_ratings` rewrite**, which deletes and re-inserts every site in three views: about 360 writes per site per month.
  It crosses 10 million writes at about 28,000 sites on the board: never at today's 2,100, in month 2 of the popular scenario.
- Going over on Turso Free means an outage, not a bill; on Developer ($4.99) the same overage costs about $1 per billion reads and $1 per million writes.

### Writes a month (limit 10 million)

| Source | Today | Modest, month 1 | Modest, month 12 | Popular, month 1 | Popular, month 12 | Per unit |
| --- | --- | --- | --- | --- | --- | --- |
| `site_ratings` nightly rewrite | 760k | 1.1M | 5.1M | 4.4M | 44M | 360 a site |
| `rank_history` weekly snapshot | 55k | 80k | 370k | 320k | 3.2M | 26 a site |
| `comparisons` (AI, people, placement) | 25k | 105k | 105k | 820k | 820k | 4 a row |
| `gemini_requests` | 30k | 55k | 55k | 250k | 250k | 2 a request |
| Grades and captures | 10k | 20k | 20k | 110k | 110k | 10 a grade |
| `votes` (people) | under 1k | 20k | 20k | 200k | 200k | 2 a vote |
| Analytics events stored raw (5 a visitor) | 3k | 100k | 100k | 1.0M | 1.0M | 2 an event |
| Poll votes (the vote row and its two indexes, the total, two rate-limit counters) | 0 | 4k | 4k | 35k | 35k | 7 a vote |
| **Total** | **0.9M (9%)** | **1.5M (15%)** | **5.8M (58%)** | **7.1M (71%)** | **50M (over)** | |

Popular crosses 10 million in month 2; modest crosses it in about year 2.

### Reads a month (limit 500 million)

| Source | Today | Modest, month 6, as built | Popular, month 1, as built | Any scenario, with fixes 1 to 3 |
| --- | --- | --- | --- | --- |
| `/top` (two full scans of `votes` a render, up to 1,440 renders a day) | under 1M | 550M | 4.4B | under 5M |
| `/api/leaderboard` (whole view a request, uncached) | 0 (not used yet) | 30M | 700M | under 10M |
| Home and portfolio pages (ISR, roster and screenshot lookups) | under 1M | 10M | 90M | 90M |
| Nightly recompute (`loadInput` reads every comparison and vote) | under 1M | 7M | 9M | 9M (75M by month 12) |
| Daily backup (full read of three tables) | under 1M | 2M | 3M | 3M (40M by month 12) |
| Gemini ledger, budgets and reports (indexed) | under 1M | under 1M | 5M | 5M |
| **Total** | **about 2M** | **about 600M (over)** | **about 5.2B (over)** | **about 120M to 220M** |

The games back end (`GAMES_V2`, off; AUTOMATION.md "Games, badges, claims, live stats and reports") was built to these rules: a quiz or guess reads a few rows by primary key, the quiz pool reads the board at most every 3 hours, a badge check reads only the player's own rows (votes, plays, guesses, lists; typically under 100, capped at about 3,000) and is reused for 15 seconds, and the live stats read the list once an hour and a few indexed rows a minute per data center.
At the popular scenario's 100,000 visitors a month, with a quarter checking badges five times at about 100 rows, that is about 13 million reads a month, inside the "with fixes" total.

### Storage (limit 5 GB)

| Table | Size per row | Today, per month | Popular, per month |
| --- | --- | --- | --- |
| `comparisons` (shown order, ranking, reason) | about 1 KB | 6 MB | 210 MB |
| `gemini_requests` | about 250 B | 4 MB | 30 MB |
| `portfolios` (page text up to 4,000 characters, rubric) | about 8 KB | 0 (fixed list) | 80 MB |
| Analytics events stored raw | about 200 B | under 1 MB | 100 MB |

Today's database is small (the nightly snapshot of three tables is about 0.3 MB gzipped).
At the popular pace it grows about 420 MB a month and reaches 5 GB in about a year; at today's pace, never in practice.

### Fixes, roll-ups and retention (recommended)

Reads, in order of impact:

1. **Counters instead of `COUNT(*)` on `/top`.** Keep the total vote count and the star counts in a small `stats` table updated in the same transaction as each vote, or compute them in the nightly job; the page then reads a handful of rows.
2. **Read only the requested page of the board.** `readBoard` should use `WHERE view = ? AND rank > ? ORDER BY rank LIMIT ?` on the existing `(view, rank)` index and drop hidden sites when the board is computed, not on every request; and the API response should be cached at the edge (the Cache API in the Worker) for the 300 seconds it already declares.
3. **Make the nightly recompute incremental** once comparisons pass about 500,000: start from the last `ranking_runs` state and read only newer comparisons.

Writes:

4. **Write only what changed in `site_ratings`.** Upsert the rows whose rank, rating or certainty moved instead of deleting and inserting all three views each night.
5. **Store `rank_history` only for sites whose rank moved** that week.

Log tables:

6. **`gemini_requests`: keep raw rows 90 days**, then one row per Pacific day, model, job and status (requests, tokens in, out and thinking, latency percentiles) in a `gemini_daily` table; budgets need only today's rows and reports only the daily table.
7. **Never store raw analytics events.** Cloudflare Web Analytics covers page views; product events become daily counters (one row per day, event and page) through `INSERT ... ON CONFLICT DO UPDATE`.
8. **Poll votes: keep per-person rows until a poll closes plus 30 days** (duplicate checks and deletion requests), then totals only.
9. **`comparisons` stay** (the open method and the recompute need them); export each closed month to R2 as the public comparison log and clear `reason` text older than 90 days.

Watching:

10. **A monthly look at Turso's usage page**, with an alert at 50% of any limit; at that point fix the biggest line or move to Developer ($4.99) or D1 (ASSUMPTIONS.md section E).

With 1, 2, 4 and 6 to 8 in place, the popular scenario stays under about 3 million writes and 220 million reads a month in its first year, inside Turso Free.

### Status (2026-11-10, #72)

Built:

- Fix 1: `vote_totals` and `star_counts` are kept by triggers on `votes` (every writer, same transaction); `/top` and portfolio pages read them, and `/top` renders at most every 5 minutes instead of every minute.
- Fix 2: the recompute stores each site's rank among the shown sites (`site_ratings.shown_rank`); `/api/leaderboard` reads one page through the `(view, shown_rank)` index plus two single-row lookups, and each answer is kept in the data center's Cache API for 5 minutes.
- Also for reads: the hidden-site set (a scan of `portfolios`) is kept per isolate for 5 minutes instead of being read on every render and vote.
- Fix 6: `gemini_requests` keeps 90 Pacific days raw, then one `gemini_daily` row per day, model, job and outcome; `night_runs` keeps 180 days.
- Fix 9: `comparisons` stay whole; only `reason` is cleared after 90 days.

Built later (2026-11-13, [audits/free-tier-limits.md](audits/free-tier-limits.md)):

- Fixes 4 and 5: the recompute upserts only `site_ratings` rows whose values (shown rank included) changed, and writes each week's `rank_history` once, after the week ends, only rows that differ.
  Measured on staging at 2,270 sites, a recompute wrote 48,023 rows before and none with nothing new; Turso counts about one write per row, not one per index entry, so the per-site estimates above were low before the fix.
- The hidden-site set reads a partial index of hidden sites, and `/top` reads each view's size with one index seek.
- Fix 10 is now a page: `/admin/limits` shows every free limit against its cap, amber at 50%.

Not yet: fix 3 (incremental recompute), 7 and 8 (no analytics events or polls are stored yet).

Estimated reads a month, before and after:

| Scenario | As built before | With these fixes |
| --- | --- | --- |
| Today | about 2M | about 1M |
| Modest, month 6 | about 600M (over) | about 40M |
| Popular, month 1 | about 5.2B (over) | about 140M |

The largest remaining lines are home and portfolio pages (ISR renders) and the nightly recompute.
One line grows instead: the nightly backup now reads every table, so in the popular scenario it reaches about 100M a month by month 12 (mostly `comparisons`); when it passes about 50M, back up `comparisons` incrementally (only rows newer than the last snapshot) or weekly in full.

## GitHub Actions for browser work

| | Today | Modest | Popular |
| --- | --- | --- | --- |
| Cost (public repository, standard runners) | $0 | $0 | $0 |
| Runner time for captures (30 s each) | under 1 hour | about 8 hours | about 83 hours |
| Concurrent jobs (GitHub Free limit 20) | 1 to 2 | 1 to 2 | 2 to 4 if captures are batched every 15 minutes |

- Start delay measured on this repository (2026-11-10, 72 jobs): 2 s median and 4 s at worst from job creation to start, plus 35 to 50 s of setup (`setup-node`, `npm ci`, Playwright install) before the first capture.
- Worst case: during GitHub's 2026-07-09 incident about 8% of hosted runs started more than 5 minutes late and about 2% did not start; the grade queue should re-dispatch a job not started after 10 minutes.
- Terms risk: GitHub's Actions terms bar use "as part of a serverless application" where the burden outweighs the benefit and, on hosted runners, activity unrelated to the software project (ASSUMPTIONS.md section F); batching on-demand captures and keeping Browser Rendering ready limits that risk.

Sources for this section are in ASSUMPTIONS.md section F.

## Staging

Measured on 2026-11-10; the site is described in [DECISIONS.md](DECISIONS.md) ("A staging site checks every change before production").

- Cloudflare: the account is on Workers Paid, the $5 a month add-on (not Pro or any zone plan), which includes 10M Worker requests a month.
  Staging's Worker served 677 requests that day against 4,754 for production, so its usage sits well inside that allowance.
- Idle cost: staging has no Cron Triggers, no Gemini key and no dispatch token, so it spends nothing while nobody uses it.
- R2: each deploy leaves its build's ISR cache behind (about 10 MB a build), which had grown to 970 MB in staging and 383 MB in production by 2026-11-12.
  Every deploy now removes all but the newest two builds (`scripts/prune-build-cache.mjs`), so each cache bucket stays near 20 to 30 MB, inside the free 10 GB.
- Email: sends only go through the capped gate, to verified addresses.
- Turso: the account is on the Starter plan with overages disabled, so it cannot bill.
  Staging's database is 2.4 MB; the whole account uses 11 MB of 5 GB and 1.7M of 500M rows read.
- GitHub Actions: staging adds about a minute per push to main.
- Total extra cost: $0.

## Tavily credits

PortfolioRank and Wren share one free Tavily account: 1,000 credits a month and 100 requests a minute across both keys.
PortfolioRank may use 200 credits a month (`TAVILY_MONTHLY_CREDITS`, in both environments of `wrangler.jsonc`), Wren 750, which leaves 50 spare (owner, 2026-11-10).
Credits are counted by Tavily's pricing ([Tavily credits](https://docs.tavily.com/documentation/api-credits)): a basic search is 1 credit and an advanced one 2.
The content engine only calls the basic search without page text, so each claim check is 1 credit, and it calls no extract, map or crawl endpoint.
Tavily's own page says only "1,000 free API credits every month"; other sources say the reset is the 1st of the calendar month, so the counter uses the UTC calendar month and the 50 spare credits cover any difference.
The count is the `tavily_credits` table (one row per month), and each search reserves its credit before the call, in a single statement that only succeeds while the month stays within the cap.
At the cap outside claims are cut, exactly as when `TAVILY_API_KEY` is missing.
The credit is given back when Tavily answers with an error.
The month's use and the cap show in `GET /api/admin/quota` as `tavily`.
The weekly cap (50 searches, a quarter of the monthly 200; 40 until 2026-11-11, raised so "Write a draft now" fits beside the nights) and the per-post cap (10) still apply on top of the monthly one.

## Pexels

The blog image library uses Pexels as a licensed stock source (one search per image slot, at most 2 per post).
The account is nathancwatkins23@gmail.com, with one API key, stored in pass as `portfolio-rank/PEXELS_API_KEY` (also set on the Worker as `PEXELS_API_KEY`).
Pexels is free and its limits are 200 requests an hour and 20,000 a month.
Expected use is about 16 searches a month (at most 2 searches per post, 2 posts a week), well under both limits.
The engine counts Pexels searches per UTC month (`pexels_searches`) and shows them in `GET /api/admin/quota` as `pexels`, like Tavily; `PEXELS_MONTHLY_SEARCHES` (500 by default) only stops a runaway.

## Workers AI

Owner decisions 2026-11-10: never pay; every image comes from free daily allowances only ([DECISIONS.md](DECISIONS.md#content-engine)).

**The limit: at most 40 AI images a UTC day** (`MAX_AI_IMAGES_PER_DAY`, counted per image, that is per Workers AI call, whether it succeeds or not), with no hourly cap of its own.
Owner, 2026-11-11: "40 a day only", replacing the earlier 2 in any rolling hour, so "Make now" can make a batch at once; the `portfoliorank-ai` AI Gateway's sliding rate limit of 40 per 3,600 seconds is the burst backstop ([AI-GATEWAY.md](AI-GATEWAY.md)).
That covers the library's hourly batches, the owner's "Make now" and each post's one fresh image together.
The day's 40 and the neurons did not change, so the most a day can cost is the same: about 2,320 neurons, $0.
Behind it, a neuron guard: at most 2,500 neurons a UTC day (`AI_NEURON_CEILING`); 40 Schnell images are about 2,320.
The settings can be lowered, never raised: a value above 40 or 2,500, or one that isn't a whole number, is rejected and fails closed (no Workers AI call at all; the library says why and `GET /api/admin/quota` shows it as `aiImages.problem`).
Staging's limits are 0.

- Before each call, one image and the call's estimated neurons are reserved for the UTC day ([lib/content/neurons.mjs](../lib/content/neurons.mjs), table `ai_image_calls`, one row per call) in one statement that only succeeds while the day's images, the last hour's images and the day's neurons all stay within their limits; without room the call is skipped, never retried, and a reservation is never given back.
- The account's free allowance is 10,000 neurons a day, shared by every app on the account, and resets at 00:00 UTC ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)).
  The account is on Workers Paid, so anything above it would be billed at $0.011 per 1,000 neurons.
- The allowance is split into slices so the account never passes 10,000 (owner, 2026-11-10; the account-wide table is `LIMITS.md` in the owner's ops notes):

  | Slice | Neurons a UTC day | Enforced by |
  | --- | ---: | --- |
  | PortfolioRank images | 2,500 at most (40 images, about 2,320) | `MAX_AI_IMAGES_PER_DAY`, `AI_NEURON_CEILING`, the `ai_image_calls` counter in this repository, and the AI Gateway's 40 an hour and $1 a month Workers AI spend limit |
  | Everything else on the account | 1,000 | each app's own guard |
  | Buffer, never used | 6,500 | nobody spends it; demo-kit uses no Workers AI (local voice and render) |
  | **Total** | **10,000** | the free allowance |

| Model | Size and steps | Neurons an image (tiles rounded up) | Use |
| --- | --- | ---: | --- |
| Flux Schnell | 1024 x 1024, 4 steps | 58 | the library ("Make now" any time, then the once-a-day run at 23:15 UTC takes what is left) and 1 per post, 40 a day in all |
| Lucid Origin | 768 x 432, 20 steps | 1,512 | only when Schnell errors, if the day has room |
| Flux 2 Dev | 1024 x 576, 16 steps | 2,400 | off; `LIBRARY_MODEL` "flux2dev" (one a day at most) |

Automatic library images run once a day near the end of the image day: the hourly cron does library work only in the UTC hour `LIBRARY_RUN_HOUR_UTC` (23, so 23:15 UTC, 3:15 pm Pacific in winter and 4:15 pm in summer; owner, 2026-11-11), and that one run makes whatever is left of the day's 40 images and 2,500 neurons.
It starts no image after 23:55 UTC, so nothing it makes counts against the next day, and it stops cleanly when a reservation is refused.
The night's post comes after the 00:00 UTC reset (the end-of-day run starts at 20:30 Pacific), so it has a fresh day's 40 to draw its one illustration from.
A Lucid fallback only runs while it fits the hour and the 2,500 neurons; otherwise the slot falls back to the library or a chart.
The owner's "Make now" and "Make your own" on `/admin/images` may use what is left of the same 40 a day.
Every Workers AI call path (the daily run, "Make now", "Make your own" and a post's fresh illustration) goes through `generateIllustration` ([pipeline/content/workers-ai.mjs](../pipeline/content/workers-ai.mjs)), which reserves the image and its neurons before calling the model; the tests prove each path is refused once 40 images or 2,500 neurons are reserved for the UTC day.
A 429 from the gateway means stop: no retry, the next tick tries again, and the page says how many the gateway allows an hour.
Each library image also takes one Gemini check (job `library`, at most 40 a day, inside the free Gemini quota and the reserve for people).
"How images are made" on `/admin/images` and `GET /api/admin/quota` (`aiImages`) show today's images, the hour's and the neurons.
