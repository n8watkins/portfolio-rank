# Discovery pipeline: design, trial and plan

Written 2026-11-13 for pull request #149 (stacked on #136).
How the pipeline works day to day is in [../DISCOVERY.md](../DISCOVERY.md); this page records why it is built this way, what the trial run found, what it costs, and what is left.

## Summary

The one-off discovery pilot is now a pipeline inside PortfolioRank: a daily GitHub Actions job reads each source when it is due, checks every new site for free, and (once switched on) screens them with Gemini 3.1 Flash-Lite and hands the good ones to the grader at a capped pace.
Every site ever seen has one row in `discovery_sites`, so nothing is checked twice, and each source has a watermark, so nothing is read twice.
The AI screen and the hand-off to grading are built and tested with a stand-in for Gemini, and both are off, as the owner asked: no Gemini spending until the prompt audits are done.
A trial on a local copy (pilot imported, every source read) checked 750 new sites in under 6 minutes of machine time and passed 48% to the AI screen.
The trial against the staging database did not run: passing the staging Turso secrets to `node` through `pass-env` was denied, so it waits for the owner.
Running costs stay at $0 on the free tiers; the first real AI screen of the backlog is about 330 requests on 3.1 Flash-Lite, inside one day's free allowance.

## Design

### Stages

Each stage reads only its own queue (a status in `discovery_sites`, with a partial index), so a run can stop anywhere and the next run carries on.

| Stage | What it does | Writes |
|---|---|---|
| Sources | Each due source reads from its watermark; addresses are normalized, checked against the list (`feed.json`, `additions.json`, `excluded.json`) and the seen-set, and new ones are written | `found` rows, then the watermark |
| Recheck | Dropped rows whose recheck date has come | back to `found` |
| Check | One fetch each (robots.txt first, private addresses refused), the pilot's code checks, then the language and topic filter | `dropped` with a reason, or `screen` with the evidence |
| AI screen | Gemini 3.1 Flash-Lite, 20 sites a request, daily cap | `pending`, or `dropped` (not a portfolio, template, unsure) |
| Hand-off | `pending` sites become waiting jobs in the grader's queue, capped, people first | `queued`, later `graded` or `dropped` |

The watermark moves only after the source's rows are written, so a crash makes the next run read the same items again and the seen-set skips them.
A source that fails keeps its watermark and the other sources carry on.

### Sources

| Source | Read | Why |
|---|---|---|
| GitHub topics `portfolio`, `portfolio-website`, `personal-website`, `developer-portfolio` | Weekly; forward to yesterday, then 2 older months a run back to 2012 | The pilot's best source (71% passed the checks); month slices reach the back catalog the pilot never touched |
| Hacker News comments ("my portfolio", "personal website") | Weekly | People sharing their own site; 46% passed in the pilot |
| HN "Who wants to be hired?" | Weekly; new posts plus 1 older thread a run | About 600 posts a month from experienced job seekers; new in this pipeline |
| HN "Share your personal site" threads | Monthly, 1 thread a run | A few thousand senior, own-domain sites per thread |
| personalsit.es, uses.tech | Weekly, by commit diff | People add themselves; one request when nothing changed |

Not included, on purpose: emmabostian/developer-portfolios (the nightly sync already lists it), dev.to and Show HN (slow and noisy in the pilot), `user.github.io` searches (38% passed), Reddit, Lobsters and design showcases (terms or robots rules say no).

### Memory

`discovery_sites` is the seen-set from #136, extended with the stages `found`, `screen` and `queued`.
The address is kept only while a row is in a queue, graded, or dropped for a reason that is looked at again (dead, empty, parked, blocked, unsure).
A permanent drop (template, not English, not a portfolio, duplicate) keeps only the 64-bit hash, the reason and the dates.
A rechecked reason comes back after 90 days (30 for blocked, 180 for unsure), each wait longer than the last, and its third failure forgets the address.
`discovery_work` holds a row's working data (repo, evidence, screen answer) and is deleted when the row leaves the queues.
`discovery_sources` holds one watermark per source.

### The AI screen, against the Gemini audit's notes on screen.py

| Audit note | Done |
|---|---|
| No system instruction | The rules are a system instruction; the user part holds only site data |
| No schema | Strict response schema: enums for verdict and field, effort 1 to 5, the reason before the verdict |
| Injection risk | Each site in its own `<site_data id="sN">` block, declared untrusted, with any such marker removed from page text; ids are short labels, never database keys |
| Retries a spent quota | Uses the shared client (`pipeline/gemini.mjs`): a per-day 429 ends the screen at once, 503s get three retries inside a run budget of 6 |
| Outside the log | Every request is logged as `discovery-screen` in `gemini_requests`, which also counts the daily cap |

### Hand-off to grading

A site that passes the screen becomes a `grade_jobs` row in the `waiting` state with visitor `discovery`, the grader's existing queue.
The grader's tick starts waiting jobs while the day's share has room, captures them on Actions and grades them on 3.5 like any request.
People come first: their waiting requests start before discovery's, discovery's jobs do not count against people's waiting line, and the hand-off adds at most 10 a day, at most 10 waiting at once, and none while today's share has fewer than 40 places left.

## What ran

| Step | Where | Result |
|---|---|---|
| Unit tests | Local | 17 new tests pass; the grader, budget, schema, monitoring and night suites (96 tests) pass; typecheck and lint clean |
| Pilot import | Local throwaway database | 11,650 rows: 9,965 of the pilot's 10,000 checked sites (35 refused by the stricter normalizer, mostly platform hosts) and 1,685 of its 1,690 overflow GitHub rows |
| Run 1: every source, first read | Local, no GitHub token, AI off | 3 min 54 s; 4,852 new sites; 150 checked |
| Run 2: checks only, default cap of 600 | Local | 109 s for 600 sites |
| Pilot import and a run on staging | Staging database | Not run: `pass-env run` with the staging Turso pair into `node` was denied (needs owner) |

### Pilot import

| Status | Rows |
|---|---:|
| `screen` (passed checks and filter, with the pilot's evidence) | 3,616 |
| `found` (overflow, never checked) | 1,685 |
| dropped: not a portfolio | 3,202 |
| dropped: dead (rechecked from 2027-02-10) | 1,288 |
| dropped: not English | 1,000 |
| dropped: empty (rechecked) | 329 |
| dropped: template | 303 |
| dropped: blocked (rechecked) | 189 |
| dropped: parked (rechecked) | 36 |
| dropped: duplicate | 2 |

### Run 1: new sites by source

| Source | Read | New after the list and the seen-set |
|---|---:|---:|
| github:portfolio | not due (pilot watermark) | |
| github:portfolio-website (30 days) | 472 | 177 |
| github:personal-website (30 days) | 613 | 210 |
| github:developer-portfolio (30 days) | 207 | 38 |
| hn:comments | not due (pilot watermark) | |
| hn:hired (Oct and Nov 2026 threads) | 806 | 639 |
| hn:share (Jan 2026 thread) | 2,084 | 1,970 |
| personalsites (whole list) | 1,175 | 1,063 |
| uses (whole list) | 923 | 755 |
| **Total** | 6,280 | 4,852 |

Requests: 22 to the GitHub API, 12 to HN Algolia, 1,176 to raw.githubusercontent.com (the personalsit.es files, first read only).

### Checks on 750 sites (runs 1 and 2)

| Outcome | Sites | Share |
|---|---:|---:|
| Passed to the AI screen | 360 | 48% |
| Not a portfolio (no portfolio words, product, no person, redirects to a platform) | 165 | 22% |
| Not English (Spanish, Portuguese, non-Latin, French and others) | 140 | 19% |
| Dead | 35 | 5% |
| Template | 21 | 3% |
| Blocked (robots.txt, bot walls) | 16 | 2% |
| Empty or parked | 13 | 2% |

These were mostly the pilot's overflow GitHub rows (the oldest in the queue), so the share is close to the pilot's GitHub numbers.
The trial found three bugs, fixed in the pull request: a package registry page counted as a candidate, a redirect loop was filed as a private address, and a failed DNS lookup inside the guarded fetch was a permanent drop instead of a recheck.

Queues after the trial: 5,787 `found`, 3,976 `screen`, nothing pending or queued.

## Caps

| Cap | Default | Trial |
|---|---:|---:|
| Pages fetched a run (`found`) | 600 | 150, then 600 |
| Repos a GitHub topic reads before stopping (`perSource`) | 3,000 | 3,000 |
| Older GitHub months a run (`backMonths`) | 2 | 0 |
| Older "Who wants to be hired?" threads a run | 1 | 0 |
| "Share your personal site" threads a run | 1 | 1 |
| Rechecks a run | 200 | 200 |
| AI screen requests a quota day | 25 (500 sites) | off |
| Hand-offs a quota day | 10 | off |
| Discovery jobs waiting at once | 10 | off |
| Grading places kept for people | 40 | off |

All of them change through the `DISCOVERY_CAPS` repository variable (JSON), or per manual run.

## Cost per week

Estimates for steady state after the back catalog, from the trial's rates; every service stays on its free tier, so the money cost is $0.

| Item | A week | Free allowance | Paid rate, for comparison only |
|---|---|---|---|
| New candidates | About 800 (GitHub about 700, HN about 90, lists about 15) | | |
| Page fetches | About 800 plus robots.txt, under 3 minutes | No limit | |
| AI screen (3.1 Flash-Lite) | About 20 requests steady; up to 175 while the backlog drains at 25 a day | 500 a day | About $0.005 a request (about 9,000 tokens in, 1,000 out), so $0.10 to $0.85 |
| Grades from the hand-off (3.5 Flash-Lite) | 70 at 10 a day, from the grader's daily share | 500 a day, shared with people | About $0.0013 a grade, so $0.09 |
| Turso | About 4,000 writes and 75,000 row reads | 10M writes and 500M reads a month | |
| GitHub Actions | About 5 to 15 minutes a day | Free on a public repo | |
| GitHub API | About 50 search requests a week | 30 a minute with the job's token | |

The largest read cost is the run summary's queue counts (about 10,000 rows a day while the backlog is large); it shrinks as the queues drain.

### The first real AI screen

When the owner switches the screen on, the backlog is the 3,976 sites waiting in `screen` plus about half of the 5,787 in `found` once they are checked: about 6,800 sites, or 340 requests.
At the default 25 a day that takes about 14 days; raising `screenRequests` to 350 for one day clears it in one day, still inside the 500 free requests of 3.1 Flash-Lite.
At paid rates the whole backlog would be about $1.70; on the free tier it is $0.
Grading what passes is the slow part: at 10 a day, the roughly 4,000 sites the screen is expected to pass (about 60%, estimate) take over a year, so the hand-off pace is the main owner decision below.

## Action plan

| Item | Status |
|---|---|
| Pipeline: sources, normalize, seen-check, checks, filter, watermarks, rechecks | done |
| AI screen with system instruction, schema, data blocks, daily cap, quota stop | done, off |
| Hand-off to the grader's queue, people first | done, off |
| Pilot import script | done |
| Tests (normalize, seen-check, filter, watermark, screen, hand-off, a whole run) | done |
| Weekly job (`discover.yml`, daily schedule, sources read when due) | done; runs once the PR reaches main |
| Local trial with the pilot imported | done |
| Import the pilot and run once on staging | needs owner |
| Switch on the AI screen (`DISCOVERY_SCREEN=on`) after the prompt audits | needs owner |
| Switch on the hand-off (`DISCOVERY_HANDOFF=on`) and choose its pace | needs owner |
| Confirm the privacy section for discovered sites | needs owner |
| Decide how graded discovered sites join the public list | needs owner |
| A labelled gold set (300 to 500 sites) to measure the screen's accuracy | needs owner |
| Point the job at production (`DISCOVERY_TARGET=production`) | needs owner, after staging |

## Owner decisions

1. **Staging run.** Run these two commands, or allow `node` under `pass-env run` for this repo:
   `pass-env run -e TURSO_DATABASE_URL=portfolio-rank/STAGING_TURSO_DATABASE_URL -e TURSO_AUTH_TOKEN=portfolio-rank/STAGING_TURSO_AUTH_TOKEN -- node scripts/discovery-import.mjs ~/research/portfoliorank-discovery`
   and the same prefix with `node pipeline/discovery/run.mjs --caps '{"found":150,"backMonths":0,"hnBackThreads":0}'`.
   The alternative is to wait for the workflow to reach main, where a manual run targets staging by default.
2. **AI screen.** Switch it on after the audits, at 25 requests a day, or for one day at 350 to clear the backlog at once.
3. **Hand-off pace.** 10 a day keeps people first but drains about 4,000 screened sites in over a year.
   Options: raise it to 30 to 50 once the rubric moves to five sites a request (the Gemini audit's item 10), or grade discovered sites in the nightly background stage instead of the people's share.
4. **Listing.** A graded discovered site gets a private grade report today but does not join the list; choose between a `data/discovered.json` file merged by a bot pull request (the discovery plan's recommendation) or the database alone.
5. **Privacy text.** Confirm the new "If your site was found on a public list" section in `docs/legal/privacy.md`.
6. **"Unsure" sites.** The plan said a second "unsure" means "not a portfolio"; the pipeline gives them the same three tries as dead sites, six months apart.
   Keep this, or shorten it to two tries.
7. **Sources left out.** Confirm skipping dev.to, Show HN and `user.github.io` searches; each can be added as one more source file.
