# Decisions

The owner's standing decisions and the technical choices made with them.
This file is the single source of truth: read it before changing product, grading, ranking, content or email, and add every new decision here, with its date, in the same change.
The order of work lives in [ROADMAP.md](ROADMAP.md); how the running system works lives in [AUTOMATION.md](../AUTOMATION.md) and [GRADING_CRITERIA.md](../GRADING_CRITERIA.md).

Each entry says who decided ("owner" for Nathan, "agent" for a technical choice made under his rules), the date, one line of why, and a status:

- **built**: merged on `main` (with the PR number).
- **building**: a lane or PR is open.
- **planned**: decided, not started.

## Gemini

- **Grades and ranking comparisons from 3.5 Flash-Lite only, never a lower model** (owner, 2026-11-10). Status: building (#63).
  `gemini-3.5-flash-lite` makes every grade and every AI vote.
  An overloaded, timed-out or unreachable 3.5 is retried on 3.5 after 10, 30 and 60 seconds; if it is still busy, or its daily quota or grading budget is used up, the item is left for the next run, with no fallback to 3.1.
  A run that stops this way says why in its job summary; it fails only when it did nothing for a reason other than a spent budget or quota.
  `gemini-3.1-flash-lite` may only be used for explicitly labelled experiments (such as the 3.1-vs-3.5 comparison) and non-ranking analysis, and is never written into grades or ratings.
  The fallback code from #54 stays behind `GEMINI_FALLBACK` (default `off`) for those experiments; the grading and vote workflows pin it to `off`.
  Why: one consistent judge for every grade and every comparison matters more than speed; the backlog can wait a few days for 3.5's budget.
- **The key goes in the `x-goog-api-key` header, never in the URL** (agent, 2026-11-10). Status: built (#52).
  Why: newer AI Studio keys are rejected as `?key=`, which is what killed grading from late July, and a URL key leaks into logs.
- **Every grade and vote records the model that answered** (owner, 2026-11-10). Status: built (#52).
  Why: the two models can score the same site differently, so a grade without its model can't be compared.
- **A dead key turns the run red** (agent, 2026-11-10). Status: built (#52).
  Why: grading was dead for three months while every job showed green.
- **Quotas: 500 requests a day on 3.5 and 500 on 3.1, per Google Cloud project** (owner, 2026-11-10). Status: built (#54).
  The defaults live in code; `GEMINI_DAILY_QUOTA` overrides them (a repository variable, and optionally a Worker variable).
  Why: these are the owner's free-tier numbers; Google counts per project, not per key, so a second key in the same project adds nothing.
- **Pacing and a request log** (agent, 2026-11-10). Status: built (#54).
  One limiter per run spaces every request (8 a minute by default), every request is a row in `gemini_requests`, and each run's summary shows today's totals against the quotas with a warning from 80%.
  Why: real numbers instead of estimates, and one place to see when a quota is about to run out.
- **No catch-up mode; the backlog is graded on 3.5's daily budget** (owner, 2026-11-10). Status: built (#63); since #69 the budget is the end-of-day run's "Grade new sites" share.
  The repository variable `GEMINI_CATCHUP` is `"false"` and the code no longer reads it; ungraded sites are worked through over the coming days, within 3.5's grading budget.
  Why: catch-up mode wrote 3.1 grades, which the "3.5 only" decision rules out.
- **Conditional re-grades of 3.1 grades on 3.5** (owner, 2026-11-10). Status: built (#54); the stop rule is planned.
  Every existing 3.1 grade is queued for a 3.5 re-grade from spare 3.5 budget, and the old grade moves to `rubric_history`, so each re-grade is a free 3.1-vs-3.5 pair for the Sunday comparison report.
  No new 3.1 grades are made, so the queue only holds grades from before the "3.5 only" decision.
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
  Why: about 2,000 grades (4 to 5 days of 3.5's grading budget) so every listed site is on the same rubric; it waits until the ungraded backlog is done.

## Ranking

- **OpenSkill ratings, seeded from the grade** (owner asked the agent to pick, 2026-11-10). Status: planned.
  Each site starts at a rating from its tier, nudged by its scores, and comparisons move it from there; the system tracks how sure it is about each site.
  Why: OpenSkill, like Glicko-2, tracks certainty and is permissively licensed, and unlike Glicko-2 it rates a whole ordered group at once, which is what batched comparisons produce; plain ELO treats every site the same.
- **Three leaderboard views, merged by default** (owner, 2026-11-10). Status: planned.
  Merged (AI and people) is the default, with AI-only and People-only tabs; big gaps between AI and people are flagged and become reports.
  Why: about 85% of today's leaderboard votes are AI votes counted like people's; separate views let the AI compare all day without drowning people out.
- **AI comparisons use 3.5 only** (owner, 2026-11-10). Status: building (#63) for today's daily votes; planned for the new ranking.
  Why: the AI view needs one consistent judge; 3.1 is for labelled experiments only (see "Grades and ranking comparisons from 3.5 Flash-Lite only").
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

- **People first, AI with the leftovers** (owner, 2026-11-10). Status: building (#69).
  People's "grade my portfolio" and re-grade requests run as they arrive, with the whole day's 3.5 quota available to them minus an evening reserve of about 25.
  Background AI runs once a night at the end of the quota day, on whatever is left, in priority order with caps: new sites, changed sites, AI ranking comparisons (when `RANKING_V2` is on), content, then re-grades and experiments.
  3.5 only (`GEMINI_FALLBACK` off), at today's pace.
  Why: the free quota resets at midnight Pacific and unused requests are lost, so people never wait behind background work and the background never wastes a day.
  This replaces the fixed daily split and its flex rules (see Superseded).
- **The quota day is the Pacific day** (agent, 2026-11-10). Status: building (#69).
  Every count of "today" (the accountant, job summaries, comparisons per day) runs midnight to midnight in America/Los_Angeles, 23 or 25 hours on the DST days.
  Why: that is when Google resets the free quota; counting UTC days split one quota day in two.
- **One budget accountant** (owner, 2026-11-10). Status: building (#69).
  `pipeline/budget.mjs` reads today's use per job and model from `gemini_requests`; a job asks "how many can I spend now?" and gets min(its cap, quota left minus the reserve).
  The reserve grows with demand: max(25, 2 x people's requests in the last hour).
  Why: one key serves every job, so only one ledger can keep them from starving each other or people.
- **The end-of-day run starts from Cloudflare, not GitHub's schedule** (owner, 2026-11-10). Status: building (#69).
  A Cron Trigger on the Worker starts a Workflow at 20:30 Pacific (two UTC crons, one for each DST offset; only the one at 20:30 local starts it).
  The free checks first (feed, capture of new sites, a re-capture of the oldest to find redesigns, page evidence, fingerprint changes) on GitHub Actions, started with a `workflow_dispatch` and waited for until 21:15; then the AI stages on Cloudflare until a hard stop at 23:30.
  GitHub's schedules for those workflows stay as a fallback that skips when Cloudflare started them.
  Why: GitHub starts scheduled jobs 4 to 10 hours late; capture and the health check need a browser, so they stay on Actions, while AI-only work runs on Cloudflare Workflows, durable and paced.
- **The end-of-day run never takes from people and never retries without end** (owner, 2026-11-10). Status: building (#69).
  Batches of 20 requests, with the quota and people's demand re-read before each; people grading in the last 10 minutes pause it.
  Each stage has a request cap and a wall-clock cap; at most 20 retries a night; 5 failures in a row stop a stage; an item is tried once a night and parked after failing 3 nights in a row; a failed or stopped run never restarts the same night.
  The summary records the estimate at the start and the actual at the end.
  Why: an unattended job must have bounded cost and bounded damage.
- **Quota exhausted is "deferred, not failed" everywhere** (owner, 2026-11-10). Status: building (#69).
  `compare.mjs` now exits 0 when 3.5's quota is spent, like `judge.mjs` since #63.
- **Re-grades on request, with a cooldown** (owner, 2026-11-10). Status: the rule is building (#69, `regradeAllowed`); the request flow comes with "grade my portfolio".
  Once every 7 days, sooner when the page fingerprint changed after the last grade.
- **People's requests wait for 3.5, never 3.1** (owner, 2026-11-10). Status: building (#69, `pipeline/people.mjs`); used once "grade my portfolio" ships.
  A busy 3.5 is retried as usual, then the request is queued and finished by an hourly cron when 3.5 is available, and the person is emailed when it is done.
- **The ELO-era AI votes stop running on a schedule** (agent, 2026-11-10, following "comparisons when `RANKING_V2` is on"). Status: building (#69).
  `judge-vote.yml` is manual only; until `RANKING_V2` is on, no AI votes are added to the ELO board.
  Why: the owner's order runs AI comparisons in the background only as ranking v2; keeping the old 30 votes would need a second runner outside the budget.
  Owner: say if they should continue meanwhile.
- **Owner alerts repeat until resolved** (owner, 2026-11-10). Status: building (#69); email off until a provider is chosen.
  Quota used up before the end-of-day run, a stage stopped by its circuit breaker, parked items, and traction past configurable levels ("PortfolioRank is doing well").
  One email per condition per day, every day, until it clears.
- **Admin quota data, admin only** (owner, 2026-11-10). Status: building (#69).
  `GET /api/admin/quota`, for the GitHub login in `ADMIN_GITHUB_LOGIN`: today's and the last 30 days' use by job and model, the allowances now, the runs, parked items, alerts.
  The redesign's admin page will read it.
- **A paid key comes later, with a hard cap** (owner, 2026-11-10). Status: planned.
  See Gemini above.
- **Real-browser work stays on GitHub Actions** (owner, 2026-11-10). Status: built for the nightly checks (#69); planned for "grade my portfolio".
  Screenshots, rendered text and health checks run on Actions (free for a public repository), started on time by the Cloudflare cron or on demand by the Worker with a `workflow_dispatch`.
  Live "grade my portfolio" shows the free fact checks at once (a plain fetch from the Worker) and starts an Actions job for the screenshot and the AI grade, then notifies.
  Cloudflare Browser Rendering is parked as a later upgrade.
  The database moves from Turso to Cloudflare D1 in a later lane, so new code reaches the database only through `lib/db.ts` and the pipeline's `db` parameter.
- **Kill switches** (agent, 2026-11-10). Status: planned.
  One setting each pauses grading, comparisons, publishing and email; today `GEMINI_BUDGET` caps can be set to 0 per stage.

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
- **No postal address in emails for now** (owner, 2026-11-10). Status: decided.
  The newsletter is editorial and PortfolioRank sells nothing, so it isn't commercial email under CAN-SPAM; if ads, sponsors or paid features ever arrive, a PO box or virtual mailbox goes in the footer.
  Why: no address needed today, and none to get spammed at.
- **Queue and email past the daily cap** (owner, 2026-11-10). Status: planned.
  Every "grade my portfolio" request goes through a queue; with quota left it runs at once and the person watches, past the cap it waits and the report is emailed when ready (on the Batch API at half price once billing is on).
  Why: an email costs about 1/50 of a grade, so the queue lets free quota and Batch carry the load instead of refusing people.

## Superseded

- **Daily split on 3.5: 100 / 100 / 100 / 100 plus buffer** (owner, 2026-11-10; never built): 100 each for people's grades, one-on-one ranking, batched ranking and content, then 50 for the backlog and 50 for retries.
  Replaced the same day by "People first, AI with the leftovers".
- **Shares flex at 18:00 UTC, with a priority order** (agent, 2026-11-10; never built): replaced by the end-of-day run on what is left after people.
- **A grading budget of 400 a day (`GEMINI_GRADING_BUDGET`)** (#54): replaced by the accountant's per-stage caps (#69).

- **AI votes in the same ELO pool as people's, with equal weight** (2026-06): replaced by the three views and OpenSkill (2026-11-10). Today's code still works this way until the ranking lane lands.
- **Grades from 3.5 only, waiting for tomorrow instead of using 3.1** (grading audit recommendation, 2026-11-10): replaced the same day by catch-up mode with conditional re-grades, then adopted later that day as the owner's "3.5 only" decision.
- **3.5 Flash-Lite first, 3.1 Flash-Lite as the backup** (owner, 2026-11-10; built in #52, #54): a call still failing after its retries, or a spent 3.5 quota, went to 3.1.
  Replaced on 2026-11-10 by "Grades and ranking comparisons from 3.5 Flash-Lite only"; the fallback stays in the code behind `GEMINI_FALLBACK` for experiments.
- **Catch-up mode** (owner, 2026-11-10; built in #54): grading spent 3.5's budget and then 3.1's, about 850 grades a day.
  Replaced on 2026-11-10 by "No catch-up mode; the backlog is graded on 3.5's daily budget".
- **Blog drafts automatic, publishing one click by the owner** (ranking design suggestion, 2026-11-10): replaced the same day by fully automatic, fail-closed publishing.
