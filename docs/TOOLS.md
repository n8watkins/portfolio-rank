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

## Adding a site: is it really there?

`POST /api/add` (owner, 2026-11-13) first dedupes: an address on the list answers `{ already: "listed" }` and one added before `{ already: "added" }`, each with its profile, and nothing runs.
Then a limit against spam: 25 adds a day per account, or 5 per address when signed out (`add_limit`); adding is otherwise welcome, so there is no tighter cap.
Then one GET ([lib/tools/exists.mjs](../lib/tools/exists.mjs), 8 seconds, at most 3 redirects on the same site): it must answer 200 with HTML that isn't a parked, for-sale, expired or default server page, else 422 with why (`parked`, `not_ok`, `not_html`, `redirects_away`, ...) and nothing is saved.
Only then do the checks run and the grade queue, under the grader's own caps (a few a day per visitor and network, a site-wide day and a short waiting line, `lib/grader/caps.mjs`); nothing on this path calls Gemini, so however many sites are added, grades wait for the day's budget.

## Claiming a site: proof with code the owner deploys

While `TOOLS_ENABLED` is on, `/claim` proves ownership the way Google's site verification does ([lib/ownership/verify.mjs](../lib/ownership/verify.mjs), `POST /api/owner/verify`, [components/claim/VerifyFlow.tsx](../components/claim/VerifyFlow.tsx)), for a listed portfolio or one added here.
The signed-in GitHub account gets a token and two ways to use it:

- a file at the site root, `/portfoliorank-<token>.txt`, containing the token (the root, not `/.well-known`, because GitHub Pages drops dot-folders);
- or `<meta name="portfoliorank-verification" content="<token>">` on the home page.

The check runs only when the owner presses Verify: one fetch, 5 seconds, at most 3 redirects all on the same site (www or not), at most 5 tries an hour per account.
A GitHub account whose site is `<login>.github.io` (or a project page under it) is verified at once with no fetch: GitHub itself says whose site it is.
Once verified, the account can re-check the site (`/api/recheck`), hide its grade and remove it (`/api/owner/actions`).
These now need that proof (or the admin's review): the older automatic check, a link on the home page to `github.com/<login>`, isn't accepted while `TOOLS_ENABLED` is on, because a page links collaborators', designers' and template authors' profiles too.
With `TOOLS_ENABLED` off, `/claim` is unchanged.

## Discovery seen-set

`discovery_sites` (`lib/discovery/sites.mjs`) is the one memory of sites PortfolioRank has come across but not listed.
The free tools and the discovery pipeline ([DISCOVERY.md](DISCOVERY.md): GitHub topics, Hacker News, community lists) write to the same table, so a site found twice is judged once.

- One row per normalized address (host without `www`, path without the trailing slash, lower case, no query or fragment), keyed by the first 64 bits of its SHA-256 as SQLite's rowid, so a seen-check is one primary-key read.
- `status`: a site the tools add is `pending` (waiting to be graded); the pipeline's own stages are `found`, `screen`, `queued` and `graded`, and `dropped` means left out, with a `reason` ([DISCOVERY.md](DISCOVERY.md) "The seen-set").
- `source` (`tools`, `github`, `hn`, ...), `first_seen`, `checked_at`, `recheck_at` and `tries`.
- The address is kept only while the row is in a queue, graded, or dropped as dead, empty, parked, blocked or unsure.
  A permanent drop (not a portfolio, a template, not English) keeps only the hash, the reason and the dates.
- Never public, never counted from a page.

Pending rows are handed to the grader's queue by the discovery pipeline at a capped pace, once the owner switches the hand-off on (`DISCOVERY_HANDOFF`); until then they wait.

## Tests

`tests/tools.test.mjs` (caps and the seen-set, on an in-memory database) and `tests/tools-api.test.mjs` (the three APIs end to end, with stand-ins for the sites and PageSpeed; `scripts/test-e2e.sh` lowers the speed cap to 3 a network with `TOOLS_CAPS` so the cap is reached).
