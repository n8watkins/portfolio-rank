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
  Free quota first; billing with a Google budget alert and an in-app daily cap only when grades outgrow it.
  Revisit at the public launch of the grader or when traffic grows (see "Free tier everywhere").
  Why: a grade costs about $0.001 on rubric v2 at paid rates, so paid is cheap, but free covers today's volume.
- **Free tier everywhere: no region blocking, a clear notice and your own key** (owner, 2026-11-10). Status: the own-key option's back end is building (#81, "Grade my portfolio" below); the notice comes with the redesign's grade pages.
  PortfolioRank stays on Gemini's free tier and blocks no region.
  Google's terms allow only Paid Services when an API client is offered to people in the EEA, Switzerland or the UK, and ask free-tier users not to send personal information ([ASSUMPTIONS.md](ASSUMPTIONS.md) summary item 1, A9); the owner accepts that risk for now.
  In its place: wherever a visitor starts AI work (the future grader and re-grade requests), a clear notice that the AI runs on Google Gemini's free tier and that people shouldn't submit private details, and a bring-your-own-key option so a visitor can grade on their own Gemini key.
  Browsing, leaderboards, face-off and guess-the-rank voting, polls, the blog, profiles and the background grading of listed sites need none of this.
  Revisit at the public launch or when traffic grows; switching to paid billing removes both issues.
  Why: the owner prefers one open site for everyone over geo-blocking, and only public portfolio content reaches the model.
- **Public by design** (owner, 2026-11-10). Status: built for page text (#72); the wording goes on the privacy page ([legal/privacy.md](legal/privacy.md), draft).
  The wording:

  > Public by design.
  > PortfolioRank only works with portfolios their owners published for the public to see.
  > Before any page text reaches the AI, we remove email addresses and phone numbers.
  > Names, public photos and the portfolio's own content stay, because that's what a portfolio is for.
  > Nothing is blocked by region.

- **Contact details never reach Gemini** (owner, 2026-11-10). Status: built (#72).
  Before any page text goes into a prompt (rubric v2 grades, one-on-one and batched comparisons), email addresses, phone numbers and mailto:/tel: links, spelled-out addresses included ("jane at example dot com"), become `[email]` and `[phone]` (`pipeline/redact.mjs`).
  The contact fact check still works, since code measures it from the page's links, and the grader is told what the tokens mean.
  Why: the free tier's terms ask not to send personal information, and the model needs to know a contact path exists, not what it is.
- **A cut-off answer is a failed answer** (agent, 2026-11-10). Status: built (#72).
  Every Gemini response's `finishReason` is logged in `gemini_requests`; an answer that did not finish with `STOP` (`MAX_TOKENS`, `SAFETY`, a blocked prompt) is never stored as a grade or a comparison and is not retried.
  The answer caps leave room for thinking, which `maxOutputTokens` counts: 2,048 for a grade (was 600) and 1,024 for a comparison (was 400); only tokens produced are billed.
  Why: a truncated JSON answer must never become a grade, and 3.x models think a little even at `minimal` ([MODEL-LIMITS.md](MODEL-LIMITS.md)).
- **Error bodies are kept** (agent, 2026-11-10). Status: built (#72).
  The first 300 characters of every Gemini error body (429s name the limit that was hit) go to `gemini_requests.detail`, on one line, with anything key-like removed.
  Why: test G3 in ASSUMPTIONS.md; the classifier can later match Google's quota id instead of a regex.

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
- **Roles are read from the page text when a portfolio is graded** (owner, 2026-11-10). Status: building (#81).
  Every grade (the nightly ones and "grade my portfolio") also returns up to three roles the page claims, cleaned by code; they are labels, never scored, so the rubric version stays 2.
  Why: the page text is already in the grading request, so the roles a site claims come at no extra Gemini request.
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
- **The quota day is the Pacific day** (agent, 2026-11-10). Status: built (#69; one helper, `pipeline/quota-day.mjs`, since #72).
  Every count of "today" (the accountant, job summaries, comparisons per day, the comparison seed, owner alerts) runs midnight to midnight in America/Los_Angeles, 23 or 25 hours on the DST days.
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
- **Re-grades on request, with a cooldown** (owner, 2026-11-10). Status: the rule is building (#69, `regradeAllowed`); the request flow is building (#81, "Grade my portfolio" below).
  Once every 7 days, sooner when the page fingerprint changed after the last grade.
- **People's requests wait for 3.5, never 3.1** (owner, 2026-11-10). Status: building (#69, `pipeline/people.mjs`); "grade my portfolio" uses it (#81).
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
- **Real-browser work stays on GitHub Actions** (owner, 2026-11-10). Status: built for the nightly checks (#69); building for "grade my portfolio" (#81, `grade.yml`).
  Screenshots, rendered text and health checks run on Actions (free for a public repository), started on time by the Cloudflare cron or on demand by the Worker with a `workflow_dispatch`.
  Live "grade my portfolio" shows the free fact checks at once (a plain fetch from the Worker) and starts an Actions job for the screenshot and the AI grade, then notifies.
  Cloudflare Browser Rendering is parked as a later upgrade.
  PortfolioRank stays on Turso; new code reaches the database only through `lib/db.ts` and the pipeline's `db` parameter, never its own client, so a later switch stays easy.
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
- **The shell links only to pages that exist** (agent, 2026-11-10). Status: building (Wave B step 1).
  Every link in the header, footer, phone tab bar and More sheet goes through `ROUTES` in `lib/nav.ts`; a page that is not built yet is `null` there and its links are hidden, and a page lane ships its page by setting its route.
  Until then Play points at `/rank`, Browse at the grid on home, About at `/how`, and "Grade yours" (the highlighted header action and the phone tab bar's Grade tab) stays hidden until the grade pages ship.
  Why: the shell can go live before the page lanes without a single link to a 404.
- **The maker's mark beside the logo** (owner, 2026-11-10). Status: building (Wave B step 1).
  The n8 icon always comes with "n8builds.dev" (no "by"), linking to n8builds.dev: beside the logo in the header (only the icon when the header is too narrow for the name) and in the footer's brand area; the footer's last line reads "Built by n8builds.dev."
- **Light-theme amber and green text darkened a step for contrast** (agent, 2026-11-10). Status: building (Wave B step 1).
  `--color-accent` is `#9a5d06` and `--color-up` `#157a3a` in the light theme (the preview had `#a16207` and `#15803d`, 4.3-4.4:1 on the raised surface); the amber fill is unchanged, and `tests/tokens.test.mjs` checks every text token reaches 4.5:1 on every surface in both themes.
  Why: WCAG AA for small text, at a difference the eye can't see.
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

## Grade my portfolio

How it works is in [AUTOMATION.md](../AUTOMATION.md#grade-my-portfolio); the redesign preview (`preview/redesign`) shows the screens.

- **Built behind a switch, off until the redesign's UI ships** (owner, 2026-11-10). Status: building (#81).
  The back end (the API under `/api/grade`, the capture workflow, the emails and the five-minute cron) is merged with the Worker variable `GRADER_ENABLED` set to `"false"`: every route answers 404 and the cron reads nothing.
  Why: the API and its guardrails can be reviewed, tested and deployed before anyone can reach them.
- **No account needed; a link plus an email gets a one-time link** (owner, 2026-11-10). Status: building (#81).
  The browser that asks for a grade owns its report (a signed cookie); an emailed link is signed, expires in 7 days and works once, and opening it makes that browser the owner too.
  The owner may delete the report; anyone with the link may read it.
  Why: no sign-up between a visitor and their grade, and an inbox is proof enough to own a report.
- **Reports are unlisted and shareable by link** (owner, 2026-11-10; the details are the agent's). Status: building (#81).
  The id is 128 random bits and the only way in; every answer says noindex and is never stored in a shared cache; the page text, the visitor and the network are never returned; a re-grade request learns an earlier report's id only in the browser that owns it; reports and their screenshots are deleted after 180 days.
  Why: a grade is about someone's work, so it reaches only the people they share it with.
- **The free checks at once from the Worker, the screenshot and grade on GitHub Actions, dispatched on demand** (owner, 2026-11-10, accepting the Actions terms grey area in [ASSUMPTIONS.md](ASSUMPTIONS.md) section F). Status: building (#81).
  A plain fetch measures the facts code can check while the visitor waits; `grade.yml` then captures the page and grades it.
  The dispatch has no inputs and the run's log only counts, because the repository is public and a job id is a report's key (agent).
  Why: free, and the capture code already runs there; Browser Rendering stays the switch if GitHub objects or volume grows.
- **The visitor's browser can't be turned against our network** (agent, 2026-11-10). Status: building (#81).
  Addresses are http or https on ports 80 and 443 with a public host name; on the runner every Chromium request goes through a local proxy that resolves each host itself, refuses private, loopback, link-local and metadata addresses and connects to the address it checked; our own fetches follow redirects by hand and check every hop.
  Why: a visitor picks the address and the page picks everything it loads; a runner has a metadata service and local ports like any cloud machine.
- **Daily caps per visitor, per network and site-wide, reserved together** (owner asked for the three caps, 2026-11-10; the numbers are the agent's). Status: building (#81).
  3 grades a day per visitor (account or signed browser cookie), 6 per network (an IPv4 address or an IPv6 /64), 100 site-wide, per Pacific day, taken in one database transaction or not at all; attempts are rate limited before any work (20 an hour per visitor, 60 per network), and Turnstile checks every request once its secret is set.
  Past the site-wide share a request waits for a later day and is emailed, as decided in "Queue and email past the daily cap"; at most 200 wait at once.
  `GRADER_CAPS` changes the numbers.
  Why: the free quota is about 500 requests a day and people come first, so 100 grades leave room for re-tries and the background while no one person or network can take the day.
- **Re-grade cooldown per address; grading a listed site reuses nothing** (owner, 2026-11-10). Status: building (#81).
  An address is graded once every 7 days, sooner when the free checks find the page's structure changed, and never twice at once; a listed site is always captured and graded fresh, never copied from the leaderboard's grade.
  Why: the leaderboard's grade may be old, and a visitor asking for a grade wants today's page judged.
- **Own key: in the request body once, never stored or logged** (owner decided the option, 2026-11-10; the handling is the agent's). Status: building (#81).
  The key stays in the visitor's browser and reaches the Worker only in the JSON body of the request that uses it, never a URL or a request header, because Workers Logs records request headers.
  The Worker checks it with a free metadata call at the start, then grades on it once the capture has landed, with `gemini-3.5-flash-lite` and the same rubric, marking the grade as own-key.
  Its requests are not in `gemini_requests`: they spend the visitor's quota, so the budget accountant must not count them.
  The key never goes to GitHub.
  Why: the key is the visitor's money; holding it even briefly would be a liability, and an own-key grade must be comparable with every other.
- **The grade pages say only what the back end does** (agent, 2026-11-10). Status: building (Wave B, `feat/redesign-grade`).
  The approved report's "Email me updates" became "Email me the report", the existing one-time link, because nothing sends rank or re-grade updates yet; "Add me to the leaderboard" opens the community list's submission form until question 8 in ROADMAP.md is decided; "Expected" on a fix is the places gained among graded portfolios with that score one point higher (the tier kept), or the checks score with that check passing, and nothing when neither moves.
  Why: a report about someone's work must not promise what never arrives.
- **"Grade yours" follows GRADER_ENABLED at build time** (agent, 2026-11-10). Status: building (Wave B).
  next.config.ts reads the variable (or wrangler.jsonc's value for the Worker being built) into `ROUTES.grade`, so prerendered pages and the browser agree; turning grading on in wrangler.jsonc ships with a deploy, which rebuilds.
  Why: the shell is on prerendered pages, and a link that differs between server and browser breaks hydration.
- **The report is built by code from the grade** (agent, 2026-11-10). Status: building (#81).
  Strengths, the three fixes to make first, the estimated rank among the listed graded portfolios (on the level the leaderboard seeds from the grade), similar portfolios and portfolios doing the weakest axes better are all computed from stored grades when the grade is written, with no extra Gemini request; the comparison pool is cached for an hour.
  Why: "facts from code, words from Gemini", and no report view scans the portfolios table.

## Polls

- **Automated polls people vote on** (owner, 2026-11-10). Status: back end built (tables, read and vote API, nightly generation; AUTOMATION.md "Polls"); the poll card and the polls page come with the redesign.
  A few polls are written each night from PortfolioRank's data in the content budget (for example "Which hero section is better?" with two real screenshots, "Should a portfolio show a resume?"); voting uses no AI, one vote per person through sign-in or a cookie plus Turnstile.
  A poll card sits on home and a polls page shows the series of past polls and their results.
  Results feed blog posts, and with enough votes become one more signal in the AI vs people comparisons.
  Why: cheap, engaging, and it produces people's opinions to compare with the AI's.
- **One poll a week, Monday to Monday Pacific; Gemini at most 2 requests a week** (agent, 2026-11-10). Status: built.
  A night writes 4 candidates in one 3.5 Flash-Lite request only when fewer than 2 future weeks have a poll; code validates them and picks the screenshots (sites graded S or A only), and when nothing is ready, code makes the week's poll without Gemini.
  Why: a weekly poll gathers enough votes to mean something, and the content budget stays almost untouched.
- **Results are totals only; one vote per account and per browser** (agent, 2026-11-10). Status: built.
  Vote rows exist only for the one-vote rule and are deleted 30 days after a poll closes; rate limits key on the browser and a hashed IP; Turnstile is required on the deployed Workers (no secret means votes are refused); only local runs skip it.
  Why: the people who vote never asked to be on record, and a cookie alone is easy to clear.

## Content engine

The design is [CONTENT-ENGINE.md](CONTENT-ENGINE.md).

- **The eight content engine decisions** (owner, 2026-11-10: all the recommended options). Status: built in the back end, off (this PR's lane; the blog pages come with the redesign).
  1. A separate PortfolioRank Tavily key, `portfolio-rank/TAVILY_API_KEY`, so Wren's allowance and PortfolioRank's can't starve each other.
  2. Posts publish Tuesday and Thursday at 08:00 Pacific (drafted Monday and Wednesday nights); the owner's summary comes on Sunday.
  3. Stock photos with people are allowed, but never as the hero and never next to a named developer.
  4. Posts live in the database as Markdown, rendered with no raw HTML; no MDX.
  5. A short AI line under the title ("Written with AI from PortfolioRank data.") and the full note with the data link at the end.
  6. The weekly newsletter still sends in a week with no post, with the top 5 and the biggest climber.
  7. The owner switches `CONTENT_MODE` from `dry-run` to `publish` by hand; it never switches itself.
  8. `gemini-3.5-flash-lite` for every content request; trends are counted by code; reading portfolio text with 3.1 can come later as a labelled experiment.
     Changed by the owner on 2026-11-12: a content request falls back to the free `gemini-3.1-flash-lite` when 3.5 is busy, and a draft Google can't answer waits 15 to 30 minutes and tries again instead of failing ([CONTENT-ENGINE.md](CONTENT-ENGINE.md#write-a-draft-now)); grades and votes stay on 3.5 alone.
- **Tavily is capped at 200 credits a month** (owner, 2026-11-10). Status: built.
  PortfolioRank and Wren share one free Tavily account (1,000 credits a month, 100 requests a minute across both keys); PortfolioRank gets 200 (`TAVILY_MONTHLY_CREDITS`), Wren 750, and 50 stay spare.
  A counter in the database (`tavily_credits`, schema version 8) is reserved before each search and released if Tavily errors; at the cap outside claims are cut, as when the key is missing, and `GET /api/admin/quota` shows the month's use.
  Why: one account, two apps, and a search that is blocked here costs nothing, while a claim cut costs only a draft's outside claim.
  The cost breakdown is in [COSTS.md](COSTS.md#tavily-credits).
  Why: the recommendations kept the engine small, positive and fail-closed, which is what the owner asked for.
- **Content engine back end** (agent, 2026-11-10, under the decisions above). Status: built, `CONTENT_MODE` "off".
  Tables `posts` and `content_runs`, fact builders with code-drawn charts, the writer with placeholders, the code checks, outside claims through Tavily, the topic filter, images (charts, our screenshots, Unsplash and Pexels, Workers AI with Gemini's review), the caps, the kill switch, the weekly summary and `GET /api/admin/content` for reviewing drafts before the blog exists ([CONTENT-ENGINE.md](CONTENT-ENGINE.md#what-is-built)).
  Two extra fact builders read today's grades and capture measurements ("what the best-graded portfolios share", "dark mode, motion and page weight"), because "3.1 vs 3.5" needs re-grade pairs and "Leaderboard movement" needs ranking v2, and production has neither yet.
  Tavily, Unsplash and Pexels keys are optional: without Tavily every outside claim is cut, without a stock key stock slots fall back to a chart or are dropped.
  Why: a dry run needs something to write about today, and every source the owner hasn't set up yet fails closed.

- **The owner approves every post before it publishes** (owner, 2026-11-11). Status: building (the blog pages and the review flow, preview PR).
  The engine writes drafts (`CONTENT_MODE` "dry-run" is the draft mode); the owner reads each one on `/admin/blog/[id]`, as readers would see it plus its checks, fact sheet, claims and image sources, and publishes or rejects it.
  Publish goes live at the draft's scheduled 08:00 Pacific while that is still ahead, else at once, and keeps the cap of 2 posts in any 7 days in the same write; Reject and Unpublish take an optional note; every decision is stored on the post (`checks.owner`) with who and when.
  A draft that fails its checks after two rounds is still dropped and never reaches the queue; the "publish" mode (automatic publishing) stays in the code, unused.
  Draft mode is on in production since 2026-11-11 (owner); staging stays "off".
  Why: the posts appear in the owner's name, and a person reading each one is the strongest check while the engine is new.
- **Fully automatic and fail-closed** (owner, 2026-11-10). Status: the review part is superseded by the decision above (2026-11-11); failing closed still holds.
  A draft that fails a check is revised automatically, and if it still fails after two rounds it is dropped, never published and never queued for the owner.
  Every number must match what code computed, links must load, quotes and sources can't be invented, and a second Gemini pass reviews tone and claims.
  The owner gets a weekly summary, an admin page and kill switches.
  Why: failing closed means the cost of a bad draft is a missing post, not a wrong one in his name.
- **The blog pages** (agent, 2026-11-11, under the decisions above). Status: building (preview PR).
  `/blog` (newest post large, then a grid, tag chips), `/blog/tag/[tag]`, `/blog/[slug]` (cover, TL;DR, inline images with credits, numbered sources, the portfolios a post names linked to their pages, the AI note, share links, JSON-LD `BlogPosting`, a share image per post), `/blog/rss.xml`, sitemap entries and `/about-posts`.
  Pages are ISR with a 5-minute revalidate, like `/top`: anonymous visitors are served from the cache, and a post shows up within 5 minutes of its publish time, whether the owner published it or its scheduled time came.
  On-demand revalidation would need an OpenNext tag cache (none is configured, and a scheduled 08:00 publish has no request to trigger it), so time-based revalidation is the simpler, complete answer.
  Images are served by `/blog/media/<post id>/<slot>` from the post's own row (never a key from the address): public and cached for a day once the post is live, admin-only before.
  The header, footer and phone More sheet show their Blog link only once a post is published (owner, 2026-11-11), from `GET /api/blog/live` (edge-cached 5 minutes); `/blog` itself is always reachable and shows an empty state until then.
  Why: the redesign's blog, in the same shell and tokens as home, `/top` and `/grading`.
- **Positive by design** (owner, 2026-11-10, security review). Status: planned.
  Posts are about what the best developers are doing and how to fit the job market; topics and news are limited to careers, hiring and portfolios, and anything hostile or off-topic is skipped.
- **Claims checked before publishing, not purged after** (owner, 2026-11-10, security review). Status: planned.
  Numbers from our data are checked by code, outside claims are checked with a Tavily search, and a claim that can't be checked is cut; there is no automatic unpublishing.
- **Only the essential gates** (owner, 2026-11-10, security review: "don't overbuild"). Status: planned.
  Facts from code, outside claims searched, a topic filter, copyright-safe images, caps and a kill switch, and one week of private dry run before the first post.
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
- **Images pipeline** (owner, 2026-11-10). Status: superseded the same day by the image library decisions below (no Unsplash, no candidate rounds, no retry).
  Sources in order of preference: charts made by code, our own screenshots (naming rule applies), Unsplash and Pexels stock with automatic credit, and Cloudflare Workers AI illustrations on the free allowance; Gemini's paid image model is not used.
  Gemini proposes each image slot with alt text, code makes or fetches 2-3 candidates, Gemini picks the best for fit and accuracy, one retry, else a chart or no image.
  Why: charts and screenshots are free and exact; the review catches wrong charts and odd generated images without a human.
- **Never pay for images: at most 40 AI images a day** (owner, 2026-11-10, tightened twice the same day). Status: built (#94).
  Every image comes from free daily allowances only.
  The limit is in images, so it is obvious: at most 40 AI images a UTC day (`MAX_AI_IMAGES_PER_DAY`) and at most 2 in any rolling hour, counted per image, for the library and the posts together.
  Owner, 2026-11-11: "40 a day only": the app's hourly cap is gone (the rolling hour counts against the same 40, so it never stops a call first) so "Make now" can make a batch at once; the AI Gateway's 40 per 3,600 seconds is the backstop, and the 40 a day and 2,500 neurons stay.
  Every Workers AI call goes through the `portfoliorank-ai` AI Gateway (#95: 2 requests an hour, sliding, and a $1 a month Workers AI spend limit); its 429 means stop, no retry, try next hour.
  Behind it, a neuron guard: at most 2,500 neurons a UTC day (`AI_NEURON_CEILING`; 40 Schnell images are about 2,320).
  Both settings can be lowered, never raised: a value above 40 or 2,500 (or not a whole number) is rejected and fails closed, so no Workers AI call is made until it is fixed.
  Before every call, one image and its estimated neurons are reserved in one statement; a failed reservation means no call, nothing is retried, and a reservation is never given back.
  Estimates from the pricing page, partial tiles rounded up: Flux Schnell 58 an image, Lucid Origin 1,512 (768 x 432, 20 steps), Flux 2 Dev 2,400 (1024 x 576, 16 steps; its native 1280 x 720 would be 4,500, past the ceiling).
  "AI images today: N of 40" shows on `/admin/images` and in `GET /api/admin/quota`.
  Why: the account is on Workers Paid, which bills neurons past the free allowance automatically; a count of images is easy to read and to check.
- **Account-wide Workers AI slices with a strict buffer** (owner, 2026-11-10). Status: built (#94) for PortfolioRank's slice.
  The account must never pass the free 10,000 neurons a UTC day: PortfolioRank images at most 2,500 (the 40-image limit above), everything else 1,000, and a 6,500 buffer never used ([COSTS.md](COSTS.md#workers-ai)).
  Demo-kit uses no Workers AI: its voice and render run locally.
  Why: each app guards only its own counter, so the slices plus an unused buffer keep the account's total under the free allowance even when one app misjudges its use.
- **Schnell for everything; Flux 2 Dev later, optional** (owner, 2026-11-10). Status: built (#94).
  Flux Schnell makes the library and the per-post images; it is square, so code center-crops to 16:9 and the Gemini check sees the cropped image and rejects any text-like marks (Schnell tends to draw fake text).
  Flux 2 Dev (native 1280 x 720, multipart input) stays configured and off: `LIBRARY_MODEL` "flux2dev" turns it on for the library.
  Lucid Origin is the backup only when Schnell errors (never after a failed check), still within the guard.
  Why: Schnell is about 58 neurons an image against 2,400 for Flux 2 Dev, so 40 images fit a day and the library fills in about 4 nights; the house style and the check keep it clean.
- **The image library** (owner, 2026-11-10). Status: built (#94).
  26 tech-first themes (the 13 of the style sample plus AI and agents, open source, remote work, interviews, side projects, accessibility, mobile, security, deployment and cloud, learning and growth, the job market, frontend frameworks, backend and data, freelancing) x 5 subjects = 130 images in the house style.
  The Worker's hourly tick makes up to 2 an hour (the AI Gateway's sliding limit), never from 20:00 to midnight Pacific so the night's post gets the hour, within the 40 AI images a day, one Gemini check each on the 16:9 crop; a pass is pending for the owner, a fail is rejected-auto and kept for the owner to see.
  The owner keeps or drops each on `/admin/images` (server-checked admin, CSRF-protected POSTs), which also lists the library with usage counts and a retire button; only approved images are used.
  Images live in the `SHOTS` bucket under `private/library/<SITE_ENV>/` and in `image_library` (schema version 9).
  The round-1 and round-2 samples were not imported (agent): the night makes the same subjects in the final style.
  Why: an approved library makes most images free and instant, and a human sees every image once before it can appear.
- **Per post: brief, then charts, library, Pexels, one fresh image, fallback** (owner, 2026-11-10). Status: built (#94).
  The writer gives each slot a brief (what it shows, mood, 5 keywords, alt text) at no extra request.
  A slot is filled by a chart or our screenshot, else the approved library image that best matches the keywords and wasn't used in the last 10 posts, else Pexels (1 search a slot, 2 a post, one Gemini check to choose), else one fresh Schnell illustration a post (one attempt, one check; on a failed check the slot falls back), else the best library match regardless of recent use or a spare chart.
  Hard limits: 1 hero and up to 3 inline images, at most 3 Gemini image checks a post, no retries anywhere.
  Every image stores its source, licence, credit and approval; generated images are captioned "AI-generated illustration".
  Pexels searches are counted per month (`pexels_searches`) and shown in `GET /api/admin/quota` next to Tavily and Gemini, with today's neurons.
  Unsplash is dropped (agent): the plan has one stock source, and Pexels is configured.
  Why: a fixed, small cost per post, a consistent look, and a bad image is never worth a retry loop.
- **Model watch is news only, weekly** (owner, 2026-11-10; weekly by the owner the same day). Status: built (#74).
  Every Monday a Worker cron reads Google's model list (`models.list`, no generate quota), the deprecations page and the release notes, compares them with last week's snapshot and reports new models, retirements with dates, Flash-Lite changes and the status of the models in use through the owner alerts and the admin quota API ([AUTOMATION.md](../AUTOMATION.md#model-watch)).
  It never changes a setting: a new model runs as an experiment first, and switching the judge is a config change by the owner.
  A model in use that is deprecated, missing or within 90 days of its shutdown date raises an alert every week until resolved.
  Only Google's own sources; "what's trending" outside them is not read.
  Why: when Google retires 3.5 Flash-Lite, every grade and comparison method needs warning and a re-run plan.

- **Post length is 250 to 400 words, with real paragraphs** (owner, 2026-11-10: option A). Status: built.
  The template, the length check (10% slack either side) and the revision prompt say 250 to 400 words, down from 400 to 600.
  Paragraphs are 2 to 4 sentences with an opening hook and a closing takeaway; a draft where most paragraphs are one sentence fails.
  The TL;DR is exactly three bullets, each with a fact placeholder.
  Why: the owner liked the draft's content but not its length or one-sentence paragraphs.
- **Superlatives, hooks, callouts and actions are checked against the fact sheet** (owner request, 2026-11-10). Status: built.
  The fact builder computes ties (compared as a reader sees them, to one decimal) and exposes them as facts; "largest", "smallest", "most" or "only" about a tied fact fails unless the sentence says it is a tie.
  It also flags one or two notable facts (a score that is low across every tier, or the biggest outlier); the opener and first TL;DR bullet must lead with one.
  The callout must restate exactly one numeric fact with the scope its label gives, so "23% of top portfolios" for 23% of all graded portfolios fails.
  A "Try this" step links to a named positive example (an S site strong on that axis) where the naming rule allows.
  Why: each of these was a way the first draft read well and was subtly wrong.

- **Staged writer is the default (`WRITER_MODE` "staged")** (owner, 2026-11-10; built in #85, #86, #90).
  `staged` writes a post as an outline (hook, title, TL;DR, three sections with their facts; structure-checked and retried once before any section is written), two section requests and a finish request, then runs the same code checks: 4 write requests (5 after an outline retry) against 1 for `single`.
  Why: better reading quality for about 1 to 4 more Gemini requests per post.
  `single` stays available by setting `WRITER_MODE` to "single"; unset or unknown values now mean "staged".
  Earlier sample, same top-grades data: `single` wrote 211 words (too short) and `staged` 448 (too long); the staged text kept the hook and ties better.

## Games, badges and claims

The back end for all of these is built behind the `GAMES_V2` flag, off until the redesign ships ([AUTOMATION.md](../AUTOMATION.md#games-badges-claims-live-stats-and-reports-built-off)).
The owner's overall rule (2026-11-10): keep it simple, don't overbuild.

- **Guess the percentile, checked on the server** (owner, 2026-11-10). Status: building (back end).
  Quizzes of 5 portfolios: a Daily 5 that is the same for everyone each Pacific day, drawn from graded listed sites spread across the board; random quizzes; challenge links that replay the same 5.
  A hit is within 15 points; points are 100 minus 2.5 per point off, never below 20 (owner, 2026-11-10, replacing within 10 and 4 per point).
  The real percentile is never sent before the guess; results are stored per visitor or account.
  Why: a fair, shareable game that teaches people what good looks like.
- **Percentiles from the ranking views, with a grade fallback** (owner, 2026-11-10). Status: building.
  A "top X%" is the shown rank over the sites shown in that view (Merged, AI, People); before any recompute, every view uses the rating the AI grade seeds and People has none.
  Why: one source of truth with the leaderboard, and a game that works before ranking v2 is switched on.
- **The Daily 5 is stored at its first request** (agent, 2026-11-10). Status: building.
  It is drawn from the date alone, then kept, so a recompute later that day doesn't change it mid-day.
  Why: "the same for everyone" has to hold all day, not only until the nightly run.
- **About 20 badges, each one rule over a counter** (owner, 2026-11-10). Status: building.
  First vote; 10, 100 and 1,000 votes; first quiz; perfect quiz; Daily 5 three days running; 7-day streak; first grade; 10 grades; first list; a list with 10 sites; first share; agreed with the crowd 10 times; poll voter; 4 polls in a row; hidden gem; night owl; 50 portfolios visited; early supporter.
  Awarded once and kept; tied to the account; a guest's progress is kept by the signed cookie and merged at sign-in.
  Why: small, honest rewards for using the site, with no streak anxiety beyond what the badge says.
- **Badge counters are read from what the site already stores** (agent, 2026-11-10). Status: building.
  Votes, quizzes, polls, lists and likes are counted from their own tables with capped reads; only shares, grades requested and portfolios visited have counters of their own.
  "Agreed with the crowd" means a face-off vote whose winner ranks higher on the People board; night owl is midnight to 5 a.m. Pacific; early supporter is anyone active on or before `EARLY_SUPPORTER_UNTIL` (the owner sets the date).
  Why: no second copy of the vote log to drift, and an undone vote can't be farmed into a badge.
- **Save to list from games reuses the lists API** (owner, 2026-11-10). Status: decided; nothing new to build.
- **Claim your portfolio with GitHub** (owner, 2026-11-10). Status: building.
  Verified automatically when the portfolio links to `github.com/<login>` or the GitHub profile's Website is the portfolio's domain; otherwise a `portfoliorank-verify` meta tag checked by fetch, or a manual review the owner decides.
  Claimed owners can remove the portfolio, hide its grade or ask for a re-grade (the grade service's cooldown applies); every claim and action goes in an audit log.
  Why: owners get control over their own listing without emailing anyone.
- **Guards on automatic claims** (agent, 2026-11-10). Status: building.
  A GitHub link doesn't count on a site the capture found built from a known template (template footers link the template's author), nor on a page that redirected elsewhere; an account verifies at most 3 portfolios by itself, more go to review.
  Why: a template author must not be able to remove every clone of their template.
- **An owner's removal is immediate on the site, permanent through the exclusions pull request** (owner, 2026-11-10; the timing is the agent's). Status: building.
  The site hides it at once; the weekly health workflow adds it to `data/excluded.json` with reason "owner request", without the name, through its bot pull request; `/removed` counts these without details.
  Why: the owner's existing removal flow, with no wait for the person asking.
  Superseded 2026-11-11 (security review M4, owner-approved): a removal needs the meta tag or a reviewed claim, is held 24 hours with an owner alert, can be cancelled by the claimant and undone by the admin.
  Why: a link to someone's GitHub profile or repository is common on portfolios, so a link alone let collaborators remove a site for good with no one told.
- **Live stats in one cached endpoint** (owner, 2026-11-10). Status: building.
  Portfolios listed, graded, graded this week, votes today, quizzes played, % own domain, % resume link, most common role, average tier, sites changed this month, newest entry, community list contributors and the repository's stars (GitHub API, cached daily).
  Why: one request for the home page's numbers, cheap on Turso (an hour's cache for the list, a day's for GitHub).
- **Report download as a print-ready page, not a PDF made on the Worker** (owner asked for a Worker PDF if feasible; agent's call, 2026-11-10). Status: building.
  A Worker PDF library either ships standard fonts only (Latin-1, so many names break) or a megabyte-scale font, and lays out the screenshot and notes worse than the browser's own "Save as PDF".
  The page is for signed-in visitors, or opened once through a link sent by email (valid 24 hours, stored only as a hash).
  Why: correct for every name and language, with no new dependency.
- **The games reuse the grader's email, Turnstile, one-time links and report lines** (agent, 2026-11-10, merging #80 with #81). Status: building.
  Report links are `report-link` one-time links in `lib/grader/links.mjs`, sent through the shared email gate (kind `report-link`), checked by `lib/turnstile.ts`, and the print page shows the grade with the grade report's own fact and judgment lines.
  Why: one mechanism for each, so caps, signing and retention can't drift between two copies.

## Newsletter and email

- **A newsletter: one email per post** (owner, 2026-11-12, replacing "a weekly newsletter" of 2026-11-10). Status: building (staging), `NEWSLETTER_ENABLED` off in production.
  Sign-up beside every post, on `/blog` and in the footer, confirm by email (double opt-in), one-click unsubscribe, and one email per published post (at most two a week) instead of a weekly digest with the top 5 and the biggest climber; the owner sees every subscriber, where they signed up and every send on `/admin/blog/newsletter` (AUTOMATION.md "Newsletter").
  It sends through the shared mailroom as its own app (`portfoliorank-news`, 150 a month), so it can't use up sign-in links; caps fail closed and never bill.
  Cloudflare Email Service is for transactional email only (its FAQ: no marketing email); this is an editorial, double opt-in list that sells nothing, the same as the n8builds.dev blog's, and pausing its mailroom app stops it without touching the other apps. If the list outgrows a few hundred emails a month or Cloudflare objects, it moves to a newsletter service.
  Why: a way to bring readers back that doesn't depend on search or social.
- **All email goes through one shared gate with hard caps** (owner, 2026-11-10). Status: building (#81, `lib/email/gate.mjs`; the games' report links use it too).
  Newsletter, queued grade reports, the games' report links and owner updates all pass one module that counts every send and stops at a daily cap.
  The caps (agent): 100 emails a day in all, 80 grade reports, 40 report links, 20 owner alerts and 3 to any one address; a refused or failed send counts too, and the log keeps a keyed hash, never the address (`EMAIL_CAPS` changes them).
  Why: the same hard-cap pattern as Wren's demo budget; no bug or abuse can send unbounded email.
- **All email goes through Cloudflare Email Service** (owner, 2026-11-10). Status: building (#81): the Worker's `send_email` binding, from `portfoliorank@n8builds.dev`; owner alerts go to `OWNER_EMAIL` once the owner sets it.
  Newsletter, queued grade reports, report links and owner alerts all send through Cloudflare Email Service, still behind the one gate with hard caps.
  Workers Paid includes 3,000 emails a month per account, shared with Wren, then $0.35 per 1,000.
  Sends to the owner's verified address are free and don't count, so owner alerts go there.
  Sending is in beta and new accounts start with a conservative daily limit, which the gate's caps must stay under.
  Amazon SES is dropped.
  Why: it is already set up on `n8builds.dev` for Wren, runs where the Worker runs, and the included sends cover today's volume.
- **No postal address in emails for now** (owner, 2026-11-10). Status: decided.
  The newsletter is editorial and PortfolioRank sells nothing, so it isn't commercial email under CAN-SPAM; if ads, sponsors or paid features ever arrive, a PO box or virtual mailbox goes in the footer.
  Why: no address needed today, and none to get spammed at.
- **Queue and email past the daily cap** (owner, 2026-11-10). Status: building (#81): a request past the day's share waits for a later day, and one Gemini 3.5 can't answer waits in the people queue; both are emailed when ready.
  Every "grade my portfolio" request goes through a queue; with quota left it runs at once and the person watches, past the cap it waits and the report is emailed when ready (on the Batch API at half price once billing is on).
  Why: an email costs about 1/50 of a grade, so the queue lets free quota and Batch carry the load instead of refusing people.

## Infrastructure

- **Stay on Turso for now; D1 is the reference alternative** (owner, 2026-11-10). Status: decided.
  Revisit when Turso's free limits get close; by then paying for a database may be the answer anyway.
  The limits, our projected use and the fixes that keep us under them are in [COSTS.md](COSTS.md); the D1 comparison and a backup restore test are in [ASSUMPTIONS.md](ASSUMPTIONS.md).
  Why: a move is real work across the app and the pipeline, and with the fixes in COSTS.md the free plan holds even the popular scenario.
- **No page view scans a whole table** (agent, 2026-11-10, from COSTS.md section C). Status: built (#72).
  Vote totals and star counts are counters kept by triggers on `votes` (`lib/schema.mjs`), so `/top` and portfolio pages read a few rows; `/top` renders at most every 5 minutes; the board API reads one page through a `(view, shown_rank)` index, with visible ranks stored by the recompute, and is cached at the edge for 5 minutes; the hidden-site set is kept per isolate for 5 minutes.
  Why: Turso Free blocks every query once 500 million rows are read in a month, and these scans were the first thing that would get there.
- **Log tables roll up and expire** (agent, 2026-11-10, from COSTS.md section C). Status: built (#72).
  After the end-of-day run: `gemini_requests` keeps 90 Pacific days raw, then one `gemini_daily` row per day, model, job and outcome; `night_runs` keeps 180 days; `comparisons` keep every row the recompute and the open method need, and only the model's free-text reason is cleared after 90 days; cleared owner alerts go after 180 days.
  Why: bounded growth, without losing anything a budget, a report or the public recompute reads.
- **The nightly backup holds every table** (agent, 2026-11-10). Status: built (#72).
  Every table and column except the transient `cache` and `matchups`, with the schema (tables, indexes, triggers), and a restore script that writes only to a new, empty database and checks every table's count ([ASSUMPTIONS.md](ASSUMPTIONS.md) section G).
  Why: Turso Free keeps one day of point-in-time restore, so this snapshot is the real backup, and it was missing `comparisons`, `likes` and `lists`.
- **The ISR queue's Durable Object stays** (agent, 2026-11-10). Status: built (#72).
  The deploy's "DOQueueHandler isn't exported" warning comes from the local proxy OpenNext starts to read the config, not from the uploaded Worker, which exports it; CI checks the bundle exports every bound class.
  Why: removing the binding would break deduplicated ISR re-renders to silence a false alarm.
- **Browser work stays on GitHub Actions; Browser Rendering is parked** (owner, 2026-11-10). Status: decided.
  Captures and health checks run on standard runners, free for this public repository; Browser Rendering is the upgrade if Actions is too slow or GitHub's Actions terms become a problem for on-demand grading ([ASSUMPTIONS.md](ASSUMPTIONS.md) section F).
  Why: free today, and the code already runs there.

- **A staging site checks every change before production** (owner approved, 2026-11-10; the flow is the agent's). Status: building.
  https://staging.portfoliorank.n8builds.dev is the same Worker code in the wrangler environment `staging`, with its own Turso database (a copy of a production backup), its own ISR cache bucket, no Cron Triggers and no Gemini key, robots noindex and a "Staging" ribbon ([DEPLOY.md](../DEPLOY.md), "Staging").
  A merge to main deploys staging, runs a read-only smoke check there, and only then deploys production, which gets the same check; pull requests don't deploy, and a branch goes to staging by running the Deploy workflow on it.
  Why: one staging site can't serve parallel PRs without them overwriting each other, while gating production on a live staging check catches what CI on a local database can't (bindings, secrets, the real data).
- **Keep staging through the redesign launch** (owner, 2026-11-10). Status: decided.
  Staging catches failures that only show up on Cloudflare while Wave B lands in several PRs.
  After launch, review whether it should still block production deploys, or delete it (Worker `portfolio-rank-staging`, Turso database `portfolio-rank-staging`, repository secrets `STAGING_TURSO_*`).
  Scheduled jobs are deliberately not duplicated on staging: they would spend the shared Gemini quota, double the Actions minutes and risk writes to shared buckets, and stale data there would raise false alarms.
  Scheduled code is covered by tests instead.
  Why: the extra safety is worth keeping while the change rate is high, and it costs nothing ([COSTS.md](COSTS.md), "Staging").
- **Require CI checks before merging** (owner, 2026-11-10). Status: approved; the owner adds "Worker build" and "E2E" to the `main` ruleset, since agents can't edit rulesets.
  Why: what merges is what the next deploy ships.
- **Email sign-in beside GitHub; email accounts' votes count fully** (owner, 2026-11-12). Status: building (branch `feat/email-signin`).
  A one-time link by email, sent through the shared mailroom inside PortfolioRank's share, with Turnstile and per-address and per-network caps; fake accounts are dealt with only if they actually show up.
  Claims, owner actions and the admin stay on GitHub, since their proof is tied to a GitHub account (AUTOMATION.md "Email sign-in").
  Why: some people who want to vote or keep lists don't use GitHub, and a link is the simplest way in without a password.

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
- **Blog drafts automatic, publishing one click by the owner** (ranking design suggestion, 2026-11-10): replaced the same day by fully automatic, fail-closed publishing, then brought back by the owner on 2026-11-11 ("The owner approves every post before it publishes").
- **Posts publish on their own with no review step** (owner, 2026-11-10, part of "Fully automatic and fail-closed"): replaced on 2026-11-11 by "The owner approves every post before it publishes".
- **Unpublish a post automatically when later data contradicts it, with a correction note** (owner, 2026-11-10, part of "Fully automatic and fail-closed"): replaced the same day by "Claims checked before publishing, not purged after"; the owner fixes or unpublishes a wrong post from the admin page.
