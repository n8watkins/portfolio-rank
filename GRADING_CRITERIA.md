# Grading Criteria

Every criterion below is assessed **automatically** — by deterministic scripts, free APIs, or
Gemini. Humans are never asked to grade a rubric. The only thing humans ever do is the optional
one-click "which is better?" vote (see PLAN.md → Voting UX).

Data source: `feed.json` from github.com/n8watkins/developer-portfolios (1,779 entries).

## Who assesses what

| Tier | Assessed by | Cost | Coverage |
|------|------------|------|----------|
| Gates | Playwright script | free | all sites, every refresh |
| Engineering | PageSpeed Insights API | free (25k/day) | all sites in 1 day |
| Polish | HTML-parse script | free | all sites in hours |
| Behavior | Playwright (same run as screenshots) | free | all sites |
| Originality | DOM-similarity script over our own dataset | free | all sites |
| Design & content | Gemini Flash (500 req/day budget) | free tier | rubric pass ~4 days, pairwise ongoing |
| Overall design rank | Human ELO votes + AI ELO votes | free | forever-refining |

## 1. Gates (pass/fail — unranked if failed)

Script: Playwright + logic from `developer-portfolios/src/check_parking_redirects.py`.

- [ ] HTTP 200 after redirects; not a parked/for-sale domain
- [ ] Page renders visible content within 5s (not blank / infinite spinner)
- [ ] Is actually a portfolio (Gemini confirms during its rubric pass; catches LinkedIn
      redirects, empty starter templates, hijacked domains)

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

## 5. Originality (dataset-relative — our unique advantage)

- DOM-shape hash + CSS class signature per site; cluster across all 1,779.
  Site matching ≥N others in-dataset → "template" flag. Structural one-of-one → high score.
- Second signal: fingerprints of known templates (HTML5UP, Start Bootstrap, popular
  Next.js/Astro portfolio starters).

## 6. Design & content (Gemini Flash, 500/day budget)

**Rubric pass** (1 call/site: 3-frame strip + extracted text → JSON):
each axis 1–5 + one-line justification (stored; shown in UI).

- Visual design — hierarchy, typography, color, use of space
- 5-second test — clear who they are and what they do from the hero alone
- Project storytelling — problem/outcome vs bare tech lists
- Writing quality — typos, clarity, voice
- Memorability — would you remember this site tomorrow
- Use of motion — tasteful / gratuitous / absent (from frame strip)

**Pairwise pass** (1 call = 2 sites): "which is better overall?" → vote into the same ELO
system as humans, tagged `rater=ai`. Pair selection: similar rating + low vote count
(uncertainty-prioritized), within rubric buckets first.

## 7. Human ELO (the master design ranking)

- Pairwise votes from the site; one vote per user per pair; GitHub OAuth required.
- Human and AI votes share the ELO pool but are tagged, so human votes can be weighted
  higher and either ranking can be recomputed from the raw vote log at any time.

## 8. Bonus badges (GitHub API, only when a GitHub link exists)

- "Active builder" — recent commit activity, pinned repos with real READMEs
- Not a rank input; display-only.

## How scores combine

- **Primary sort = ELO** (design, human-weighted).
- Everything else is a scorecard + badges, not blended into one number:
  Engineering (PSI composite), Polish (% checklist), Content (rubric avg),
  badges: *Blazing fast*, *Original*, *Dark mode*, *Active builder*, *Motion*.
- Disagreements ("gorgeous but slow") are surfaced, not averaged away — that's the
  interesting content.
