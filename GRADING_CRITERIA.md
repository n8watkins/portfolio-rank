# Grading Criteria

> Status (2026-11-10): gates, the weekly health check, PSI scorecards, polish/behavior checks, the Gemini rubric and human+AI ELO are live; see AUTOMATION.md for how they run.
> Rubric v2 (section 6): code measures the facts, Gemini judges quality from one screenshot and the page text.
> Not built yet: originality clustering (section 5) and weighting human votes above AI votes (section 7).
> Each section says where the running system differs from the plan.

Every criterion below is assessed **automatically** — by deterministic scripts, free APIs, or
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
| Design & content | Gemini Flash-Lite (free-tier daily budget), quality only | free tier | rubric for new sites, pairwise ongoing |
| Overall design rank | Human ELO votes + AI ELO votes | free | forever-refining |

## 1. Gates (pass/fail)

Scripts: `pipeline/capture.mjs` before screenshots, and the weekly health check (`pipeline/health.mjs`), sharing the parking tables in `pipeline/gate.mjs` (ported from `developer-portfolios/src/check_parking_redirects.py`).

- [ ] Loads (HTTP 2xx after redirects); not a parked or for-sale domain.
  A parking phrase only counts in the page title or on a page with little text, because real portfolios mention phrases like "make an offer".
- [ ] Renders visible content (text, or a canvas or images for canvas apps such as Flutter web); not blank.
- [ ] Is actually a portfolio: the Gemini rubric's `is_portfolio`.
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
- Mobile-friendly pass/fail (meta-viewport + viewport-insight + target-size composite —
  logic already written in the checkup route)

## 3. Polish checklist (HTML parse — one fetch per site)

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

## 6. Design & content (rubric v2: code checks facts, Gemini judges quality)

Owner rule (2026-11-10): anything code can check is measured for free and stored; Gemini only judges quality and gets the measured facts as a few lines of context.
The rubric lives in one pure module, `pipeline/rubric.mjs` (version, criteria, prompt, response schema, parser), used by the nightly grader, the eval and the docs.

**Facts** (`pipeline/facts.mjs`, free): measured by `pipeline/capture.mjs` from the rendered page and stored in `portfolios.facts`, with the visible page text (at most 4,000 characters) in `portfolios.page_text`.
Rows captured before v2 get both measured when they are next graded: over plain HTTP, or in a browser when the server sends under 200 characters of text (client-rendered sites).
Project and demo links (other sites and GitHub repositories, never social profiles or private addresses) are checked with HEAD, then GET, at most 8 per site with an 8-second timeout.
A 401, 403, 429 or 999 answer is a bot wall and counts as blocked, not broken.

**Rubric pass** (1 call per site): one image (the settled top of the page), the facts and the page text.
The name, address, facts and page text travel in one `<site_data>` block that the system instruction declares untrusted data, never instructions, and any marker inside the data is removed so it cannot close the block.
Thinking is at the lowest level the model allows (`minimal`; a model that rejects it is asked again without it), each note is one short clause, and the answer is capped by a strict JSON schema and `maxOutputTokens`.
Each grade in `portfolios.ai_rubric` stores Gemini's own letter (`tier`, S/A/B/C/D; it seeds the leaderboard and breaks ties, but is never shown), `is_portfolio`, the five scores with notes, `quality_score`, the code `checks` and `checks_score`, the `facts`, `rubric_version`, the model that answered and its token `usage` (input, output, thinking).
Motion is no longer an AI axis: the capture's frame difference is a fact, and the "3 seconds later" frame and the shrunken full-page image are no longer sent.

<!-- rubric:start (generated by scripts/rubric-docs.mjs from pipeline/rubric.mjs; do not edit by hand) -->
Rubric version 2 (`pipeline/rubric.mjs`).

| Id | Criterion | Measured by | Weight | What | Evidence |
| --- | --- | --- | ---: | --- | --- |
| `visual_design` | Visual design | Gemini | 30% | Hierarchy, typography, color and use of space. | top-of-page screenshot |
| `five_second_test` | Five-second test | Gemini | 20% | Clear who the person is and what they do within five seconds of landing. | top-of-page screenshot and the start of the page text |
| `storytelling` | Project presentation | Gemini | 25% | Projects shown with the problem, their role, the outcome and links, rather than bare tech lists. | page text, with project-link health as context |
| `writing` | Writing | Gemini | 15% | Clarity, voice, concision and typos. | page text |
| `memorability` | Memorability | Gemini | 10% | Would a recruiter remember this site tomorrow. | screenshot and page text |
| `resume` | Resume link | code | 10% | A link to a resume or CV. | links on the page |
| `github` | GitHub link | code | 10% | A link to a GitHub profile. | links on the page |
| `contact` | Contact path | code | 20% | A mailto link, a contact form, a contact page or a LinkedIn/social profile. | links and forms on the page |
| `project_links` | Project links load | code | 25% | Project and demo links answer (up to 8 checked, HEAD then GET, 8 s timeout); passes when at least one was checked and none is broken. | HTTP checks of the page's outbound project links |
| `own_domain` | Own domain | code | 10% | Served from the person's own domain, not a free hosting subdomain (vercel.app, github.io, netlify.app and similar). | final URL after redirects |
| `fresh_footer` | Fresh footer year | code | 10% | The footer copyright year is at most 2 years old; unknown when the page shows no year. | page text |
| `original` | Not a known template | code | 15% | No fingerprint of a known template (HTML5 UP, Start Bootstrap, BootstrapMade, Colorlib, a Brittany Chiang clone and others). | page HTML |
| `motion` | Motion detected | code | context | The top of the page changes on its own (frame difference over 3 seconds). | screenshots during capture |
| `pages` | Pages and sections | code | context | Internal pages linked from the home page and in-page sections in the navigation. | links on the page |
| `portfolio_signals` | Portfolio-likeness | code | context | How many of six portfolio signals the page has: projects, about, contact, resume, GitHub, the person's name in the title or heading. | page HTML (pipeline/signals.mjs) |

Gemini criteria are scored 1 to 5 and make up `quality_score` (weighted mean, 1-5).
Code criteria pass or fail and make up `checks_score` (weighted share passed, 0-100); unknown checks are left out of the share.
Criteria with weight "context" are measured, stored and shown to Gemini, but not scored.
Each grade sends 1,120 image tokens (one screenshot), the rules, the facts and at most 4,000 characters of page text, with thinking at "minimal".
<!-- rubric:end -->

**Tiers by rank** (`lib/tiers.mjs`, owner decision 2026-11-12): the tier a portfolio shows is its place in the graded library, written into its grade as `rank` = { tier, score, top }.
The score (0-100) is 80% the AI quality score (1-5 put on 0-100) and 20% `checks_score`; a grade without code checks counts 85, about the library's median.
Equal scores are split by Gemini's letter; portfolios still equal share a place, the middle of their group, and so a tier.

| Tier | Place in the library |
| --- | --- |
| SSS | top 2% |
| SS | top 5% |
| S | top 10% |
| A | top 20% |
| B | down to the 80th percentile (shown publicly down to here) |
| C | the next 15% |
| D | the bottom 5% |

A tier is only given when its band holds at least one whole portfolio (SSS needs 50 graded portfolios, SS and D 20, S 10); otherwise the next tier toward B.
`refreshTiers` places every grade again hourly (`worker/tiers.ts`) and at each deploy (`scripts/refresh-tiers.mjs`); a new grade is placed against the last library as it is written.

**Cost per grade** (offline estimate on 30 sampled sites, `npm run eval:rubric -- --sample 30`, at 3.5 Flash-Lite's paid rates of $0.30 in and $2.50 out per 1M tokens):

| Rubric | Images | Input tokens | Output tokens | Cost per grade |
| --- | ---: | ---: | ---: | ---: |
| v1 (until 2026-11-10) | 3 (2 from R2) | about 3,580 | about 400 | about $0.0021 |
| v2 | 1 | about 2,240 | about 130 | about $0.0010 |

The free tier counts requests, not tokens, so a grade is still one request; the savings matter at paid rates and for per-minute token limits.
`npm run eval:rubric -- --sample 30 --live` grades the sample with v2 and compares it with the stored grades (it uses up to 60 of the day's 3.5 requests).

**Re-grades:** grades from an older rubric version are re-graded at the lowest priority, after new and ungraded sites and after the 3.1-to-3.5 re-grades, inside the daily grading budget, and only when the repository variable `RUBRIC_REGRADE` is `true` (off until the owner turns it on).
The old grade moves to `rubric_history`; the weekly 3.1-vs-3.5 report only pairs grades from the same rubric version.

**Pairwise pass** (1 call = 2 sites): "which is better overall?" from the two hero screenshots plus cached Lighthouse and polish signals.
The answer is a vote in the same ELO system as humans, tagged `rater_type='ai'`.
The pool is graded S/A/B sites that are on the list, not confirmed down and not graded `is_portfolio=false`; pairs favor the least-voted sites with close ratings.

## 7. Human ELO (the master design ranking)

- Pairwise votes from the site; one vote per user per pair; GitHub sign-in for official votes.
- Human and AI votes share the ELO pool with the same weight (K = 32); a human "Superstar" vote counts double (K = 64).
  Votes are tagged by rater type, so either ranking can be recomputed from the raw vote log, and human votes could be weighted higher later; that weighting is not built.
- The leaderboard (`/top`) lists sites with at least 1 vote while AI votes bootstrap the ranking.

## 8. Bonus badges (GitHub API, only when a GitHub link exists)

- "Active builder" — recent commit activity, pinned repos with real READMEs
- Not a rank input; display-only.

## How scores combine

- **Primary sort = ELO** (design, human-weighted).
- Everything else is a scorecard + badges, not blended into one number:
  Engineering (PSI composite), Polish (% checklist), Content (the rubric's `quality_score`),
  Checks (the rubric's `checks_score`, section 6),
  badges: *Blazing fast*, *Original* (planned, see section 5), *Dark mode*, *Active builder*, *Motion*.
- Disagreements ("gorgeous but slow") are surfaced, not averaged away — that's the
  interesting content.
