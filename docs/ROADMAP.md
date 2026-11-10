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
| Catch up: grade the ungraded backlog on both quotas | building (runs nightly in catch-up mode) |
| Full re-grade on rubric v2 (`RUBRIC_REGRADE=true`) | needs owner, after catch-up |
| Stop rule for 3.1-to-3.5 re-grades (stop when the weekly report shows no meaningful difference) | to do |
| Turn catch-up mode off (`GEMINI_CATCHUP=false`) | to do, after the backlog and re-grade |

Depends on: nothing; everything else depends on it.

## Phase 2: Ranking

| Step | Status |
| --- | --- |
| OpenSkill ratings seeded from the grade; merged, AI and People views; confidence bands and ties shown as ties | to do |
| Matchmaking: close matches, 1 in 5 random, random order, recorded seed; settled sites compared less | to do |
| Daily AI comparisons on 3.5: 100 one-on-one, 100 batched (batched experiment-only for two weeks) | to do |
| Experiments table: every comparison tagged with method, model and prompt version | to do |
| Placement experiment (one request vs ten), ending in a report | to do |
| Analytics: rank movement, contradictions, AI vs people gaps, position bias; change detection that re-grades a redesigned site | to do |
| Public method page and downloadable comparison log | to do |

Depends on: phase 1 (clean list, v2 grades).
Stops the current 30 AI votes a day in the shared ELO pool once it lands.

## Phase 3: Redesign (preview first)

| Step | Status |
| --- | --- |
| Local preview of the new shell, adaptive home, leaderboard tabs and grade report; desktop, then phone, with screenshots | needs owner (approval) |
| Shared shell, light theme, icons, phone tab bar, `/browse` with the grid moved off home | to do |
| Face-off that fits on a phone, leaderboard tabs, portfolio page with the shared grade card | to do |
| Privacy page and the other legal pages, from the drafts in [legal/](legal/) | needs owner (placeholders), then to do |

Depends on: can start alongside phase 2; the leaderboard tabs fill in when ranking lands.

## Phase 4: Grade my portfolio

| Step | Status |
| --- | --- |
| Live capture on Cloudflare Browser Rendering, the free checks, PageSpeed, then the v2 grade | to do |
| Queue with live progress; past the daily share, "we'll email your report" | to do |
| Report page, share image, "add me to the leaderboard" request | to do |
| Guardrails: Turnstile, per-person, per-network and site-wide caps, strict address checks, cache by address, private screenshots, untrusted page text | to do |
| Security review: cost abuse, SSRF through redirects and the browser, prompt injection, report privacy | to do |
| Email provider chosen and set up (domain, sender), behind the shared email gate | needs owner |

Depends on: phases 1 and 3; uses phase 2 for "you'd rank about #340".

## Phase 5: Blog and newsletter

| Step | Status |
| --- | --- |
| Post template | done (#55) |
| First drafts in the owner's voice from real data, for the owner to pick favourites | building (one in `docs/content/drafts/`) |
| Blog on the site: posts, tags, RSS, share images, the AI label | to do |
| Pipeline: find, pick, compute facts, write, check, publish; 1-2 posts a week; fail-closed checks and the naming rule | to do |
| Images: charts, screenshots, stock, Workers AI illustrations, Gemini review of each slot | to do |
| Admin page: queue, unpublish, edit, feature, block a topic; weekly "what went out" email | to do |
| Newsletter: sign-up with email confirmation, one-click unsubscribe, weekly digest | to do, after the email provider |
| Model watch: daily check of Google's model list and free tier, updates to the owner | to do |

Depends on: the blog shell and model watch can start any time; most stories need phase 2 data; the newsletter needs the email gate from phase 4.

## Phase 6: Running it

| Step | Status |
| --- | --- |
| One Gemini budget for the single key: the owner's daily split, enforced in one place, with the priority order | to do |
| Kill switches: one setting each for grading, comparisons, publishing and email | to do |
| One admin page: quotas used, grades queued, posts queued, emails sent, removals pending | to do |
| OpenPing watching health, the daily Gemini totals and the content pipeline | to do |
| Paid Gemini key with a budget alert and hard cap, before any launch post | needs owner, later |

Depends on: phase 1's request log; the budget must exist before phase 4 opens to the public.

## Risks to keep in view

- **People being written about**: the naming rule and a clear removal process ([legal/removal.md](legal/removal.md)).
- **Privacy and email law**: no privacy page exists today; the newsletter needs consent and easy unsubscribe (no postal address while it stays non-commercial).
- **Google's free tier** may use requests to improve its products; say so on the privacy page.
- **Automatic publishing mistakes**: facts from code, the checks, labels and fast unpublish.
- **Search and spam signals**: fewer, data-rich posts.
- **Gaming the grade**: published criteria, untrusted page text, facts checked by code.
- **Costs if it takes off**: the queue, email and a capped paid key must exist before any launch post.
- **Community-list relationship**: credit on every page and a friendly note to the maintainer.
- **Model retirement**: every grade and comparison carries its model and version; model watch gives warning.
- **Accessibility of charts**: a text summary for each chart in posts and reports.

## Open questions

Decisions only the owner can make, oldest first.

1. **Email provider**: Amazon SES or Cloudflare Email Service (already set up on `n8builds.dev` for Wren)?
2. **Postal address**: decided 2026-11-10, not needed while the newsletter stays editorial; add a PO box or virtual mailbox if ads, sponsors or paid features ever arrive.
3. **Legal placeholders**: contact email, legal name or business name, jurisdiction, backup retention period, minimum age (see the `[owner: ...]` markers in [legal/](legal/)).
4. **Full re-grade on rubric v2**: turn on `RUBRIC_REGRADE` once catch-up is done (about 2,000 grades, 4-5 days of 3.5's budget)?
5. **Redesign preview**: approve the shell, adaptive home, leaderboard tabs and grade report when the preview is ready.
6. **Favourite drafts**: pick which first drafts go out first, and anything to change in the voice.
7. **Grade my portfolio, from the grader plan** (recommendations, not yet confirmed):
   anyone can grade, 1 a day with Turnstile and 5 a day signed in with GitHub;
   graded sites join the leaderboard only by an opt-in request the owner approves;
   reports are shareable by link, not listed, and deletable by their owner;
   screenshots on Browser Rendering with a site-wide cap.
8. **Leaderboard requests**: since publishing is fully automatic, should "add me to the leaderboard" requests also be automatic, or wait for the owner?
9. **Required checks**: add the Worker build and browser tests to the required checks on `main` (a GitHub setting).
10. **Minimum GitHub account age for votes** (`MIN_GITHUB_ACCOUNT_AGE_DAYS`, off today) and a limit for anonymous visitors (Turnstile or a firewall rule).
11. **When to turn on billing** for a paid Gemini key, and its daily cap.
12. **A note to the community-list maintainer** about PortfolioRank mirroring and grading the list: send one, and from whom?
