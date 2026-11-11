# Roadmap

What gets built, in what order, and what each step waits on.
The decisions behind each step, with dates and reasons, are in [DECISIONS.md](DECISIONS.md).
[PLAN.md](../PLAN.md) is the original June 2026 plan and is kept for history; where they differ, this file wins.

Last updated: 2026-11-10.

Status: **done** (merged, with the PR), **building** (open PR or running lane), **to do**, **needs owner**.

## The goal

An automatic PortfolioRank: every listed portfolio graded on one rubric, a leaderboard with AI, people and merged views, "grade my portfolio" for anyone, a redesigned site to hold it all, and a blog and newsletter that run on their own from the site's data.

## Phase 1: Foundations

| Step | Status |
| --- | --- |
| Gemini key in the header, 3.5 first with retries, 3.1 backup, model recorded on every grade and vote | done (#52) |
| Catch-up mode, shared pacing, request log with daily totals, re-grade history, Sunday 3.1-vs-3.5 report | done (#54) |
| Own cleanup: listed sites only, weekly health check, capture retries, `/removed`, free portfolio check, upstream report | done (#53) |
| Rubric v2: facts by code, page text instead of a shrunken image, short notes, rubric version | done (#57) |
| Audit fix: sign-in window, keyboard voting behind it | done (#56) |
| Audit fix: vote fishing and claim overspend | done (#58) |
| Audit fix: lint on every PR | building (#59) |
| Audit fixes still open: the leftover script that can delete every vote, red and flaky browser tests, phone speed (image serving, home page size), phone header, Add to list on phones, signed-out pages, the medium quick fixes | to do |
| Grade the ungraded backlog on 3.5's daily budget (no catch-up on 3.1) | building (runs nightly; from #69 in the end-of-day run on Cloudflare) |
| Full re-grade on rubric v2 (`RUBRIC_REGRADE=true`) | needs owner, after the backlog |
| Stop rule for 3.1-to-3.5 re-grades (stop when the weekly report shows no meaningful difference) | to do |
| Grades and AI votes from 3.5 only: 3.1 fallback off (`GEMINI_FALLBACK`), catch-up mode removed (`GEMINI_CATCHUP=false`) | building (#63) |

Depends on: nothing; everything else depends on it.

## Phase 2: Ranking

| Step | Status |
| --- | --- |
| OpenSkill ratings seeded from the grade; merged, AI and People views; confidence bands and ties shown as ties | to do |
| Matchmaking: close matches, 1 in 5 random, random order, recorded seed; settled sites compared less | to do |
| Daily AI comparisons on 3.5: 100 one-on-one, 100 batched (batched experiment-only for two weeks), in the end-of-day run on what is left after people | built, waits for `RANKING_V2` (#65, #69) |
| Experiments table: every comparison tagged with method, model and prompt version | to do |
| Placement experiment (one request vs ten), ending in a report | to do |
| Analytics: rank movement, contradictions, AI vs people gaps, position bias; change detection that re-grades a redesigned site | to do |
| Public method page and downloadable comparison log | to do |

Depends on: phase 1 (clean list, v2 grades).
Stops the current 30 AI votes a day in the shared ELO pool once it lands.

## Phase 3: Redesign (preview first)

| Step | Status |
| --- | --- |
| Local preview of the new shell, adaptive home, leaderboard tabs and grade report; desktop, then phone, with screenshots | done (approved 2026-11-10, `preview/redesign`) |
| Shared shell, light theme, icons, phone tab bar and the shared building blocks (Wave B step 1) | building |
| `/browse` with the grid moved off home | to do |
| Face-off that fits on a phone, leaderboard tabs, portfolio page with the shared grade card | to do |
| Privacy page and the other legal pages, from the drafts in [legal/](legal/) | needs owner (placeholders), then to do |

Depends on: can start alongside phase 2; the leaderboard tabs fill in when ranking lands.

## Phase 4: Grade my portfolio

| Step | Status |
| --- | --- |
| Back end, behind `GRADER_ENABLED` (off): `POST /api/grade` with the free checks at once from the Worker, then `grade.yml` on GitHub Actions dispatched on demand for the screenshot and the v2 grade on 3.5 (Browser Rendering parked) | building (#81) |
| Queue with live progress (`GET /api/grade/<id>`); past the daily share or with 3.5 unavailable, it waits and "we'll email your report" | building (#81) |
| Report data: facts and AI judgment apart, strengths, three fixes, estimated rank, similar portfolios, who does your weakest axes better; unlisted, shareable by link, deletable by its owner | building (#81) |
| Report page, progress page and settings in the redesign; share image; "add me to the leaderboard" request | to do (with the redesign) |
| Guardrails: Turnstile, per-visitor, per-network and site-wide caps reserved atomically, strict address checks, free checks cached by address, private screenshots, untrusted page text, re-grade cooldown | building (#81); Turnstile switches on with its secret (needs owner) |
| Security: cost abuse, SSRF through redirects and the browser (filtering proxy on the runner), report privacy, public Actions logs | building (#81, with tests); a full security review before `GRADER_ENABLED` goes on |
| Cloudflare Email Service wired as the sender (binding, sender address), behind the shared email gate with caps under the beta daily limit; owner alerts to the verified address | building (#81); `OWNER_EMAIL` needs owner |
| Free-tier notice where a visitor starts AI work (in the redesign) and a bring-your-own-key option for the grade (DECISIONS.md, "Free tier everywhere") | own-key back end building (#81); the notice is in the redesign preview |
| Switch it on: `GRADER_ENABLED` to `"true"` once the redesign's grade pages ship | needs owner, after the redesign |

Depends on: phases 1 and 3; uses phase 2 for "you'd rank about #340".

## Phase 5: Blog and newsletter

The content engine's design, with the owner decisions it needs, is [CONTENT-ENGINE.md](CONTENT-ENGINE.md).

| Step | Status |
| --- | --- |
| Post template | done (#55) |
| First drafts in the owner's voice from real data, for the owner to pick favourites | building (one in `docs/content/drafts/`) |
| Blog on the site: posts, tags, RSS, share images, the AI label | to do |
| Pipeline: find, pick, compute facts, write, check, publish; 1-2 posts a week; fail-closed checks and the naming rule | to do |
| Images: charts, screenshots, stock, Workers AI illustrations, Gemini review of each slot | to do |
| Admin page: queue, unpublish, edit, feature, block a topic; weekly "what went out" email | to do |
| Newsletter: sign-up with email confirmation, one-click unsubscribe, weekly digest | to do, after the email provider |
| Model watch: weekly check of Google's model list, deprecations and release notes, updates to the owner | built (#74) |
| Polls: one a week, written from our data in the content budget (at most 2 Gemini requests a week), one vote per person (sign-in or cookie plus Turnstile), a poll card on home and a polls page with past results; results feed blog posts and, with enough votes, the AI vs people comparisons | back end built (tables, API, nightly generation, results feed; AUTOMATION.md "Polls"); the card and page come with the redesign; Turnstile switches on with its secret |

Depends on: the blog shell and model watch can start any time; most stories need phase 2 data; the newsletter needs the email gate from phase 4.

## Phase 6: Running it

| Step | Status |
| --- | --- |
| One Gemini budget for the single key: people first, background at the end of the quota day, enforced in one place (`pipeline/budget.mjs`) | building (#69) |
| End-of-day run started by a Cloudflare Cron Trigger: free checks on Actions, then the AI stages on a Workflow, with caps, batches, a hard stop and bounded retries | building (#69) |
| Worker secrets `GEMINI_API_KEY` and `GITHUB_DISPATCH_TOKEN` for the end-of-day run | needs owner |
| Owner alerts that repeat daily until resolved | building (#69); email waits for the provider |
| Kill switches: one setting each for grading, comparisons, publishing and email | to do (stage caps in `GEMINI_BUDGET` can be 0 meanwhile) |
| One admin page: quotas used, grades queued, posts queued, emails sent, removals pending | the quota data API is building (#69); the page comes with the redesign |
| OpenPing watching health, the daily Gemini totals and the content pipeline | to do |
| Paid Gemini key with a budget alert and hard cap: revisit at the public launch or when traffic grows (DECISIONS.md, "Free tier everywhere") | needs owner, later |
| Turso reads: vote counters, a paged and edge-cached board API, nightly log roll-ups and retention (docs/COSTS.md section C) | done (#72) |
| Nightly backup of every table, with a tested restore (`scripts/restore-db.mjs`) | done (#72); the owner's restore drill (ASSUMPTIONS.md section G) to do |

Depends on: phase 1's request log; the budget must exist before phase 4 opens to the public.

## Risks to keep in view

- **People being written about**: the naming rule and a clear removal process ([legal/removal.md](legal/removal.md)).
- **Privacy and email law**: no privacy page exists today; the newsletter needs consent and easy unsubscribe (no postal address while it stays non-commercial).
- **Google's free tier** may use requests to improve its products, and its terms allow only paid use where people in the EEA, Switzerland or the UK can reach a client; the owner accepts that risk for now (DECISIONS.md, "Free tier everywhere"): contact details are stripped from page text, the privacy page says so, and visitors get a notice and their own-key option.
- **Automatic publishing mistakes**: facts from code, the checks, labels and fast unpublish.
- **Search and spam signals**: fewer, data-rich posts.
- **Gaming the grade**: published criteria, untrusted page text, facts checked by code.
- **Costs if it takes off**: the queue, email and a capped paid key must exist before any launch post.
- **Community-list relationship**: credit on every page and a friendly note to the maintainer.
- **Model retirement**: every grade and comparison carries its model and version; model watch gives warning.
- **Accessibility of charts**: a text summary for each chart in posts and reports.

## Open questions

Decisions only the owner can make, oldest first.

1. **Email provider**: decided 2026-11-10, Cloudflare Email Service for all email (DECISIONS.md); SES is dropped.
   The sender is wired (#81): the Worker's `send_email` binding from `portfoliorank@n8builds.dev`, behind the shared gate; owner alerts wait for `OWNER_EMAIL` (DEPLOY.md).
2. **Postal address**: decided 2026-11-10, not needed while the newsletter stays editorial; add a PO box or virtual mailbox if ads, sponsors or paid features ever arrive.
3. **Legal placeholders**: contact email, legal name or business name, jurisdiction, backup retention period, minimum age (see the `[owner: ...]` markers in [legal/](legal/)).
4. **Full re-grade on rubric v2**: turn on `RUBRIC_REGRADE` once the backlog is graded (about 2,000 grades, 4-5 days of 3.5's budget)?
5. **Redesign preview**: approve the shell, adaptive home, leaderboard tabs and grade report when the preview is ready.
6. **Favourite drafts**: pick which first drafts go out first, and anything to change in the voice.
7. **Grade my portfolio: the caps** (built with agent numbers, #81; change them with `GRADER_CAPS`):
   3 a day per visitor, 6 per network, 100 site-wide, Turnstile on every request;
   reports are shareable by link, not listed, and deletable by their owner (decided);
   screenshots on GitHub Actions (decided), Browser Rendering parked.
   Still open: should graded sites join the leaderboard only by an opt-in request the owner approves (question 8)?
8. **Leaderboard requests**: since publishing is fully automatic, should "add me to the leaderboard" requests also be automatic, or wait for the owner?
9. **Required checks**: add the Worker build and browser tests to the required checks on `main` (a GitHub setting).
10. **Minimum GitHub account age for votes** (`MIN_GITHUB_ACCOUNT_AGE_DAYS`, off today) and a limit for anonymous visitors (Turnstile or a firewall rule).
11. **When to turn on billing** for a paid Gemini key, and its daily cap.
12. **A note to the community-list maintainer** about PortfolioRank mirroring and grading the list: send one, and from whom?
13. **ELO-era AI votes**: they no longer run on a schedule (only `RANKING_V2` comparisons run in the background); should they continue until ranking v2 is switched on?
