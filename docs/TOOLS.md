# Free tools

The free tools check any portfolio address without an account.
They are built, on staging only: every page and API answers 404 until the Worker variable `TOOLS_ENABLED` is `"true"` (`wrangler.jsonc`; staging has it on, production off).

| Tool | Page | API | Saved under |
| --- | --- | --- | --- |
| All of them in one run | `/tools` | the three below, in turn | - |
| Speed and Lighthouse check | `/tools/speed` | `POST /api/tools/speed` | `psi:<url>` (mobile), `psi-desktop:<url>` |
| Share preview checker | `/tools/share-preview` | `POST /api/tools/share-preview` | `share:<url>` |
| Portfolio checklist | `/tools/portfolio-checklist` | `POST /api/tools/checklist` | `grader:quick:<site key>` |

Every API takes `{ url, turnstileToken, fresh? }` and answers `{ url, listed, profile?, <result>, discovery }`; the routes' comments list the errors.
`lib/tools/keys.ts` holds the cache keys.
Where the tools appear in the site (their own pages, the grade flow, the profile) is still an owner decision; the engines, saved results and APIs above are the same either way.

## No throwaway results

Every run is saved where the rest of the site already reads it, so a check is never wasted.

- **A listed portfolio** (its address matches one on the list by host and path, ignoring `www`, the scheme and a trailing slash) is saved under its listed address.
  Lighthouse mobile is `psi:<url>`, the key `/api/psi` and the profile read, so a check refreshes the profile.
  The checklist is the grader's own free-checks record, so a grade asked for the same day reuses it.
- **Any other site** that loads is saved the same way and added to the discovery seen-set as `pending`, source `tools` (below).
  There is no opt-in box (owner, 2026-11-12): one line under the button says it, and so does the privacy policy draft (`docs/legal/privacy.md`, "If you check a site with the free tools").
  Nothing about a pending site is public: it shows on PortfolioRank only once it is graded and joins the list.
- A failed run is never saved, so it can't replace a good result.

A result younger than a day is reused for anyone who checks the same address, at no cost.
"Check again" sends `fresh: true`: the tool measures again now (counted against the caps), saves over the old result, and so clears whatever was fixed.

## "To improve"

`lib/tools/improve.ts` derives a site's failed or weak items from those saved results: failed checklist items, share-card fixes, and Lighthouse categories under the line (performance under 50, the others under 90 on mobile).
Each item links to the tool that explains it and tests it again, with the address filled in.
It is computed when read (one query for the three keys), so re-running a tool clears an item; nothing is stored or emailed for it.
Where the list is shown (a signed-in owner's profile, the report card) waits on the owner's decision about placement.

## Guards: the tools never cost money

- **Switch:** `TOOLS_ENABLED`.
- **Same origin** and a public address only (`lib/grader/url.mjs` normalizeGradeUrl: http or https, standard ports, no IP literals or private names); every fetch goes through `safeFetch` (redirects re-checked, bodies capped, time limits) and the Worker's `global_fetch_strictly_public`.
- **Attempts:** 40 an hour per visitor and 120 per network, counted before anything else (`rate_limits`).
- **Turnstile** on every request, action `tools` (`lib/turnstile.ts`; fails closed on the deployed Workers).
  When Cloudflare shows its checkbox, the form waits for the tick and says so.
- **Daily caps** (`lib/tools/caps.mjs`), reserved in `grade_caps` before a run, all or none, reset at midnight Pacific with Google's quota.
  Past any cap the request is refused, never queued; a result already saved can still be read.
  `TOOLS_CAPS` (JSON, e.g. `{"speed":{"site":100}}`) can only lower them.

| Tool | Per visitor | Per network | Per IPv6 /48 | Site-wide |
| --- | --- | --- | --- | --- |
| Speed (2 PageSpeed runs each) | 10 | 20 | 40 | 250 checks = 500 PageSpeed runs |
| Share preview and checklist (one page fetch, plus the share image or up to 8 project links) | 30 | 60 | 120 | 3,000 |

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

## Tests

`tests/tools.test.mjs` (caps and the seen-set, on an in-memory database) and `tests/tools-api.test.mjs` (the three APIs end to end, with stand-ins for the sites and PageSpeed; `scripts/test-e2e.sh` lowers the speed cap to 3 a network with `TOOLS_CAPS` so the cap is reached).
