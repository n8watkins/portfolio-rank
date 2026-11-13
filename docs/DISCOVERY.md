# Discovery

How PortfolioRank finds portfolios that are not on the community list yet, checks them for free, and hands the good ones to the grader.
The code is `pipeline/discovery/`, the memory is `lib/discovery/sites.mjs`, and the job is `.github/workflows/discover.yml`.
The design, the trial run and the open decisions are in [audits/discovery-pipeline.md](audits/discovery-pipeline.md).

## One run

`node pipeline/discovery/run.mjs` runs five stages.
Each stage reads only its own queue in `discovery_sites`, so a run can stop anywhere and the next one carries on.

1. **Sources.** Each source that is due reads from its watermark.
   Every address is normalized (`normalize.mjs`), checked against the list (`data/feed.json`, `additions.json`, `excluded.json`) and the seen-set (one primary-key read each), and new ones are written as `found`.
   Only then does the watermark move, so a crash never skips anything.
2. **Recheck.** Dropped rows whose recheck date has come go back to `found`.
3. **Check.** Up to `found` rows a run are fetched once (robots.txt first, private addresses refused), run through the code checks (`check.mjs`) and the language and topic filter (`filter.mjs`).
   Each becomes `dropped` with a reason, or `screen` with its evidence (title, description, headings, 1,200 characters of text, link counts).
4. **AI screen** (`screen.mjs`, off unless `DISCOVERY_SCREEN=on`).
   Gemini 3.1 Flash-Lite, 20 sites a request, at most `screenRequests` a quota day, logged as `discovery-screen` in `gemini_requests`.
   A "yes" becomes `pending`; "no", "template" and "unsure" are dropped.
5. **Hand-off** (`handoff.mjs`, off unless `DISCOVERY_HANDOFF=on`).
   `pending` rows become waiting jobs in the grader's queue (`grade_jobs`, visitor `discovery`), at most `handoffPerDay` a day, at most `handoffWaiting` waiting at once, and never while today's grading share has fewer than `handoffReserve` places left.
   People's waiting requests always start first, and discovery's jobs don't count against people's waiting line.
   Finished grades come back as `graded`, or `dropped` when the grade says it is not a portfolio.

## Sources

| Key | What | Every | Cursor |
|---|---|---|---|
| `github:portfolio`, `github:portfolio-website`, `github:personal-website`, `github:developer-portfolio` | Repos with the topic and a website set; a github.io site becomes the owner's own domain when the profile names one | 7 days | Creation days read: forward to yesterday, then `backMonths` older months a run, back to 2012 |
| `hn:comments` | Comments sharing "my portfolio", "personal website" | 7 days | Comment time |
| `hn:hired` | "Ask HN: Who wants to be hired?" top-level posts | 7 days | Post time, plus `hnBackThreads` older threads a run |
| `hn:share` | "Ask HN: Share your personal site" threads | 30 days | Threads done, `hnShareThreads` a run |
| `personalsites` | xdesro/personalsit.es, one file per site | 7 days | Commit; only files added since |
| `uses` | wesbos/awesome-uses (uses.tech) | 7 days | Commit; only entries added since |

A Hacker News post gives at most two links, reduced to the site's home page, and a host three or more people posted is a library or a product, so it is dropped without a fetch.
emmabostian/developer-portfolios is not a discovery source: `sync-upstream.yml` already lists everything it merges.
Reddit, Lobsters and design showcases are left out on purpose: their terms or robots rules say no.

## The seen-set

One row per normalized address, keyed by the first 64 bits of its SHA-256 (see `lib/discovery/sites.mjs`).

| Status | Means | Keeps the address |
|---|---|---|
| `found` | Collected, waiting for the fetch | Yes |
| `screen` | Passed the free checks, waiting for the AI screen | Yes |
| `pending` | Waiting to be graded (screened, or added by the free tools) | Yes |
| `queued` | Handed to the grader | Yes |
| `graded` | Graded | Yes |
| `dropped` | Left out, with a reason | Only for `dead`, `empty`, `parked`, `blocked`, `unsure` |

A rechecked reason comes back after 90 days (dead, empty, parked), 30 (blocked) or 180 (unsure), each wait longer than the last, and its third failure forgets the address.
`template`, `not_english`, `not_portfolio` and `duplicate` keep only the hash, the reason and the dates.
`discovery_work` holds a row's working data (its repo, then its evidence, then the screen's answer) and is deleted when the row leaves the queues.
`discovery_sources` holds one watermark per source, and the hand-off's count for the day.

## Caps

`DISCOVERY_CAPS` (a repository variable, JSON) changes any default in `pipeline/discovery/run.mjs` `DEFAULT_CAPS`; a manual run can pass its own.

| Cap | Default | What it limits |
|---|---:|---|
| `found` | 600 | Pages fetched and checked a run |
| `perSource` | 3,000 | Repos one GitHub topic reads before it stops opening windows |
| `backMonths` | 2 | Older GitHub months a topic reads a run |
| `hnBackThreads`, `hnShareThreads` | 1, 1 | Older Hacker News threads a run |
| `recheck` | 200 | Rechecks reopened a run |
| `screenRequests` | 25 | AI screen requests a quota day (500 sites) |
| `handoffPerDay` | 10 | Sites handed to the grader a quota day |
| `handoffWaiting` | 10 | Discovery jobs waiting in the grader's queue at once |
| `handoffReserve` | 40 | Places in today's grading share always left for people |

## Switches and target

- `DISCOVERY_TARGET`: `production` points the job at the production database; anything else (the default) at staging.
- `DISCOVERY_SCREEN`: `on` runs the AI screen. Off until the owner turns it on.
- `DISCOVERY_HANDOFF`: `on` hands sites to the grader. Off until the owner turns it on.

## The pilot

`scripts/discovery-import.mjs <pilot folder>` imports the pilot of 2026-11-12 once: its 10,000 checked sites (dropped ones under the rules above, the 3,616 that passed as `screen` with their evidence) and the 1,685 GitHub rows that did not fit its cap as `found`.
It sets `github:portfolio` and `hn:comments` to where the pilot stopped.

## Tests

`tests/discovery.test.mjs`: normalize, the seen-check, settle and rechecks, the filter, the code checks, the sources' planning, the watermark, the screen with a stand-in for Gemini, the hand-off, the pilot import's mapping, and one whole run with stand-ins for every source and page.
