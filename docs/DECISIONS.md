# Decisions

The owner's standing decisions and the technical choices made with them.
This file is the single source of truth: read it before changing product, grading, ranking, content or email, and add every new decision here, with its date, in the same change.
The order of work lives in [ROADMAP.md](ROADMAP.md); how the running system works lives in [AUTOMATION.md](../AUTOMATION.md) and [GRADING_CRITERIA.md](../GRADING_CRITERIA.md).

Each entry says who decided ("owner" for Nathan, "agent" for a technical choice made under his rules), the date, one line of why, and a status:

- **built**: merged on `main` (with the PR number).
- **building**: a lane or PR is open.
- **planned**: decided, not started.

## Gemini

- **3.5 Flash-Lite first, 3.1 Flash-Lite as the backup** (owner, 2026-11-10). Status: built (#52, #54).
  `gemini-3.5-flash-lite` answers everything until its daily quota is spent; `gemini-3.1-flash-lite` only then.
  An overloaded, timed-out or unreachable 3.5 is retried on 3.5 after 10, 30 and 60 seconds, and only a call that still fails goes to 3.1; the next call is back on 3.5.
  Why: 3.5 is the stronger judge, and every test-run switch to 3.1 was Google's 503 "busy", not us sending too fast, so a retry usually wins.
- **The key goes in the `x-goog-api-key` header, never in the URL** (agent, 2026-11-10). Status: built (#52).
  Why: newer AI Studio keys are rejected as `?key=`, which is what killed grading from late July, and a URL key leaks into logs.
- **Every grade and vote records the model that answered** (owner, 2026-11-10). Status: built (#52).
  Why: the two models can score the same site differently, so a grade without its model can't be compared.
- **A dead key turns the run red** (agent, 2026-11-10). Status: built (#52).
  Why: grading was dead for three months while every job showed green.
- **Quotas: 500 requests a day on 3.5 and 500 on 3.1, per Google Cloud project** (owner, 2026-11-10). Status: built (#54).
  The defaults live in the `GEMINI_DAILY_QUOTA` repository variable.
  Why: these are the owner's free-tier numbers; Google counts per project, not per key, so a second key in the same project adds nothing.
- **Pacing and a request log** (agent, 2026-11-10). Status: built (#54).
  One limiter per run spaces every request (8 a minute by default), every request is a row in `gemini_requests`, and each run's summary shows today's totals against the quotas with a warning from 80%.
  Why: real numbers instead of estimates, and one place to see when a quota is about to run out.
- **Catch-up mode** (owner, 2026-11-10). Status: built (#54); on until the backlog and the one-time re-grade are done.
  While `GEMINI_CATCHUP` is on, grading spends 3.5's budget first and then 3.1's, about 850 grades a day.
  Why: about 675 listed sites had no grade after the outage, and both quotas together clear that in a day or two.
- **Conditional re-grades of 3.1 grades on 3.5** (owner, 2026-11-10). Status: built (#54); the stop rule is planned.
  Every 3.1 grade is queued for a 3.5 re-grade from spare 3.5 budget, and the old grade moves to `rubric_history`, so each re-grade is a free 3.1-vs-3.5 pair for the Sunday comparison report.
  The re-grades stop once that report shows no meaningful difference (for example, tiers differ on 10% of sites or fewer), and the quota goes back to ranking and content.
  Why: the leaderboard should compare like with like, but not spend quota proving a difference that isn't there.
- **A paid key comes later, with a hard cap** (owner, 2026-11-10). Status: planned.
  Free quota first; billing with a Google budget alert and an in-app daily cap only when grades outgrow it, and before any launch post.
  Why: a grade costs about $0.001 on rubric v2 at paid rates, so paid is cheap, but free covers today's volume.

## Cleanup and the list

- **Our own cleanup, our list wins** (owner, 2026-11-10). Status: built (#53).
  Every background job works only on sites on the current list; rows that leave the list are deleted after 30 days, with their votes kept.
  Our exclusions override the community list, and `/removed` shows what was removed and why.
  Why: 254 unlisted sites were still being graded and voted on, and we can't rely on the community list being right for our purposes.
- **Health check thresholds** (owner, 2026-11-10). Status: built (#53).
  Weekly check; `live` to `suspect` on any failure, `down` only after 3 failed checks in a row spanning at least 13 days; a pass resets to `live`.
  Bot walls are inconclusive, a redirect to another domain is a move, a run where more than 30% fail records nothing, and at most 10% of the list leaves at once.
  Failed captures retry after 1, 2, 4, 8, 16, then every 30 days.
  Why: one check of every site found 1,995 fine and a handful of noisy failures, too noisy to remove anything on one result; one screenshot timeout used to hide a site forever.
- **Free portfolio-likeness check before Gemini** (agent, 2026-11-10). Status: built (#53).
  Six yes/no signals from the page; a page with one or fewer is flagged and graded first so Gemini's `is_portfolio` confirms or clears it, never removed for it.
  Why: catches non-portfolios for free and spends Gemini only on the doubtful ones.
- **Upstream is report-only** (owner, 2026-11-10). Status: built (#53).
  A monthly report lists only what the community list's own Saturday link checker misses; opening a PR there is off.
  Why: their checker already removes broken and parked links, so our PRs would duplicate it.
- **Feed shrink guard** (agent, 2026-11-10). Status: built (#53).
  The sync fails rather than write a list more than 5% smaller.
  Why: a broken upstream file should never wipe the site.

## Grading

- **Code checks facts; Gemini judges quality** (owner, 2026-11-10). Status: built (#57).
  Anything a script can check (resume link, GitHub link, contact path, project links that load, own domain, footer year, template, pages, motion) is measured by our code; Gemini judges only design, clarity, project presentation, writing and memorability, with the facts as context.
  Why: facts from code are free and give the same answer every time; AI is for judgment a script can't make.
- **Rubric v2** (owner rule, agent design, 2026-11-10). Status: built (#57).
  One screenshot, the facts and up to 4,000 characters of page text in one request, thinking at `minimal`, a strict JSON schema, short notes, and a `rubric_version` on every grade.
  The rubric is defined once in `pipeline/rubric.mjs` and the table in GRADING_CRITERIA.md is generated from it.
  Why: the old grade sent three images (one only to spot animation, one shrunk past reading) and no text; v2 halves the cost and gives writing and storytelling real evidence.
- **Page text is untrusted data** (agent, 2026-11-10). Status: built (#57).
  It travels in a `<site_data>` block the instructions mark as data, never instructions.
  Why: once grades are public, sites will try to talk to the judge.
- **One full re-grade on v2, when the owner turns it on** (owner, 2026-11-10). Status: built behind the `RUBRIC_REGRADE` variable, off.
  Why: about 2,000 grades (4 to 5 days of 3.5's grading budget) so every listed site is on the same rubric; it waits until catch-up is done.

## Ranking

- **OpenSkill ratings, seeded from the grade** (owner asked the agent to pick, 2026-11-10). Status: planned.
  Each site starts at a rating from its tier, nudged by its scores, and comparisons move it from there; the system tracks how sure it is about each site.
  Why: OpenSkill, like Glicko-2, tracks certainty and is permissively licensed, and unlike Glicko-2 it rates a whole ordered group at once, which is what batched comparisons produce; plain ELO treats every site the same.
- **Three leaderboard views, merged by default** (owner, 2026-11-10). Status: planned.
  Merged (AI and people) is the default, with AI-only and People-only tabs; big gaps between AI and people are flagged and become reports.
  Why: about 85% of today's leaderboard votes are AI votes counted like people's; separate views let the AI compare all day without drowning people out.
- **AI comparisons use 3.5 only** (agent, 2026-11-10). Status: planned.
  Why: the AI view needs one consistent judge; 3.1 is for catching up on grades.
- **Matchmaking: close matches, 1 in 5 random** (owner, 2026-11-10). Status: planned.
  Four of every five comparisons pair sites with similar ratings, favouring the least certain; one pairs a site with a random one from anywhere; which site is shown first is random, and pairs come from a recorded seed so a day can be reproduced.
  Why: close matches teach the most, the random one lets a much-improved site jump fast, and random order cancels the judge's first-position bias.
- **Settled sites are compared less; a redesign resets certainty** (agent, 2026-11-10). Status: planned.
  When a site's page fingerprint changes it is re-captured and re-graded and its certainty resets.
  Why: budget goes where the board is least sure, and real change is visible fast.
- **Open method** (agent, 2026-11-10). Status: planned.
  A public method page and a downloadable comparison log (pair, model, prompt version, winner), so anyone can recompute the board.
  Why: a leaderboard nobody can check is worth little.

## Gemini budget, one key

- **Daily split on 3.5: 100 / 100 / 100 / 100 plus buffer** (owner, 2026-11-10). Status: planned; today only the grading budget exists (#54).
  100 for people's grades ("grade my portfolio"), 100 one-on-one ranking comparisons, 100 batched ranking comparisons, 100 for the content engine, then 50 for catch-up and re-grades and 50 for retries and buffer.
  On 3.1: about 250 catch-up grading, 150 trend analysis (10 portfolios a request) and 100 fallback.
  This replaces the earlier 125 + 125 comparison split and the 150 / 125 / 125 / 30 / 10 / 60 split in the build outline.
  Why: the owner wanted each job to get a real share, and an engine that publishes with no oversight needs more requests for drafting and self-checks, not fewer.
- **Shares flex, with a priority order** (agent, 2026-11-10). Status: planned.
  What a job hasn't used by 18:00 UTC rolls to catch-up and ranking; when 3.5 runs out, people's grades and new sites go first, then content, then ranking and experiments; people's grades past their share go to the email queue.
  Why: no quota is wasted and people never lose to background work.
- **One budget, enforced in one place, with kill switches** (agent, 2026-11-10). Status: planned.
  One setting each pauses grading, comparisons, publishing and email.
  Why: one key serves every job, so only a single ledger can keep them from starving each other.

## Experiments

- **Batched comparisons are experiment-only first** (owner, 2026-11-10). Status: planned.
  The 100 batched comparisons a day (one request, several sites) are tagged by method and count only as an experiment for the first two weeks; they join the ranking once they agree well enough with one-on-one.
  Why: one request for several sites is far cheaper, but it has to earn its place against the one-on-one judge.
- **Every comparison is tagged** with method, model and prompt version in an experiments table (agent, 2026-11-10). Status: planned.
  Why: the weekly analysis and every experiment post come straight from stored data, at no extra AI cost.
- **Placement experiment: 1 request vs 10** (owner idea and go-ahead, 2026-11-10). Status: planned.
  A new site plays about 10 placement matches against a published reference set of about 30 settled portfolios, either as 10 separate requests or as one request with all 10; 100 sites through both, the one-request method run twice in different orders, with a one-on-one repeat as the noise baseline.
  It costs about 1,200 requests, about 10 days of the experiment budget, and ends as a public report.
  Why: if one request places a site nearly as well, placement gets about 10 times cheaper.

## Site

- **Structure of the redesign** (owner, 2026-11-10). Status: planned; a preview comes first.
  One shared shell (header, account menu, width, footer), a light theme beside dark, real icons instead of emoji.
  Pages: home `/`, grade `/grade` and `/grade/[id]`, leaderboard `/top` with three tabs, face-off `/rank`, browse `/browse` (the full grid moves off home, paged on the server), portfolio `/p/[slug]`, blog `/blog`, criteria `/criteria` (absorbs "How it works"), `/removed`.
  Desktop header: Leaderboard, Face-off, Browse, Blog and one highlighted "Grade yours"; phones get a bottom tab bar (Top, Face-off, Grade, Browse, More).
  Why: the site is gaining grading, three views, a blog and a newsletter, and today's four different headers and do-everything home can't hold them; home also ships all 2,000 portfolios, the main reason for its phone speed of 58.
- **Adaptive home** (owner, 2026-11-10). Status: planned.
  The top of home and a "Your portfolio" entry change with the visitor: first visit sees "How good is your portfolio?"; someone graded before sees their card; a signed-in listed developer sees their rank in each view and movement; a queued report shows its progress.
  Everything about your own site lives on one "Your portfolio" page, and things already done (newsletter box for subscribers, the practice-vote intro) are hidden.
  Why: asking "how good is your portfolio?" makes no sense to someone who already knows.
- **Facts and AI judgment are shown apart** on the grade card, which is the same on reports and portfolio pages (owner rule, 2026-11-10). Status: planned.
  Why: follows "code checks facts, Gemini judges quality" and keeps the AI's part visibly labelled.
- **Sign-in as a proper window** (agent, from the site audit, 2026-11-10). Status: built (#56).
  Why: it opened trapped inside the header or a card, the one critical audit finding.
- **Practice votes can't be fished for, claims can't overspend** (agent, from the site audit, 2026-11-10). Status: built (#58).
  Why: a script could redraw pairs until a chosen site appeared and claim those votes at sign-in.
- **Lint on every PR** (agent, from the site audit, 2026-11-10). Status: building (#59).
  Why: the repo had no lint setup at all.

## Content engine

- **Fully automatic and fail-closed** (owner, 2026-11-10). Status: planned.
  Posts publish on their own with no review step; a draft that fails a check is revised automatically, and if it still fails after two rounds it is dropped, never published and never queued for the owner.
  Every number must match what code computed, links must load, quotes and sources can't be invented, a second Gemini pass reviews tone and claims, and a later data check that contradicts a post unpublishes it with a correction note.
  The owner is informed, not asked: a weekly "what went out" email, plus an admin page and kill switches.
  Why: the owner wants it to run without him; failing closed means the cost of a bad draft is a missing post, not a wrong one in his name.
- **The naming rule** (owner, 2026-11-10). Status: planned.
  Individual developers are named only for positive reasons (top sites, climbers, redesigns that paid off); anything critical or any low score is discussed only in aggregate.
  A post that breaks it is dropped.
  Why: posts and the leaderboard are about real people who never asked to be written about.
- **Facts from code, words from Gemini** (owner rule, 2026-11-10). Status: planned.
  The pipeline is find, pick, compute facts, write, check, publish; Gemini never invents a figure.
  Why: the same rule as grading, applied to writing.
- **Post template** (owner, 2026-11-10). Status: built as a document (#55, `docs/content/POST_TEMPLATE.md`).
  A TL;DR of 3-5 bullets first, 400-600 words, descriptive subheads, one key-number callout, a hero image and 2-3 inline images, one call to action.
  Why: a reader decides in five seconds and gets the whole point in under three minutes.
- **Pace: 1-2 posts a week**, the best-scoring draft each time, the owner's favourites from the first batch first (owner, 2026-11-10). Status: planned.
  Why: fewer posts with unique data rank better and look less like spam than many thin ones.
- **Every post is labelled** "written with AI from PortfolioRank data", with the data linked (owner, 2026-11-10). Status: planned; the disclosure is drafted in [legal/ai-content.md](legal/ai-content.md).
  Why: honesty with readers and with search engines about how the posts are made.
- **Images pipeline** (owner, 2026-11-10). Status: planned.
  Sources in order of preference: charts made by code, our own screenshots (naming rule applies), Unsplash and Pexels stock with automatic credit, and Cloudflare Workers AI illustrations on the free allowance; Gemini's paid image model is not used.
  Gemini proposes each image slot with alt text, code makes or fetches 2-3 candidates, Gemini picks the best for fit and accuracy, one retry, else a chart or no image.
  Why: charts and screenshots are free and exact; the review catches wrong charts and odd generated images without a human.
- **Model watch** (agent, 2026-11-10). Status: planned.
  A free daily check of Google's model list and changelog; changes go to the owner and the admin page, and a new model can run as an experiment.
  Why: when Google retires 3.5 Flash-Lite, every grade and comparison method needs warning and a re-run plan.

## Newsletter and email

- **A weekly newsletter** (owner, 2026-11-10). Status: planned.
  Sign-up on every post and on the site, confirm by email (double opt-in), one-click unsubscribe, a weekly digest of new posts, the top 5 and the biggest climber.
  Why: a way to bring readers back that doesn't depend on search or social.
- **All email goes through one shared gate with hard caps** (owner, 2026-11-10). Status: planned.
  Newsletter, queued grade reports and owner updates all pass one module that counts every send and stops at a daily cap.
  Why: the same hard-cap pattern as Wren's demo budget; no bug or abuse can send unbounded email.
- **Email provider: undecided** between Amazon SES and Cloudflare Email Service (owner, 2026-11-10). Status: open question.
  The grader plan and cost page assumed SES (about $0.10 per 1,000 emails); Cloudflare Email Service is already set up for `n8builds.dev` for Wren.
- **Queue and email past the daily cap** (owner, 2026-11-10). Status: planned.
  Every "grade my portfolio" request goes through a queue; with quota left it runs at once and the person watches, past the cap it waits and the report is emailed when ready (on the Batch API at half price once billing is on).
  Why: an email costs about 1/50 of a grade, so the queue lets free quota and Batch carry the load instead of refusing people.

## Superseded

- **AI votes in the same ELO pool as people's, with equal weight** (2026-06): replaced by the three views and OpenSkill (2026-11-10). Today's code still works this way until the ranking lane lands.
- **Grades from 3.5 only, waiting for tomorrow instead of using 3.1** (grading audit recommendation, 2026-11-10): replaced the same day by catch-up mode with conditional re-grades.
- **Blog drafts automatic, publishing one click by the owner** (ranking design suggestion, 2026-11-10): replaced the same day by fully automatic, fail-closed publishing.
