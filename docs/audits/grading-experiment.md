# Grading experiment: rubric v3, batches of 5, richer evidence

PortfolioRank, 2026-11-13, branch `exp/grading-v3`.
Model `gemini-3.5-flash-lite` (the production grading model), 376 requests on one Pacific quota day, all labelled `job = exp-grading-v3` with a prompt id.
Nothing wrote to any grade, rating or tier; results are local files in `experiments/grading-v3/data`.
The hosted copy of this report: https://claude.ai/artifact/UVo5LGTefzcjTQAjeCJML9

## Bottom line

None of the three pre-set rules passed.
Rubric v3 does not agree with the answer key more than v2 (Spearman 0.74 against 0.77 per run, a gap well inside the noise).
Batches of 5 rank as well as solo grading, but their scores are not interchangeable with solo scores.
Richer evidence (phone and projects screenshots) did not help and costs 70% more input tokens.

Two follow-ups, not pre-registered, change the picture.
With thinking set to "low", v3 becomes the steadiest mode measured (run-to-run Spearman 0.94) and matches v2 on agreement.
Batches of 5 with thinking "low" agree with the key as well as solo grading (0.77 against 0.76) and repeat themselves well (0.91).

Recommendation: ship v3 as the report-card format with thinking "low", graded in batches of 5 as a whole-library switch (never mixed with solo grades), keep today's single screenshot, and fix v3's weaker not-a-portfolio gate first.
Do it for report-card quality, stability and five times the grading capacity, not for ranking accuracy: no version here ranks measurably better than today's v2.

## The answer key

The owner asked not to be involved, so the answer key is mine (Claude Opus 5.5).

- Sample: 40 live portfolios with a rubric v2 grade, a saved screenshot and stored text, one from each 2.5% slice of the 775 eligible sites ordered by stored score (seed 3), with backups for sites that would not load (1 replaced).
- Evidence: every site captured locally with Playwright on 2026-11-13: desktop top (1440x900), phone top (390x844), the projects section, the full page and the full rendered text.
  All modes and the key saw the same capture.
- Method: I viewed each site's desktop, projects and phone screenshots and read its page text, in a shuffled order that hid stored scores, and scored each 0-100 for design craft, clarity in five seconds, project substance, writing and memorability.
  I sorted, broke ties by hand, recorded a reason per site and five tie groups, and committed the key (`answer-key.json`) before reading any model output.
- Second pass: a fresh-context instance of the same model ranked 15 randomly chosen sites under new labels in a new order, without the first pass.
  Agreement with the first pass: Spearman 0.70, Kendall 0.52, largest move 6 places.
  The 15 happened to miss my top 10, a narrower range that lowers correlation.

What that means: one judge's ranking repeats itself at about 0.7 to 0.8, and model-to-key agreement sits at about the same level.
This key can detect differences of about 0.1 in Spearman, not the 0.02 to 0.04 gaps seen here.

## Results

Agreement is with the answer key over 40 sites; each mode ran twice.
Top/bottom 10 is how many of the key's top (bottom) 10 the mode also put in its top (bottom) 10, run 1 / run 2.
Retest is run 1 against run 2.

| Mode | Spearman r1 / r2 (mean) | Kendall (mean) | Top 10 | Bottom 10 | Retest Spearman | Mean change between runs (1-5) | Same axis score between runs |
| --- | --- | ---: | --- | --- | ---: | ---: | ---: |
| Production v2, stored grade | 0.75 | 0.59 | 8 | 7 | - | - | - |
| v2 solo | 0.75 / 0.78 (0.77) | 0.61 | 5 / 7 | 6 / 8 | 0.89 | 0.13 | 86% |
| v3 solo | 0.73 / 0.75 (0.74) | 0.56 | 7 / 6 | 7 / 6 | 0.85 | 0.26 | 76% |
| v3 batch of 5 | 0.73 / 0.70 (0.72) | 0.54 | 7 / 5 | 8 / 7 | 0.74 | 0.37 | 57% |
| v3 solo, richer evidence | 0.71 / 0.73 (0.72) | 0.56 | 7 / 6 | 7 / 7 | 0.83 | 0.22 | 74% |
| Follow-up: v3 solo, thinking low | 0.77 / 0.74 (0.76) | 0.60 | 8 / 8 | 7 / 6 | 0.94 | 0.14 | 85% |
| Follow-up: v3 batch of 5, thinking low | 0.81 / 0.74 (0.77) | 0.60 | 7 / 5 | 7 / 7 | 0.91 | 0.28 | 62% |

### A: v2 solo against v3 solo

Rule (fixed before any request): v3 passes when its mean Spearman with the key is higher than v2's and its retest Spearman is no more than 0.05 below v2's.

- Agreement: v3 0.74, v2 0.77. Not higher. Bootstrap over sites, v3 minus v2: -0.04 (90% interval -0.13 to +0.04).
- Steadiness: v3 0.85, v2 0.89. Within 0.05.
- Result: **fail**.

Follow-up: v3 with thinking "low" reaches 0.76 (v3-low minus v2: -0.04, interval -0.16 to +0.07) with the best retest of any mode (0.94).
The API reported 0 thinking tokens at both levels, yet the answers changed measurably.

### B: v3 solo against v3 in batches of 5

Rule: batches pass when (1) the mean distance between a batch grade and a solo grade is no more than solo-against-solo distance + 0.05, and (2) the batch runs' mean Spearman is no more than max(0.03, the gap between the solo runs) below solo.

- Distance: batch to solo 0.34, solo to solo 0.26. Over the limit (0.31).
- Agreement: batch 0.72, solo 0.74, within the 0.03 tolerance.
- Result: **fail** (scores drift).

What the drift is: batch grades sit 0.19 lower on average, and even after removing that shift they differ from solo grades site by site.
The batch's own returned order puts 83% of within-batch pairs in the key's order, better than the solo scores on the same pairs (78%).
No strong position effect: the site shown first was ordered first 2 times in 16, the fourth 6 times.

Follow-up with thinking "low": agreement 0.77 against solo 0.76 (passes), retest 0.91, but the distance to solo is 0.33 against solo-to-solo 0.14 (0.30 after removing a -0.21 shift), so the drift rule still fails.
Batch grades are a consistent, equally accurate measure, but a different one: never mix them with solo grades in one ranking.

### C: today's evidence against richer evidence

Rule: richer evidence passes when its mean Spearman beats v3 solo's by more than the gap between v3 solo's two runs, and its Kendall is higher too.

- Agreement: richer 0.72, v3 solo 0.74 (gain -0.02, noise 0.01). Bootstrap -0.04 (interval -0.14 to +0.07).
- Result: **fail**.
- Cost: 5,390 input tokens per grade against 3,160 (two more images).

### Score spread

Share of 5s per axis over both runs (visual design / five-second test / project presentation / writing / memorability):

| Mode | Share of 5s | Quality SD across sites |
| --- | --- | ---: |
| v2 solo | 39% / 80% / 5% / 41% / 20% | 0.76 |
| v3 solo | 53% / 73% / 19% / 41% / 39% | 0.67 |
| v3 solo, thinking low | 43% / 71% / 14% / 31% / 21% | 0.56 |
| v3 batch of 5, thinking low | 38% / 49% / 10% / 26% / 26% | 0.72 |

The described levels did not stop scores piling up at the top: the five-second test still gives a 5 to 71% of sites solo.
Batches spread scores more (49% fives on the five-second test).

### The not-a-portfolio gate

One site (an AI-chat template still showing its demo name, "Hey, I'm Aaaaby") is not a real portfolio.
v2 flagged it in 2 of 2 runs, v3 in 1 of 2, v3 thinking low in 0 of 2, the batches in 1 of 2 each.
v3 is weaker here and needs a fix before it ships.

## Five sites side by side

| Site | My place and reason | v2 (place, a note) | v3 thinking low (place, a reason and its improvement) |
| --- | --- | --- | --- |
| custard.top | 1. Refined serif editorial design, a specific research focus, reproducible case studies with real numbers, excellent writing. | 2. "Projects presented thoroughly with explicit problem definitions and methodology." | 4. "Projects feature clear problem context, robust technical stacks, reproducible scripts mentioned...". No improvement (a 5). |
| jos.gg | 3. Pixel-art identity, live player count, testimonials, founder of a game studio. | 4. "Detailed project breakdowns with strong client testimonials and active links." | 10. "Active projects like Hack Club and Starnova Studios show roles, dates, descriptions and working links." Improve: "Add concrete outcomes or metrics achieved for each listed project." |
| maveeshah.github.io/projects.html | 4. Elegant serif editorial, own ventures plus many real client systems, clear writing. | 14. "Detailed project breakdowns with tech stacks and real contexts." | 28. Five-second test 3: "Name is visible, but the exact role is missing above the fold." |
| zalt.me | 13. Polished AI consultancy with a live product; salesy, stat fluff, endless tech marquee. | 1. "Exceptional presentation of real projects, books, and products." | 9. "Projects like the autonomous AI workforce feature detailed descriptions..." Improve: "Add your specific role and measurable outcomes for each showcased project." |
| toukoum.fr | 39. An AI-chat template showing "Hey, I'm Aaaaby"; no visible work. | 40, flagged not a portfolio. "Name and placeholder data suggest an unconfigured template." | 38, not flagged, quality 3.3. Five-second test 4: "clearly displays 'Hey, I'm Aaaaby' and 'AI Engineer'." |

The pattern across the 40: every mode finds the clear top and bottom, and all of them scatter in the middle, where most sites score between 3.8 and 5.0.
Models favour polished agency-style sites (zalt.me) and undervalue a strong projects page that skips the hero (maveeshah) and playful identities (jos.gg).
v3's reasons quote the page and its improvements are concrete, which v2's 12-word notes never are.

## Requests used

| Prompt | Requests | Answered | Input tokens | Output tokens |
| --- | ---: | ---: | ---: | ---: |
| grade-v2 | 80 | 80 | 204,128 | 17,489 |
| grade-v3 | 80 | 80 | 252,970 | 26,746 |
| grade-v3-rich | 80 | 80 | 431,168 | 27,011 |
| grade-v3-batch (16 batches of 5) | 16 | 16 | 184,394 | 27,756 |
| grade-v3-think-low (follow-up) | 80 | 80 | 252,970 | 26,383 |
| grade-v3-batch-think-low (follow-up) | 16 | 16 | 184,394 | 27,158 |
| HTTP 503 retries | 24 | - | - | - |
| Total | 376 | 352 | 1,510,024 | 152,543 |

All 376 on 2026-11-13 (Pacific), under the 430 stop; production background Gemini stayed frozen.
Per site, a batch of 5 costs about 2,300 input tokens against 3,160 solo, and one request instead of five.

## Recommendation: what grading should become

1. **Rubric v3 as the report-card format, with thinking "low".**
   Reason first, described levels, no Gemini letter, roles first, a "how to improve" line per axis and the projects-aware excerpt.
   It ranks as well as v2 (no measurable gain), is the steadiest mode measured, and its text is far more useful to the person graded.
2. **Grade in batches of 5, as a whole-library switch.**
   With thinking "low", batches rank as well as solo grading and repeat themselves well, at a fifth of the requests (grading from about 400 to about 80 a day).
   Their scores sit about 0.2 lower and differ site by site, so re-grade the whole library in batch mode once and never mix batch and solo grades in one ranking.
   Store each batch's order as a low-weight comparison: it matched the key on 84% of pairs.
3. **Keep one desktop screenshot.**
   Phone and projects screenshots did not improve agreement and add 70% input tokens; the phone view's breakage is better caught by code (overflow checks already exist).
4. **Before shipping v3, fix two weaknesses.**
   Restore the not-a-portfolio gate (v2's wording caught the template demo every time; also add a code check for template demo content).
   Tighten the level-5 lines for the five-second test and visual design, and judge success by share of 5s on this set (target under 40%).
   Check both with one more round on these 40 sites (about 32 batch requests).
5. **Do not re-grade for accuracy alone.**
   Today's stored v2 grades agree with the key at 0.75, the same as every mode here; re-grade only to get the v3 report card and the batch switch.
6. **Get the owner's own key when there is time.**
   This key repeats itself at about 0.7, so it can only show large differences; 15 minutes of the owner sorting the same 40 would tell whether these rankings match the owner's taste.

## What is on the branch

- `pipeline/rubric-v3.mjs`: rubric v3 (solo, richer-evidence and batch shapes; prompt ids `grade-v3`, `grade-v3-rich`, `grade-v3-batch`), behind its own version id; nothing in production uses it.
- `pipeline/excerpt.mjs`: the projects-aware excerpt and the in-page projects finder.
- `scripts/experiments/grading-v3.mjs` (`npm run exp:grading-v3 -- <sample|capture|reoutline|sheets|run|analyze> --out DIR`).
- `tests/rubric-v3.test.mjs`.
- `experiments/grading-v3/data`: the answer key, the plan, every answer, the analysis and per-site ranks; screenshots and page text stay local.
- The prompt-label commits from PR #148 (`gemini_requests.prompt`), so this branch logs prompt ids; they drop out when #148 lands.
