# Free tools

The free tools at `/tools` check any portfolio address without an account.
They are built, on staging only: every page and API answers 404 until the Worker variable `TOOLS_ENABLED` is `"true"` (`wrangler.jsonc`; staging has it on, production off).

| Tool | Page | API | Status |
| --- | --- | --- | --- |
| Check my portfolio (all tools in one run) | `/tools` | the tools' APIs in turn | live on staging |
| Speed and Lighthouse check | `/tools/speed` | `POST /api/tools/speed` | live on staging |
| Share preview checker | `/tools/share-preview` | - | next |
| Portfolio checklist | `/tools/portfolio-checklist` | - | next |

## No throwaway results

Every run is saved where the rest of the site already reads it, so a check is never wasted.

- **A listed portfolio** (its address matches one on the list by host and path, ignoring `www`, the scheme and a trailing slash): the results are saved under that listed address, in the cache keys its profile reads.
  Lighthouse mobile is `psi:<url>`, the key `/api/psi` and the profile's diagnostics read, so a check refreshes the profile; desktop is `psi-desktop:<url>`.
- **Any other address:** the same keys under the checked address.
  When "Add my portfolio to PortfolioRank" is on (the default, with a note and an opt-out under the address box) and the site loaded, the address goes into the discovery seen-set as `pending`, source `tools` (below).
  Nothing about it is public: it shows on PortfolioRank only once it is graded and joins the list.

A result younger than a day is reused for anyone who checks the same address, at no cost.
A failed run is never saved, so it can't replace a good result on a profile.

## Guards: the tools never cost money

- **Switch:** `TOOLS_ENABLED`.
- **Same origin** and a public address only (`lib/grader/url.mjs` normalizeGradeUrl: http or https, standard ports, no IP literals or private names), fetched through the Worker's `global_fetch_strictly_public`.
- **Attempts:** 40 an hour per visitor and 120 per network, counted before anything else (`rate_limits`).
- **Turnstile** on every request, action `tools` (`lib/turnstile.ts`; fails closed on the deployed Workers).
- **Daily caps** (`lib/tools/caps.mjs`), reserved in `grade_caps` before a fresh run, all or none, reset at midnight Pacific with Google's quota.
  Past any cap the request is refused, never queued.
  `TOOLS_CAPS` (JSON, e.g. `{"speed":{"site":100}}`) can only lower them.

| Tool | Per visitor | Per network | Per IPv6 /48 | Site-wide |
| --- | --- | --- | --- | --- |
| Speed (2 PageSpeed runs each) | 10 | 20 | 40 | 250 checks = 500 PageSpeed runs |
| Share preview and checklist (one page fetch) | 30 | 60 | 120 | 3,000 |

PageSpeed's free quota is 25,000 runs a day on `PSI_API_KEY`, a key in a Google project with no billing account, so going over stops it instead of charging.
The tools take at most 500 of those; the rest stays for the nightly pipeline.
Keyless PageSpeed has a quota of zero today, so a Worker without the key answers "couldn't check" for every run.
No tool calls Gemini.

## Discovery seen-set

`discovery_sites` (`lib/discovery/sites.mjs`) is the one memory of sites PortfolioRank has come across but not listed.
The free tools are its first source; the discovery pipeline (GitHub topics, Hacker News, community lists) will write to the same table instead of keeping its own, so a site found twice is judged once.

- One row per normalized address (host without `www`, path without the trailing slash, lower case, no query or fragment), keyed by the first 64 bits of its SHA-256 as SQLite's rowid, so a seen-check is one primary-key read.
- `status`: `pending` (waiting to be graded), `graded` (graded and handed to the list) or `dropped` (left out, with a `reason`).
- `source` (`tools`, later `github`, `hn`, ...), `first_seen`, `checked_at`, `recheck_at` and `tries`.
- The address is kept only while the row will be looked at again: pending, or dropped as dead, empty, parked, blocked or unsure.
  A permanent drop (not a portfolio, a template, not English) keeps only the hash, the reason and the dates.
- Never public, never counted from a page.

Grading pending rows (the AI report card, when the day's Gemini quota allows) is the discovery pipeline's job and is not built yet; until then pending rows wait.
