# Grading Criteria

> Status (2026-11-10): gates, the weekly health check, PSI scorecards, polish/behavior checks, the Gemini rubric and human+AI ELO are live; see AUTOMATION.md for how they run.
> Not built yet: originality scoring (section 5) and weighting human votes above AI votes (section 7).
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
| Originality | not built (capture stores DOM/class hashes only) | free | none yet |
| Design & content | Gemini Flash-Lite (free-tier daily budget) | free tier | rubric for new sites, pairwise ongoing |
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
- Motion detected (frame-diff across 3 captures) — feeds AI judge, not scored directly

## 5. Originality (dataset-relative, not built)

Planned:

- DOM-shape hash + CSS class signature per site, clustered across the whole list.
  A site matching N or more others in the dataset gets a "template" flag; a structural one-of-one scores high.
- A second signal: fingerprints of known templates (HTML5UP, Start Bootstrap, popular Next.js/Astro portfolio starters).

Today `pipeline/capture.mjs` stores `domHash` and `classHash` in each site's `meta`, but nothing clusters them and no score or badge uses them.

## 6. Design & content (Gemini Flash, 500/day budget)

**Rubric pass** (1 call per site, images only, no extracted text):
locally, the settled viewport, the same viewport 3 seconds later and the full page; in CI from R2, the hero and the full page plus the stored motion flag.
Each axis is scored 1-5 with a one-line justification (stored in `portfolios.ai_rubric`, shown on the detail page), plus a tier (S/A/B/C/D) and `is_portfolio`.

- Visual design — hierarchy, typography, color, use of space
- 5-second test — clear who they are and what they do from the hero alone
- Project storytelling — problem/outcome vs bare tech lists
- Writing quality — typos, clarity, voice
- Memorability — would you remember this site tomorrow
- Use of motion — tasteful / gratuitous / absent (from frame strip)

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
  Engineering (PSI composite), Polish (% checklist), Content (rubric avg),
  badges: *Blazing fast*, *Original* (planned, see section 5), *Dark mode*, *Active builder*, *Motion*.
- Disagreements ("gorgeous but slow") are surfaced, not averaged away — that's the
  interesting content.
