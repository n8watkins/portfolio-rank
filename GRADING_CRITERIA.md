# Grading Criteria

> Status (2026-11-10): gates, the weekly health check, PSI scorecards, polish/behavior checks, the Gemini rubric and human+AI ELO are live; see AUTOMATION.md for how they run.
> Rubric v3 (section 6, since 2026-11-23): code measures the facts that rank a site; Gemini is asked three things only (is it a portfolio, the five-second test, roles), and none of them is in the rank or the tier.
> Not built yet: originality clustering (section 5) and weighting human votes above AI votes (section 7).
> Each section says where the running system differs from the plan.

Every criterion below is assessed **automatically** - by deterministic scripts, free APIs, or
Gemini. Humans are never asked to grade a rubric. The only thing humans ever do is the optional
one-click "which is better?" vote (see PLAN.md → Face-off screen).

Data source: `feed.json` from github.com/n8watkins/developer-portfolios (~1,700+ entries).

## Who assesses what

| Tier | Assessed by | Cost | Coverage |
|------|------------|------|----------|
| Gates | Playwright script (capture) + weekly health check | free | all listed sites, every week |
| Engineering | PageSpeed Insights API | free (25k/day) | all sites in 1 day |
| Polish | HTML-parse script | free | all sites in hours |
| Behavior | Playwright (same run as screenshots) | free | all sites |
| Originality | known-template fingerprints only (clustering not built) | free | all captured sites |
| Facts for the rubric | capture script (`pipeline/facts.mjs`) | free | all captured sites |
| Is it a portfolio, five-second test, roles | Gemini Flash-Lite (free-tier daily budget), three questions only, never in the rank | free tier | once per site, when it is added |
| Overall design rank | Human ELO votes (the ELO-era AI votes were removed on 2026-11-22; their votes stay) | free | forever-refining |

## 1. Gates (pass/fail)

Scripts: `pipeline/capture.mjs` before screenshots, and the weekly health check (`pipeline/health.mjs`), sharing the parking tables in `pipeline/gate.mjs` (ported from `developer-portfolios/src/check_parking_redirects.py`).

- [ ] Loads (HTTP 2xx after redirects); not a parked or for-sale domain.
  A parking phrase only counts in the page title or on a page with little text, because real portfolios mention phrases like "make an offer".
- [ ] Renders visible content (text, or a canvas or images for canvas apps such as Flutter web); not blank.
- [ ] Is actually a portfolio: the Gemini rubric's `is_portfolio`.
  A "no" against at least 4 of the 6 code signals (name, projects, about, contact, resume, GitHub) is kept as a portfolio and flagged for review instead (`pipeline/portfolio-guard.mjs`).
  A `false` grade keeps the site out of the AI voting pool at once and counts as a failure in the health check.
- [ ] Not a duplicate of another entry (same normalized URL, or the same address after redirects).

One failed check never removes a site.
Capture failures are retried with backoff (1, 2, 4, 8, 16, then every 30 days), and a site is only confirmed down after 3 failed weekly health checks in a row spanning at least 13 days; a pass at any point resets it.
Bot walls (403/429 challenges) are inconclusive and don't count.
Redirects to another domain are reported as moves, not failures.
Confirmed-down sites leave the list through `data/excluded.json` and are shown on `/removed`.

## 2. Engineering quality (PSI API)

Client extracted from `appturnity/site-forge/la-pool-engine/website-template/src/app/api/checkup/route.ts`.

- Performance score (0–100), plus LCP / CLS / TBT raw values
- Accessibility score (0–100)
- SEO score (0–100)
- Best-practices score (0–100)
- Mobile-friendly pass/fail (meta-viewport + viewport-insight + target-size composite -
  logic already written in the checkup route)

## 3. Polish checklist (HTML parse - one fetch per site)

All boolean/count, fully deterministic. No AI needed.

- og:title / og:description / og:image present **and og:image URL actually loads**
- Favicon present
- Custom domain (vs `*.vercel.app`, `*.netlify.app`, `*.github.io`, `*.framer.website`,
  `*.framer.app`, `*.pages.dev`, `*.web.app`, `*.surge.sh`)
- Contact path exists (mailto / contact form / social links in DOM)
- Resume/CV link present
- GitHub link present
- Freshness: footer copyright year vs current year (>2 years stale = flag)

Score = % of checks passed.

## 4. Behavior under real conditions (Playwright, piggybacks on screenshot run)

- Responsive: render at 390 / 768 / 1440 px; **fail** on horizontal overflow at 390px;
  bonus if layout meaningfully adapts between widths
- Console error count on load
- Page weight (bytes) + request count (CDP network log)
- Broken assets on homepage (404s in network log)
- Dark-mode support (emulate `prefers-color-scheme: dark`, pixel-diff screenshots)
- Motion detected (frame difference over 3 seconds), a fact the AI grade reads (section 6), not scored directly

## 5. Originality (dataset-relative, not built)

Planned:

- DOM-shape hash + CSS class signature per site, clustered across the whole list.
  A site matching N or more others in the dataset gets a "template" flag; a structural one-of-one scores high.
- A second signal: fingerprints of known templates (HTML5UP, Start Bootstrap, popular Next.js/Astro portfolio starters).

Today `pipeline/capture.mjs` stores `domHash` and `classHash` in each site's `meta`, but nothing clusters them and no score or badge uses them.
The second signal is built: `pipeline/facts.mjs` records known template fingerprints (and the site builder) in `facts.template`, scored as the "Not a known template" check in section 6.

## 6. What code measures and what Gemini is asked (rubric v3)

Owner rule (2026-11-10): anything code can check is measured for free and stored; Gemini gets the measured facts as a few lines of context.
Owner decision (2026-11-22): "Gemini outputs kept: is_portfolio, five-second test, roles. Dropped: the letter, project presentation, visual design, writing, memorability."
A site's rank and tier come only from code measurements and votes.
Owner decision (2026-11-23): no Gemini report card is shown, on a profile, the printable report or anywhere else; the model is used for one decision, whether a page is a portfolio at all (the Removal rule below), and its other answers (the five-second test, the roles) are stored, not shown. The roles still name the profile for search engines (`lib/profile-seo.ts`). The five-second test is to be measured by code in a later change.
The rubric lives in one pure module, `pipeline/rubric.mjs` (version, criteria, prompt, response schema, parser), used by the nightly grader, the eval and the docs.

**Is it a portfolio** (the owner's definition, 2026-11-22): "a portfolio page is fundamentally defined by showcasing technical projects you've created. And some of the technical products could be design-oriented."
The prompt says no for a parked, blank or hijacked domain, an unedited template, a page whose main purpose is selling coaching, courses or a product rather than showing projects the person built (even a developer's), a company or agency site presenting a team's services, a GitHub or other code-host profile, a Substack, a Medium page, a Linktree or other link-in-bio page, and a plain blog with no work.
It says yes for a portfolio that also offers freelance work or says hire me, and for a solo developer or designer under a studio name who shows projects they built.
A digital resume counts as a portfolio (it earns nothing for projects; that is the Code checks score's business), certificates are not projects, and a weak portfolio is still a portfolio.
Gemini writes a short `portfolio_reason` before its answer.
What a "no" does is unchanged: the Removal rule (`lib/reviews/door.mjs`) removes the site with a record and Undo when a junk rule fires or the code finds fewer than 4 of 6 portfolio signals, and holds it for the owner otherwise.

**Older grades:** grades made before v3 keep everything they stored (the letter, the four dropped scores and `quality_score`) in `portfolios.ai_rubric` and `rubric_history`; nothing is deleted.
No profile, list, stat, rank or tier reads those fields any more (`pipeline/rubric.mjs` `keptOutputs`); an old grade shows the same three things a new one does, without the reason it never had.
Three readers still use an older grade's letter, none shown while `GAMES_V2`, `GRADER_ENABLED` and `RANKING_V2` are off: the openskill views' seed (`lib/ranking/engine.mjs` `seedFromGrade`), the games' percentiles (`lib/games/pool.mjs`) and a person's grade report's comparison pool (`lib/grader/report.mjs` `gradedPool`).
A site is never re-graded because of v3: old rows wait for their next grade like any other (graded once, below).
A person's own "Grade my portfolio" request still uses the frozen v2 prompt (`pipeline/rubric-v2.mjs`) until the owner decides what that report shows.

**Facts** (`pipeline/facts.mjs`, free): measured by `pipeline/capture.mjs` from the rendered page and stored in `portfolios.facts`, with the visible page text (at most 4,000 characters) in `portfolios.page_text`.
Rows captured before v2 get both measured when they are next graded: over plain HTTP, or in a browser when the server sends under 200 characters of text (client-rendered sites).
Project and demo links (other sites and GitHub repositories, never social profiles or private addresses) are checked with HEAD, then GET, at most 8 per site with an 8-second timeout.
A 401, 403, 429 or 999 answer is a bot wall and counts as blocked, not broken.

**The request** (1 call per site): one image (the settled top of the page), the facts and the page text.
The name, address, facts and page text travel in one `<site_data>` block that the system instruction declares untrusted data, never instructions, and any marker inside the data is removed so it cannot close the block.
The template and the site builder are measured but no longer sent (template tracking is not used; the builder is information only).
Thinking is at the lowest level the model allows (`minimal`; a model that rejects it is asked again without it), each note is one short clause, and the answer is capped by a strict JSON schema and `maxOutputTokens`.
The parser keeps only the v3 fields: anything else in an answer (a letter, a dropped axis, a made-up field) is ignored and never stored.
Each grade in `portfolios.ai_rubric` stores `is_portfolio`, `portfolio_reason`, the five-second test with its note, `roles`, the code `checks` and `checks_score`, the `facts`, `rubric_version` (3), the model that answered and its token `usage` (input, output, thinking).
Motion is not an AI axis: the capture's frame difference is a fact.

<!-- rubric:start (generated by scripts/rubric-docs.mjs from pipeline/rubric.mjs; do not edit by hand) -->
Rubric version 3 (`pipeline/rubric.mjs`, prompt `grade-v3`).

| Id | Criterion | Measured by | Weight | What | Evidence |
| --- | --- | --- | ---: | --- | --- |
| `five_second_test` | Five-second test | Gemini | opinion, not scored | Clear who the person is and what they do within five seconds of landing. | top-of-page screenshot and the start of the page text |
| `resume` | Resume link | code | 12% | A link to a resume or CV. | links on the page |
| `github` | GitHub link | code | 12% | A link to a GitHub profile. | links on the page |
| `contact` | Contact path | code | 24% | A mailto link, a contact form, a contact page or a LinkedIn/social profile. | links and forms on the page |
| `project_links` | Project links load | code | 29% | Project and demo links answer (up to 8 checked, links in the projects and GitHub repositories first, then the site's own project pages, HEAD then GET, 8 s timeout); passes when at least 3 load (the site's own pages count only as real pages: on a host that answers an address that cannot exist, by their own text), and fails when fewer load or none were found; a link behind a bot check is left out. Facts measured before version 3 keep their rule: passes when at least one was checked and none is broken. | HTTP checks of the project links on the desktop and phone views and the site's own projects page |
| `own_domain` | Own domain | code | 12% | Served from the person's own domain, not a free hosting subdomain (vercel.app, github.io, netlify.app and similar). | final URL after redirects |
| `fresh_footer` | Fresh footer year | code | 12% | The footer copyright year is at most 2 years old; unknown when the page shows no year. | page text |
| `original` | Not a known template | code | context | No fingerprint of a known template (HTML5 UP, Start Bootstrap, BootstrapMade, Colorlib, a Brittany Chiang clone and others). | page HTML |
| `motion` | Motion detected | code | context | The top of the page changes on its own (frame difference over 3 seconds). | screenshots during capture |
| `pages` | Pages and sections | code | context | Internal pages linked from the home page and in-page sections in the navigation. | links on the page |
| `portfolio_signals` | Portfolio-likeness | code | context | How many of six portfolio signals the page has: projects, about, contact, resume, GitHub, the person's name in the title or heading. | page HTML (pipeline/signals.mjs) |

Gemini is asked three things and nothing else: `is_portfolio` with a short `portfolio_reason`, the five-second test (1 to 5 with a note), and up to 3 `roles`.
None of them is scored or used in a rank or tier; "not a portfolio" goes to the Removal rule.
Code criteria pass or fail and make up `checks_score` (weighted share passed, 0-100); unknown checks are left out of the share.
Criteria with weight "context" are measured and stored but not scored; all but the template are shown to Gemini as facts.
Each grade sends 1,120 image tokens (one screenshot), the rules, the facts and at most 4,000 characters of page text, with thinking at "minimal".
Grades from rubric 1 and 2 also stored `tier`, `visual_design`, `storytelling`, `writing`, `memorability`, `quality_score`; those stay in the database, no profile, list, stat, rank or tier reads them, and the readers that still use an old letter are named in section 6.
<!-- rubric:end -->

**Cost per grade** (offline estimate on 30 sampled sites, `npm run eval:rubric -- --sample 30`, at 3.5 Flash-Lite's paid rates of $0.30 in and $2.50 out per 1M tokens):

| Rubric | Images | Input tokens | Output tokens | Cost per grade |
| --- | ---: | ---: | ---: | ---: |
| v1 (until 2026-11-10) | 3 (2 from R2) | about 3,580 | about 400 | about $0.0021 |
| v2 (until 2026-11-23) | 1 | about 2,240 | about 130 | about $0.0010 |
| v3 (offline estimate, not measured live) | 1 | about the same as v2 (the longer portfolio rule replaces the dropped axes) | about 60, half of v2's | about $0.0008 |

The free tier counts requests, not tokens, so a grade is still one request; the savings matter at paid rates and for per-minute token limits.
`npm run eval:rubric -- --sample 30 --live` grades the sample with the current rubric and compares `is_portfolio` and the five-second test with the stored grades (it uses up to 60 of the day's 3.5 requests).

**Graded once:** a site is graded when it is added and never re-graded automatically, so a grade from an older rubric version stays as it is (owner, 2026-11-21; [docs/DECISIONS.md](docs/DECISIONS.md)).
A grade made again (a person's re-grade request, its one fresh grade after the owner's review, or a manual tool) moves the old grade to `rubric_history`.

**Pairwise pass:** removed on 2026-11-22.
It was one call for two sites, "which is better overall?", cast as a vote in the same ELO system as humans (`rater_type='ai'`); the votes it cast stay.
AI comparisons are now ranking v2's ([RANKING.md](RANKING.md)), off until `RANKING_V2` is on.

## 7. Human ELO (the master design ranking)

- Pairwise votes from the site; one vote per user per pair; GitHub sign-in for official votes.
- Human and AI votes share the ELO pool with the same weight (K = 32); a human "Superstar" vote counts double (K = 64).
  Votes are tagged by rater type, so either ranking can be recomputed from the raw vote log, and human votes could be weighted higher later; that weighting is not built.
- The leaderboard (`/top`) lists sites with at least 1 vote while AI votes bootstrap the ranking.

## 8. Bonus badges (GitHub API, only when a GitHub link exists)

- "Active builder" - recent commit activity, pinned repos with real READMEs
- Not a rank input; display-only.

## How scores combine

- **Primary sort = ELO** (design, human-weighted).
- Everything else is a scorecard + badges, not blended into one number:
  Engineering (PSI composite), Polish (% checklist),
  Checks (the rubric's `checks_score`, section 6),
  badges: *Blazing fast*, *Original* (planned, see section 5), *Dark mode*, *Active builder*, *Motion*.
- Disagreements ("gorgeous but slow") are surfaced, not averaged away - that's the
  interesting content.
