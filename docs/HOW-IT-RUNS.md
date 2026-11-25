# How PortfolioRank runs

This page is the short answer to "what runs, when, and in what order".
It was checked against the code on main on 2026-11-21, release v0.6.0, and the ranking chain again on 2026-11-22 (the Starting rank from code).
The long version, with every number and reason, is [AUTOMATION.md](../AUTOMATION.md).
Where the two disagree, the code wins, and this page should be fixed first.

## 1. How to read this page

Every job is named by what it does.
The file or workflow name follows in backticks, so you can find it.
Times are Pacific first, with UTC after.
Pacific time has two offsets, so a UTC time moves by an hour in summer.
Today (November) Pacific is UTC minus 8 hours.
In summer it is UTC minus 7 hours.

Every job has one of four states.

- **Running**: it is on and doing its work in production today.
- **Paused**: built and ready, but waiting on the AI budget.
  Every AI stage cap in production is 0 today (the GitHub variable `GEMINI_BUDGET`, read on 2026-11-21; the Worker copy of the same setting was read by the owner and is not visible in code).
  Raising a cap is what un-pauses these.
- **Off**: built or part built, and switched off by a setting.
  The setting is named next to it.
- **Going**: decided to be removed.
  It may still run today, and the table says so.

Where a state could not be confirmed from code, the page says "not confirmed".
Production switches come from `wrangler.jsonc` (its `vars`).
There is no staging site since 2026-11-22: changes are tried locally and in CI, then as small trials on production on the owner's word ([DEPLOY.md](../DEPLOY.md), "Trying a change").
"Per `wrangler.jsonc`" means the value is read from that file.
A Worker secret or a dashboard-only variable cannot be read from code.

## 2. A day in order

The clock belongs to Cloudflare, because GitHub starts its own scheduled jobs hours late.
Each GitHub schedule stays only as a fallback and skips itself when Cloudflare already started the job.

Times below are Pacific, with UTC in brackets, for winter.

1. **00:00 (08:00 UTC in winter, 07:00 UTC in summer)**: Gemini's free quota resets.
   Google's rule is midnight Pacific time for the requests-per-day limit, so the UTC time moves with the clocks; the code counts the day in Pacific time and never uses a fixed UTC hour.
   Per-minute limits are separate and reset on their own short windows.
   This is Google's published rule (checked 2026-11-22) and Google can change it.
   Unused requests are lost, which is why the AI work runs at the end of the day.
2. **Every 5 minutes**: the grader's tick and the newsletter tick (`worker/grader.ts`, `worker/newsletter.ts`).
   Both are Off today.
3. **Every hour at :15**: the hourly tasks in section 3 (`worker/index.ts` `scheduled()`).
   Running.
4. **Every hour at :40**: the GitHub fallback for the re-check of failing sites (`recheck.yml`).
   It skips when Cloudflare started a run in the last hour.
5. **01:00 (09:00 UTC)**: warm the speed and polish scores of listed sites, up to 400 a day (`prewarm.yml`).
   Every site Gemini graded "a portfolio" or the capture measured is included, so sites ranked from the code checks get their own Lighthouse.
   Running.
6. **04:00 (12:00 UTC)**: the GitHub fallback for the nightly health check (`health.yml`).
   It skips when Cloudflare started one in the last 30 hours, which is normal.
7. **05:30 (13:30 UTC)**: the free-limits snapshot, then the check that last night's backup is fresh (`limits.yml`).
   Running.
8. **15:15 (23:15 UTC)**: the image library's one daily run (`worker/library.ts`, inside the hourly tasks).
   Paused.
9. **20:30 (04:30 UTC in winter, 03:30 UTC in summer)**: the end-of-day run starts (`worker/night.ts`).
   Two crons exist so the start lands on 20:30 Pacific all year, and only the matching one starts the run.
10. **20:30 to 21:15 at the latest**: the free checks on GitHub (`sync-upstream.yml`), with the nightly health check started beside them (`health.yml`).
    Running.
11. **21:00 (05:00 UTC)**: the database backup to a private bucket (`backup.yml`).
    It runs during the night's free checks.
    Running.
12. **After the free checks, until 23:30 (07:30 UTC)**: the AI stages in section 4.
    Paused.
13. **22:00 (06:00 UTC)**: the GitHub fallback for the free checks (`sync-upstream.yml`).
    It skips when Cloudflare started the run in the last 20 hours, which is normal.
14. **23:30 (07:30 UTC in winter, 06:30 UTC in summer)**: hard stop, 30 minutes before the quota resets.
    Then the summary, a purge of cached profiles, the owner alerts, and the log clean-up.

Once a week:

- **Monday 07:00 (15:00 UTC)**: the security scan of dependencies (`security.yml`).
  It also runs on any pull request that changes a lock file.
- **Monday 08:00 (16:00 UTC; 09:00 in summer)**: model watch, then your goals email (`worker/model-watch.ts`, `worker/goals.ts`).

Not on a clock: discovery has a daily schedule at 14:00 Pacific (22:00 UTC) that does nothing (`discover.yml`, see section 5).

## 3. The hourly tasks, in order

One cron at :15 runs these tasks in this order (`worker/index.ts` `scheduled()`, names from `worker/crons.ts` `SCHEDULED_TASKS`).
Each task runs on its own, so one that fails is reported to Sentry and the rest still run.

1. **Start the re-check of failing sites** (`recheck start`, `worker/recheck-start.ts`): counts the sites due and starts `recheck.yml` only when at least one is due.
   It goes first because it is the one with a time to keep.
   Running.
2. **Apply owners' removals** (`owner removals`, `worker/owner-removals.ts`): a removal an owner asked for 24 hours ago takes effect.
   Running.
3. **Alert about removals on hold** (`removal alerts`): one owner email a day for each removal still held.
   Running.
4. **Clear cached pages** (`edge purge`, in `worker/index.ts`): in this order, profiles of sites an owner removed, the blog when a post's scheduled time came this hour, and profiles the health check hid or showed again.
   Running.
5. **Email caps** (`email caps`, `worker/email-alerts.ts`): an alert at 80% of any email cap.
   Running.
6. **Night watch** (`night watch`, `worker/night-watch.ts`): an alert when last night's run never started, or started and died.
   Running.
7. **Queued visitor requests** (`people queue`, `worker/night.ts` `drainPeople`): finishes visitor grade requests that waited for Gemini.
   The task runs, and there is nothing for it to do while visitor grading is Off.
8. **Tiers** (`tiers`, `worker/tiers.ts`, `lib/tiers-store.mjs` `dailyRun`): once a day, when due, first gives a Starting rank to every listed site measured since that may join and has none (at most 300 a day), then finds the tier cutoffs and rewrites only the letters that changed.
   The other ticks that day do nothing.
   The letters stay hidden from visitors while `RANKING_V2` is false (per `wrangler.jsonc`).
   Running.
9. **Apply review decisions** (`review auto-apply`, `worker/review.ts`): applies waiting rows in the review queue that pass the owner's rule.
   On with `REVIEW_AUTO_APPLY` true (per `wrangler.jsonc`).
   Running.
10. **Image library** (`image library`, `worker/library.ts`): does something only in the UTC hour `LIBRARY_RUN_HOUR_UTC` (23, so 23:15 UTC, 15:15 Pacific in winter), and nothing in the other 23 hours.
    Its Gemini checks use the `library` AI budget, so it is Paused.

Nothing checks pages for changes.
The hourly change fingerprints were removed on 2026-11-22, before they ever ran in production.

## 4. The night's stages, in order

The end-of-day run is a Cloudflare Workflow (`worker/night.ts`, logic in `pipeline/night.mjs`, budget in `pipeline/budget.mjs`).
It runs once a night: the night is claimed in the database, and a failed or stopped run never restarts.
If the Worker has no Gemini key, the run is skipped without claiming the night.
Whether the key is set is not confirmed.

### The steps of the run

1. **Claim the night** (`startNight`).
2. **Start the free checks on GitHub**: `sync-upstream.yml` and `health.yml` are started together.
3. **Wait for the free checks**: it waits for `sync-upstream.yml` for up to 45 minutes (to about 21:15), and does not wait for `health.yml`.
4. **Plan the AI work** (`planNight`), which does these free things first:
   1. makes sure this week's poll exists, and next week's when it starts before tomorrow's run;
   2. closes review rows whose reason no longer holds (every "signals collapsed" row, and a bot-wall or blocked re-capture row once a capture got through), then writes review rows for bot-walled sites that were never captured, asked once (`lib/reviews/door.mjs` `syncReviewRows`, `closeStaleReviews`);
   3. sets aside new sites whose stored screenshot does not show the site;
   4. counts what each stage has waiting.
5. **Run the AI stages** below, in order, in batches of 20 requests.
6. **Write the summary**, then purge cached profiles, then send the owner alerts (one email a day for each condition that holds).
7. **Roll up and prune the log tables** (`pipeline/retention.mjs`).

### The AI stages

The five stages are in `pipeline/budget.mjs` `STAGES`.
The caps and time caps are in `DEFAULT_PLAN`.
Today every cap is 0 in production, so every stage closes as "off: its cap is 0".
A site is graded once and never re-graded automatically: the only grade a graded site gets again is one a person asked for (the owner's "Re-grade"), done by stage 1 once the site has been captured again after the request, ahead of new sites and inside the same cap.
A `GEMINI_BUDGET` key for a stage that no longer exists (the production one still names `grade_changed` and `regrade`) is ignored.

| Order | Stage | Works on | Default cap a day | Time cap | State today |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | Grade new sites (`grade_new`) | listed, captured, healthy, not yet graded; and re-grades people asked for | 300 | 60 min | Paused |
| 2 | AI ranking comparisons (`compare`) | pairs of sites, then the boards are rebuilt | 200 | 45 min | Off (`RANKING_V2` is false) and Paused |
| 3 | Content (`content`) | poll writing, then blog picks and drafts | 100 | 30 min | Paused |
| 4 | Image library (`library`) | nothing at night | 40 | 25 min | Off at night, see the hourly task 10 |
| 5 | Experiments (`experiment`) | nothing scheduled | 50 | 15 min | Off |

The run begins at 20:30, the AI stages get going after the free checks (by 21:15 at the latest), and nothing starts after 23:30.
People always come first: the reserve for visitors is at least 25 requests and grows with demand, and the run pauses 5 minutes whenever a visitor asked for a grade in the last 10 minutes.
Each night has a retry budget of 20, a stage stops after 5 failures in a row, and a site that fails on 3 nights in a row is parked.

The free work that does not use Gemini keeps running while the stages are paused: the capture, page text and facts, link checks, the health check, polls made by code, and the review rows.

## 5. The chains

Each chain is a list of steps in the order they happen.

### A new site, from the list to the leaderboard

1. **The community list adds it.**
   Only entries merged into the community list (`emmabostian/developer-portfolios`) count.
   Their review is the first gate.
2. **The owner's confirmed relists go in first** (`sync-upstream.yml`, `pipeline/review-additions.mjs`).
   Sites you confirmed as portfolios on the review page that had left the list are added to `data/additions.json`.
3. **Our list is rebuilt** (`sync-upstream.yml`, `pipeline/generate_feed.py`).
   It is the community list, minus our exclusions, plus our additions, plus every site already on our list that the community list dropped (see "The community list drops a site" below).
   Three guards refuse a list that shrinks by more than 5%, a community list that drops more than 5% of our list in one night (a README cut short or rewritten), or a list that loses more than 15% of the current addresses.
   A refusal fails the run, which files an issue.
4. **The list change becomes a pull request that merges itself** (`sync-upstream.yml`, branch `data/sync-upstream`).
   A change under `data/` on main then rebuilds production's release over the new list (`deploy.yml`).
5. **Capture** (`sync-upstream.yml`, `pipeline/capture.mjs`).
   The database roster is synced first: rows not on the list are marked delisted, and rows back on it are listed again, with a 15% safety limit.
   A browser then visits each new site, takes the screenshots, and saves the page text and the facts code can measure, read from both the desktop and the phone view (`pipeline/facts.mjs`, facts version 4).
   When the home page shows fewer than 3 projects, it also reads the site's own projects page, one page at most and only by a plain GET of a same-site link or of the home page's own address for a hash route ("/#/projects"), and reads it once its list has stopped changing, within the step's 25 seconds (`pipeline/capture-projects.mjs`).
   Up to 8 project links are checked: one link per repository (or per folder of one, linked by its tree), and at most 3 of one outside site before the others; the site's own project pages count only as real pages, on a host that answers every address by the text they do not share with a page that cannot exist (AUTOMATION.md, Rubric v2).
   On the projects page, a link to another page of the same site counts as a project page at any path only when it sits in the main content, not in a menu, a list of profiles, an aside or a section that is not projects, its whole label does not name a section of the site ("About", "Get in touch", "Next project") nor start with a call to action ("Download Resume", "Read my articles"; "View project" is fine), and at the top of the site its path is not a page that is never a project ("/resume", "/services", "/blog", "/about"); below the top of the site its path must not name one either ("/topics/react"), and the page's own menu, header or footer must not link it too ("/contact", "/blog").
   Each link counts once, in the highest place it is seen in: a link in a work list that the projects list links again is a project; but what the home page shows outside its projects is raised by the projects page only when that page links it more than once, as a project card does.
   A menu is found by its shape, whatever it is built from: the links beside a link to the home page or to the projects page itself, at the same depth, mostly to the site's own pages and mostly naming its sections; only its own pages are left out, never a demo or a repository.
   When the measuring code changes, only the owner's manual `remeasure-all.yml` brings the whole list to the new version at once.
   On arrival, before the capture clicks or closes anything, the cookie check reads the cookies, the tracker beacons (from the page itself, apart from an embed's or an ad's) and any consent banner, within 12 seconds and never into the capture's time limit, and stores one of `none`, `after-consent`, `with-banner`, `no-consent` or `unknown` in `facts.privacy.readings.US` (`pipeline/cookie-check.mjs`, docs/DECISIONS.md "The cookie check"); nothing shows it yet.
   The whole-list `remeasure-all.yml` also takes every row with no cookie check reading at the current `privacy.v`, so one run fills the readings in for the list, and a re-run after a failure skips the rows already done (`scripts/remeasure-shard.mjs`).
   The same step re-captures up to 150 older sites (`NIGHTLY_REFRESH`, per `wrangler.jsonc`), `lib/freshness.mjs` `screenshotsDue`.
   A capture is due again for one of two reasons only: it is 90 days old, or a person asked for a new one (your "Re-measure", or a re-grade an owner asked for).
   Asked-for sites go first, then the oldest captures.
   A refresh that fails keeps the old capture and waits out a growing backoff, unless someone asks again after the failure.
   A change to the page is not a reason: nothing watches for one.
6. **Capture checks** (same step, code only).
   A capture that does not show the site is never stored or graded:
   1. An error, a parked page or a blank page is retried on later nights, after 1, 2, 4, 8 and 16 days, then every 30 days.
      A parked page is judged where the visit ends, after the page's own redirects: a parking service's address, a parking phrase on a short page, or a parking service's own lander code (the same rule as the health check's).
      Only that kind of positive evidence counts: an address such as `/lander`, a short or empty page, or a page that could not be read never makes a site parked.
   2. A bot wall is never graded.
      A site that was never captured gets a row on your review page at the night's plan step.
   3. A page with only a canvas or video is held back and marked for review, but no review row is written for it yet.
      The fix is open as #266.
   4. A re-capture of a site that already has a good capture never replaces or fails it: the site waits 1, 2, 4, 8, 16 then 30 days before the next try (`refresh_failures`).
      From the next release, a re-capture that meets a bot or security check, or a dialog still covering the page, also puts the site on your review list: a row on your review page ("Mark checked" records that you looked), and the stored capture and grade stay as they are.
      The row closes by itself once a later re-capture gets through.
      A gate, loader or mode picker still in the way, a page of only a canvas or video, or an error status does not go to your review list after a re-capture; it stays a refresh failure with its reason.
      Neither does a bot check seen only on the phone-size visit, after the desktop view showed the site.
   5. From the next release, a re-capture that lost a résumé, GitHub or contact link the old capture had, or most of its text, is recorded (`capture_changes`).
      A change that comes with new measuring code (a new `facts.v`) is recorded as the code's, not the site's.
   All of these are listed on the Capture problems page (see "Keeping watch").
7. **More free measuring** (same workflow, in this order): tall page images for older captures (up to 100 a night), page text and facts for sites waiting for a grade (up to 300), and project link checks that are due (up to 120).
   A link check tests again the links the site's capture chose and only renews which of them load (`pipeline/evidence.mjs`).
8. **Starting rank and Tier** (the capture itself, `lib/tiers-store.mjs` `rankFromCode`, right after a capture is stored; the daily tiers task catches any it missed).
   This step starts with the release after 2026-11-22; until then a site gets its starting rank only with its Gemini grade.
   Your rule (2026-11-22): "the starting rank you get is based off of clear verifiable code measurements", and "a site should have a tier" from its first measure.
   A listed site joins the tiers when it has a good capture, measured facts and at least 4 of the 6 portfolio signals (name, projects, about, contact, resume, GitHub), with no Gemini grade needed.
   A site with fewer signals waits until Gemini says it is a portfolio or you keep it on your review page.
   Its starting place is its Code checks score (`lib/check-points.mjs`, 100 points) among the others' points; nobody else's rating or votes move.
   The code items (resume, GitHub, contact, own domain, project links, footer year) are read from the newest measured facts (`portfolios.facts`, `lib/fresh-facts.mjs`).
   Equal points go by the date first measured, then the address, never by anything Gemini said.
   Its Tier (the letter) comes from its place, and votes move it from there.
   Tier letters are hidden from visitors while `RANKING_V2` is false (per `wrangler.jsonc`), so the leaderboard visitors see today is the older votes board.
   Lighthouse for every member comes from the nightly prewarm (`scripts/lib/prewarm.mjs`), graded or not; until it has run, those items count the library median.
   The starting place itself is set again only by a full rebuild (`scripts/refresh-tiers.mjs`).
9. **Grade** (night stage 1, `grade_new`).
   One Gemini request with the screenshot, the page text and the facts (rubric v3, prompt `grade-v3`, `pipeline/rubric.mjs`).
   It is asked two things and nothing else: whether it is a portfolio (with a short reason, written first) and the roles the page names.
   Your decision (2026-11-22): "Gemini outputs kept: is_portfolio, five-second test, roles. Dropped: the letter, project presentation, visual design, writing, memorability."
   It never sets or moves the Starting rank or the Tier, and none of its answers is shown (your decision, 2026-11-23: no Gemini report card); "is it a portfolio" feeds the removal rule below and the roles name the profile for search engines.
   Your decision (2026-11-23): the five-second test will be measured by code, so the model is not asked it; older grades' five-second scores stay in the database, unread and unshown.
   Grades made before v3 keep their old fields in the database, and no site is graded again because of v3.
   No profile, list, stat, rank or tier reads those fields.
   Three readers still use an older grade's letter, none shown while `GAMES_V2`, `GRADER_ENABLED` and `RANKING_V2` are off: the openskill views' seed (`lib/ranking/engine.mjs` `seedFromGrade`), the games' percentiles (`lib/games/pool.mjs`) and a person's grade report's comparison pool (`lib/grader/report.mjs` `gradedPool`).
   Before `RANKING_V2` is turned on, those views must be reseeded from the code checks or retired if any page shows them.
   A stored screenshot that does not show the site is checked first and set aside.
   Paused.
10. **The removal rule** (the same moment, `lib/reviews/door.mjs` `doorDecision`, `atTheDoor`).
   Every AI grade goes through it:
   1. You ruled on the site before: your verdict stands.
   2. Gemini says portfolio: it is listed, unless its address is not a portfolio page (step 3).
   3. Gemini says not a portfolio, the code finds fewer than 4 of 6 portfolio signals, and nothing earlier argues for the site: a removal is recorded.
      A junk rule that fires (`pipeline/junk-rules.mjs`) also lands here, even with 4 or more signals.
      So does an address whose host, or the host it forwards to after its redirects (`addressNotPortfolio`), is never a portfolio page (`hostNotPortfolio`: a GitHub, GitLab or Bitbucket address or a GitHub gist; any Substack or Medium page, subdomains included; any Linktree page on `linktr.ee` or `linktree.com`; and the link-in-bio pages `bio.link` and `beacons.ai`), whatever Gemini said; your rules (2026-11-23): "Someone's GitHub is not a portfolio page.", "any substack should never be considered a portfolio page." and "A link tree is not a portfolio page ... A medium page is not a portfolio page".
      A site on its own subdomain of a hosting place, such as `name.github.io`, `name.vercel.app` or `name.netlify.app`, is a real site and is never caught ("Vercel is different. Vercel is just a hosting place."). Notion pages are not decided and not caught.
      An admin or login path is a junk rule only beside Gemini's "not a portfolio", as before.
   4. Gemini says not a portfolio but the code finds 4 or more signals, or never measured them: the site stays listed and a row waits for you.
   5. You undid an earlier removal, a rule once listed the site, an earlier grade said portfolio, or another case is waiting: the site stays listed and waits for you.

   The address rule also runs over every listed site in the night's free part, before any grade, so an address is seen the night it is synced in even while grading is paused (`lib/reviews/door.mjs` `addressRows`).
   The same ladder applies: a site you ruled on, kept, or took a removal back from, or with a case already open, is left alone; a site tonight's grade will take (within tonight's share of the grading queue) is left to the door; one an earlier grade or a rule called a portfolio waits for you; one never graded gets a recorded removal for the hourly task to apply (step 11).
   A brake (`lib/reviews/door.mjs` `addressBrake`): the rule may write at most 5 rows a night, held or automatic, the roster pass's and the door's together (`ADDRESS_AUTO_PER_NIGHT`), and take off at most 10 sites in 7 days (`ADDRESS_AUTO_PER_WEEK`). On a night with more, every one waits for you on the review page, and a later night's grade does not take them off either (a row held for you holds the site at the door). The owner alert `address-rule-brake` stands and repeats daily while any of those rows waits, since so many at once usually means the host list or the list sync changed, not the sites.
   When Gemini said portfolio, or no grade has seen the site, the row says "Not a portfolio address" on your review page and is decided by `rule:not-a-portfolio-address`, not in Gemini's name; when Gemini itself said not a portfolio, the row is Gemini's, as for any junk rule.
   The public Removed page then says "Its address is not a portfolio page (a code host, a newsletter or blog platform, or a link-in-bio page)", never "AI grading says".

   Whatever the outcome, the grade is written with `lib/tiers-store.mjs` `rankForWrite`: a site that already has its Starting rank keeps it exactly, a site without one (it had too few signals) gets it now from its Code checks score, and any answer that is not a "yes" takes the site out of the tiers at once.
   A site out of the tiers comes back only through the membership rule, at the next daily tiers task, with the rating and votes it had (`seedNewcomers`).
11. **Apply the removal.**
    With `REVIEW_AUTO_APPLY` true (per `wrangler.jsonc`), the night applies a recorded removal at once.
    The hourly task (hourly task 9) applies any that were left waiting, and also confirms waiting relist rows when both graders say portfolio.
    Every automatic decision shows on your review page with Undo.
    A removed site leaves the order.
    An undone removal brings it back with its rank: at once when the grade it had comes back, or, when that grade is set aside for one fresh grade, once the fresh grade says it is a portfolio.
12. **After that** the site takes part in votes and gets the nightly health check.
    It is not graded again, except for one fresh grade after you undo a removal or choose "Keep on the list" on one, a re-grade its owner asks for (graded once, after a new capture), and the manual tools.

### A site stops working

Your rule (2026-11-23): "if something is failing a health check, it doesn't go to review by me, it gets checked, it gets put in a pool ... And after 90 days, it gets put into the archived section."
Every kind of failed check takes these same steps: the site does not answer (paused hosting, a dead domain, an HTTP error), it is parked or for sale, it is blank, it redirects to a social profile, its capture was never anything but blocked, or it duplicates another entry.
Never a failed check: a bot wall, a check that could not tell (a timeout, a dropped connection, a browser that did not start), a "not a portfolio" grade, and low portfolio signals (the code could not read the site; it stays listed).
Nor a listed address that fails while the site answers at its own address with www or https, where it ended on an earlier good read (http://gianlucafiore.it has a stale server among its addresses; https://www.gianlucafiore.it serves the site): the site passes, and `/admin/health-pool` lists it as "listed address unreliable". Another domain is never tried this way.
Nothing at any step writes a row to your review page.

1. **Nightly health check** (`health.yml`, `pipeline/health-check.mjs`, started by the night).
   Every listed site is loaded.
   A plain request comes first, and its whole page is read up to 2,000,000 characters (`pipeline/gate.mjs` `httpGate`).
   When that page is nearly empty, failed or shows too few portfolio signals, a real browser reads the site too (`pipeline/render.mjs`).
   It reads once the page's text has held still for 2 seconds, scrolling one screen at a time while it waits so sections that load on scroll appear, for at most 10 seconds.
   A page with under 400 characters of text (an intro screen or a loader) is not taken as finished: it is watched for up to 15 seconds.
   The browser only scrolls: it never clicks, presses or submits anything, so a site whose intro waits for a press reads as its intro.
   It scrolls one screen per half second, so at most about 20 screens (30 on a page that began thin) before the limit, which bounds an infinite feed; the scrolling can fire a site's own analytics scroll events.
   Known limits, accepted because the page is read once: typing slower than about 20 characters a second counts as text holding still, so such a line is read mid-typing; and on a very long page a late section of under about 1,000 characters is not waited for.
   These only change the stored text and signals, which never hide a site.
   Of the rendered page at most 400,000 characters are kept, after script and style bodies, image data and empty decorative elements are dropped, so the menu and text survive.
   The six portfolio signals and the role the page's title or description states (`pipeline/signals.mjs` `statedRole`, stored with the signals, not shown anywhere yet) are read from that page.
   Low signals never hide or remove a site.
   On a first failed check the site is `suspect`: it leaves all AI work at once, but stays visible.
2. **Re-check after 1 hour** (`recheck.yml`, `pipeline/recheck-run.mjs`, started by the hourly task).
   Up to 120 due sites a run, with a 20 minute limit.
   Five sites that were live are loaded beside them.
   If fewer than 3 of those load, the checker is at fault, nothing is recorded, and the run fails.
3. **Re-check the next day: the temporary pool.**
   Still failing: the site goes into the temporary pool.
   It is hidden from browse, search, the leaderboard, the tiers, the games and the sitemap, and its profile page answers "not found" (`lib/hidden.mjs`).
   Nothing is deleted: its rank, votes, grade and captures stay.
   Two failures on one day never hide a site: the hiding check comes at least a day after the first failure, and a week after it for a blank page, a blocked capture, a redirect to a social profile, a duplicate, a placeholder page or the browser's error page (weak evidence the checker itself can cause).
   No more than 20 sites are hidden in any 24 hours, oldest first failure first, and no more than 5 of those weak verdicts; the rest wait their turn, still shown, and are hidden as places free (36 dead sites: 20 one day, 16 the next).
   This is the ordinary pace and sends you nothing; `/admin/health-pool` shows who is waiting.
   A spike is different: when more than 100 sites (about 5% of the list), or more than 50 for one kind of reason, start failing within 48 hours, the fault is most likely ours or a host-wide outage, so none of them is hidden while it lasts and you get one alert.
   It lifts by itself once the spike is over; a site still failing then needs its full wait again (the next day) before it is hidden, at the same 20 a day.
   Weak verdicts are counted over 8 days instead: a fault in our reader can go on for a week at a steady pace.
   More than 50 new ones of one kind (blank pages, say) in 8 days holds that kind's weak verdicts, still shown and checked daily, with one alert; other kinds keep moving.
   More than 50 of all weak kinds together holds every kind with 10 or more, since one fault can show as several kinds.
   The hold lifts when fewer than 50 of its held sites still fail, and each still failing then needs a full week again; a site held 14 days and still failing is released anyway into the weak drain, so a hold never lasts forever, and the alert stays up ("released, hiding N a day") until a week after the last of them is hidden.
   A slower leak gets an alert without a hold: more than 15 sites hidden on weak evidence in a week; while it is up only 1 a day is hidden, and it clears once the week's count is down to 5.
   Sites nobody could see anyway (a capture that never showed the site, no screenshot) never count toward any of this.
   On release night, the sites already failing under the old rule keep their first failure date, so only those that really started failing recently count toward a spike; `node pipeline/health-check.mjs --dry-run` counts them beforehand ("Restarted on the ladder"), with how many fall inside the 48-hour and 8-day windows.
4. **Keep re-checking** (hourly, when due): daily for the first 7 days, weekly to day 30, then monthly.
   Every night one plain request also goes to each hidden site; if it answers with words, its full re-check comes within the hour.
   A check that passes brings the site straight back, exactly as it was, tier included.
5. **Day 90.**
   One more check is made on day 90.
   Only a check made on or after day 90 that fails sends the site to the archive.
6. **The weekly export: the archive** (`health.yml`, `pipeline/exclusions.mjs`, every 6 or more days).
   The site is added to `data/excluded.json` (kind `down`, or `duplicate` for a duplicate) and dropped from the list, through a pull request (`data/health-exclusions`) that merges itself, at most 10% of the list at once.
7. **The archive check** (the same weekly export, `pipeline/not-working.mjs` `archiveCheckDue`): every `down` and `dead` entry is checked again on days 7, 14 and 21 after it was archived, then every 30 days; plain health checks only, no Gemini, at most 40 a run.
   One that passes leaves the archive and is recorded in `data/additions.json`, so the next sync lists it again even when the community list dropped it.
   It counts as back only when the page carries the listed person's whole name, together and in order, in its title or its opening text (not its address; a name in Chinese or Japanese as written; a one-word name in the title or the first heading), so a lapsed domain someone else bought does not come back under the old name; otherwise it stays archived and `/admin/health-pool` shows what was found.
   It comes back as a new site, whenever that is, because we cannot know it is the same site (your rule, 2026-11-23: "It can't keep its own votes."): captured, measured and ranked from code like a site listed for the first time, with none of the old site's votes, rating, tier, grade, face-offs, likes, claim or review decisions.
   The old site's rows are kept as history under a closed-off key, `archived:<day>:<address>`, which nothing lists (`pipeline/archive-return.mjs`); no other site's rating moves for it.
   A site back from the temporary pool (step 4) is different: the same site after a bad spell, back exactly as it was.
   Not-a-portfolio removals, owner requests and duplicates are never checked this way.
8. **Delisted rows are purged** (`health.yml`, `pipeline/purge-delisted.mjs`): a row off the list for 30 days is deleted with its screenshots, but only when we removed the site (it is in `data/excluded.json`) or the row is an old spelling of a listed site.
   Any other delisted row is kept and counted in the run summary.
   Votes and ratings stay.

No one is emailed at any step.
You see the pool, the archive and what came back in the last 30 days on `/admin/health-pool`.
A site the check could not tell about for 28 days gives you an alert on the alerts page.
A bot wall: a site whose capture met one is never failed for it; the first time, a row asks you about it once, and once you have decided it no check asks again or pools it for the wall.
It is asked about again only after it failed a real check (it did not load, was parked or blank) and came back.
A parked domain counts as the wrong thing also when its home page is only a redirect made on load (a script or a meta refresh of a few seconds) to a parking service or a parking page on the same domain, such as GoDaddy's `/lander`.
The check follows that one redirect with one plain request on the same domain and judges where it lands (`pipeline/gate.mjs` `parkedPage`): only a parking service's address, a parking phrase or a parking service's own lander code count.
A short page that loads Sedo's lander images, or whose whole title is Sedo's ("abdulmomin.dev - abdulmomin Resources and Information." on its own domain), is parked the same way.
So is a short page that stands where the site was (`pipeline/gate.mjs` `placeholderPage`), with the reason `not the site: <what>`: a web server's default page (nginx, Apache, IIS, Caddy, Plesk), HostGator's placeholder, an empty "Index of /", GitHub Pages' "there isn't a site here", a host's unpublished-site page, Streamlit's "Error running app", the WordPress maintenance page, or a page whose whole text is a removal notice or "not found".
Each needs that page's own evidence: a sentence only it says (a server's default `<title>` alone is never enough), or its whole text; and a page that shows 2 or more portfolio signals is never one.
A server's default page may come from one stale address among a domain's answers, so before failing on one the check tries the address's https and www forms once each, and passes if either shows the site.
A listed domain that now forwards to another domain whose page carries none of the person's name, on a host without the listed address's handle, and a word only gambling sites use (togel, gacor, maxwin, nổ hũ, taruhan, sportsbook) fails with `redirects to <domain>, a gambling site` (`pipeline/health.mjs` `redirectVerdict`); any other move is only reported.
A browser that shows only its own error page (`chrome-error://`) fails with `does not load (the browser's error page)` when the failed navigation's error code says the site is not there; a code that says nothing about the site (a reset or a timeout), or none, is a check that could not tell.
Each of these is a failed check, counted like any other failure of its kind by the health check's ladder, whichever ladder runs; none is ever a removal by itself.
The capture judges where its browser ended with the same `parkedPage`: a new site whose first capture is one of these pages is not stored, is retried like any failed capture, and is hidden until a health check passes it (`lib/hidden.mjs`); a re-capture of a listed site that meets one keeps its good capture and changes nothing that is shown.
A page there that could not be read, answered an error or is merely short is left to the browser, and a site that redirects to a language, a home page or its owner's other domain, or shows a nearly empty app shell, is not parked for that.

### A live site that may not be a portfolio (suspicion flags, not wired yet)

The health check answers "is this site alive", not "is this alive site a portfolio".
`pipeline/portfolio-flags.mjs` holds named suspicion flags for that second question, each a pure function over a site's saved page (no network, no AI).
A raised flag gives its name, one plain sentence quoting what it found on the page, and the snippets it matched.
Email addresses and phone numbers in a quote are replaced by `[email]` and `[phone]`.
They are not yet wired to anything: no flag removes, hides, ranks or queues a site today.
The plan is that a flagged site goes to your review queue, listed meanwhile.

| Flag | What it looks for |
| --- | --- |
| `filler-text` | Template filler in the text: "Lorem ipsum", "your name here". |
| `placeholder-page` | A short page with no projects that says it is coming soon, under construction or a work in progress. |
| `moved-notice` | A short page with no projects saying the site has moved to another site. |
| `blog-only` | Only a blog, found two ways. Dated posts and nothing else the code can see: any project evidence keeps the page quiet (a projects section, heading or link, a "Projects" or "Work" menu entry or button, links to the site's own project pages, case studies), and so does a resume or work history. Or the site's name is a blog: its title, site name or first heading names it as one ("Patrick's Blog", "A blog about Rust", "Kişisel Blog", "a blog by Bouwe", "Ana Ruiz-Blog", or just "Blog"), that part of the name does not also say portfolio, projects, work, case study, resume or CV, and it has no projects menu entry, no plural projects heading, no resume heading and no project link shown outside its posts. Project links are code repositories, live demos and the site's own project pages; any one of them outside the posts protects the page whatever heading sits above it. Links inside a post (an `<article>`, a block marked as a post, or a card that carries a date or a link to a post) never protect it, and when the code cannot tell, a link counts as outside the posts, because missing a blog is the cheaper mistake. A name that only mentions a blog ("Code & Blog", "Portfolio & Blog", "I build things and blog about them") is never flagged, and having a blog is never a negative. |
| `link-card` | A name, a line and a handful of profile or email links, nothing else: a contact card. You have not ruled on these yet. |
| `company-voice` | The page speaks as "we" far more than "I" and sells services or names a team or jobs. A freelancer or a one-person studio is protected; a page naming two people says so. |
| `sells-teaching` | Coaching, courses, speaking or a book for sale, and no projects. |
| `product-page` | One product's or tool's own site: pricing, sign up, documentation, terms, and no person behind it. A one-person business is protected, and so is a page that speaks as "I" or names its one-word domain as a person ("I'm Kunal" on kunal.dev). |
| `readme-page` | A code repository's README rendered as the page: install steps, commands, the folder layout. |
| `hidden-spam-links` | Gambling, adult or pharmacy links to two or more other sites, hidden in a block that can never be opened (zero size, zero font size, pushed far off screen): the site appears to have been compromised. Hidden tabs and menus, and links to project hosting such as vercel.app or github.io, never count. |
| `forwards-elsewhere` | The address forwards to another domain without the person's name or handle: the health check's own "moved" verdict, given a flag's name. |
| `sub-page` | The listed address is a sub-page that is not itself a portfolio (a blog category page); says in plain words what the site's home page is. A github.io project site, a `/portfolio` or `/portfolio.html` path, a university's `/~name/` page or any sub-page with projects is never flagged, and a code host's or a university's home page is never judged. |

Beside the flags, and never one of them, `unreadable-page` notes a page the code could not read (under 60 characters of text: an intro or gate screen, a lock screen, a canvas, a bot check).
Most are real portfolios, so it is never a suspicion and never goes to the review queue as one; it is for fixing how pages are read.

How each flag scores on the labelled benchmark and on a fresh sample of listed sites is printed by the benchmark scorer kept with the owner's handoff files (`run-benchmark.mjs`), which runs them against any checkout.

### The community list drops a site

Your rule (2026-11-22): a removal on the community list changes nothing on our side.
The community list drops lines mostly through its own broken-link reports (paused hosting, a 404, an expired domain), which is not a judgement that the site is not a portfolio.

1. **The nightly list rebuild keeps it** (`sync-upstream.yml`, `pipeline/generate_feed.py`, `pipeline/build-feed.mjs` `buildFeed`).
   A site on our list that the community list no longer has stays on `data/feed.json`.
   It is recorded in `data/additions.json` with `"source": "left_community_list"` and `left_on`, the day the rebuild first saw it gone, and both files go into the same self-merging pull request.
   Not kept: a site in `data/excluded.json` (under either spelling key), an old spelling of a site the list now spells differently, and a line that was never a web address (such as `https\://shreyanshportfolio.in`, misread by an older parser).
2. **Nothing changes in the database.**
   The roster sync sees the site still on the list, so its row, grade, votes, ratings and screenshots stay as they are.
3. **Only our own checks decide from then on.**
   The nightly health check hides it while it fails and shows it again when it passes, as for any listed site.
   It leaves the list only through our exclusions (dead, down, duplicate, not a portfolio) or an owner's removal through the claim process.
   A recorded site that we exclude stays recorded, so lifting the exclusion (an undone owner removal, a removed site that passes its re-check) lists it again.
4. **If the community list lists it again**, the rebuild takes the community list's entry (with our spelling, if it respelled it), and the site leaves the record.

Nothing is sent to the community list.
The 25 sites the community list had dropped before this rule were put back into the record by hand on 2026-11-22, each with the day our list lost it.

### An owner removes their site

1. **Prove control.**
   The owner signs in with GitHub (an account at least 30 days old) and proves the site is theirs: the meta tag, the GitHub Pages address, a file at the site root (only while "Add your portfolio" is on, which is Off), or a claim you reviewed.
   A link from the page is not enough to remove.
2. **Ask for removal** (`app/api/owner/actions`, `lib/games/claims.mjs`).
   The request is held for 24 hours.
   Removing is always on, whatever the other switches say.
3. **You are alerted** (`removal alerts`, hourly task 3), once a day, while the removal is held.
4. **The hourly task applies it** (`owner removals`, hourly task 2).
   The site disappears, and its cached pages are cleared by the next `edge purge`.
5. **The nightly health run writes it down** (`health.yml`, "Add owner removals", `pipeline/owner-removals.mjs`).
   The site goes into `data/excluded.json` through the same self-merging pull request, so the sync never brings it back.
   This is nightly, not weekly.
6. **Undo.**
   You can undo a removal on the admin side.
   The next nightly health run takes the site out of the exclusions file, and the next sync lists it again.

Known gaps, with fixes open as pull requests: a removal covers one exact spelling of the address (#268), and a respelled site can get a second row (#267).

### A visitor reports a problem

Screenshots and measurements are taken by code, and sometimes the capture is wrong: a cookie wall, a loader, the wrong page, a wrong measurement.
Always on; no switch.

1. **A visitor reports it** (`components/profile/ReportProblem.tsx`).
   "Report a problem" sits under the screenshot on every profile.
   It opens a panel with five reasons (the screenshot is wrong or broken, a measurement is wrong, this is not a portfolio, the site is gone or has changed, something else) and an optional note of at most 500 characters.
   No account is needed.
2. **The route checks it** (`app/api/problem-reports/route.ts`, the steps in `lib/problem-reports/intake.mjs`).
   In this order: same origin, a known reason and a short note; the network limits (6 an hour and 20 a day per IPv4 address or IPv6 /64, 60 a day per IPv6 /48; a request without an address shares one "unknown" network); Turnstile (action `problem-report`); that the site has a live profile (the same checks that decide whether its page answers 404); then 10 a day per visitor.
   If Cloudflare shows its checkbox, the panel says "tick the box" and waits up to two minutes for it.
   One visitor has at most one open report per site: sending again replaces the first and adds no row.
   Past 30 new reports on one site in a day, or 200 across the whole site, the visitor still gets the thanks and nothing more is stored.
   Each cap is logged once a day (`problem_reports_site_cap`, `problem_reports_daily_cap` in Workers Logs), and the whole-site cap also opens a quiet alert on `/admin/alerts`, which clears when you next mark reports handled.
   The visitor and the network are kept only as hashes keyed with the server's secret, and the visitor's hash is cleared when the report is handled.
3. **It is stored** in the `problem_reports` table (`lib/problem-reports/schema.mjs`).
4. **You read it** on `/admin/review`, under "Visitor reports" above the review queue (`components/admin/ProblemReports.tsx`).
   Open reports are grouped by site with the count, the reasons, every note (shown as plain text) and links to the site and its profile.
   "Mark handled" closes the reports as the page showed them and records who and when; a report the visitor resent after the page loaded stays open, so no note is closed unread.
   "Handled recently" lists each "Mark handled" with Reopen, which puts back exactly those reports.
   A reopened report has lost its visitor hash, so if that visitor reports the site again it becomes a second open report; this is rare and kept simple on purpose.
   Handled reports are deleted 180 days later (nightly retention).
   Nothing emails you about reports; look when you review.
5. **What it changes: nothing.**
   A report never moves a site's rank, tier, score, votes or listing.
   Fixing what it points at is your own step: a re-capture, a review row or a removal.

### Ranking

No Gemini answer is in the ranking or shown on a page; the model decides only whether a page is a portfolio (the removal rule).
The rank starts from the Code checks score and moves with face-off votes; no Gemini output is in it.
Every place that shows the Code checks score shows each item and the total to one decimal when it is not whole, and never rounds a score up to its maximum (`lib/check-points.mjs` `formatPoints`): 9.4 of 10 shows as 9.4/10, never 10/10.

1. **A person votes** (any time, `app/api/rank/route.ts`).
   Two sites are shown and one is picked.
   Only a signed-in vote counts: both sites' ratings move at once, in the same step.
   An anonymous practice vote is stored but moves nothing.
   A starred vote counts twice.
   Running.
2. **AI comparisons** (night stage 2).
   Gemini makes the same kind of pick, counted as a quarter of a person's vote (`lib/tiers.mjs` `AI_VOTE_WEIGHT`).
   Off (`RANKING_V2` false) and Paused.
3. **Tiers** (hourly task 8).
   Once a day the cutoffs are found: sites are put in one order and cut into bands, SSS and S at the top (earned: 3 wins and the top 1%), then A, B and C.
   D is reserved and nobody is D yet.
   Letters are hidden from visitors while `RANKING_V2` is false.
4. **Whether a win should be needed to climb** (a decision called R1) is a decision record, not code.
   It is not confirmed here.

### Visitor grading ("Grade my portfolio")

The whole chain is Off: `GRADER_ENABLED` is false (per `wrangler.jsonc`).
The routes answer 404 and the five-minute tick returns at once.

1. **A visitor submits a site** (`app/api/grade/route.ts`), limited to 3 a day per visitor.
2. **Capture** (`grade.yml`, started by the Worker for each request, `scripts/grade-jobs.mjs`).
   The same browser capture, behind a filtering proxy.
3. **Grade** (`pipeline/people.mjs`).
   One Gemini request from the day's quota, or the visitor's own key.
   It still uses the frozen v2 prompt (`pipeline/rubric-v2.mjs`: Gemini's letter and five scores), because the visitor's report is built on them; listed sites use v3.
   What that report shows under v3 waits for your decision.
   A request that cannot be answered waits, and the hourly task 7 finishes it.
4. **Report and email** (the five-minute tick, `worker/grader.ts`).
   The visitor gets a report page and, if they asked, a one-time link by email.

### Blog, polls, image library and newsletter

1. **Poll scheduling** (night plan step, `pipeline/polls.mjs`).
   Free and made by code: this week's poll exists, and so does next week's when it starts before tomorrow's run.
   It depends on the night running at all.
2. **Poll writing** (night stage 3, `content`).
   Gemini writes 4 candidate questions when fewer than 2 future weeks have a poll.
   Off: `POLL_GENERATION_ENABLED` is false (per `wrangler.jsonc`), and the stage is Paused.
3. **Topic pick** (night stage 3, Sunday night).
   Chooses the week's post ideas from the site's own data.
   Paused.
4. **Draft** (night stage 3, Monday and Wednesday nights by default, set in the admin blog page).
   Gemini writes a post and outside claims are checked or cut.
   Paused.
   `CONTENT_MODE` is `dry-run` (per `wrangler.jsonc`), which allows drafts for review only, so nothing publishes without you.
   Whether the writer has ever produced a real draft is not confirmed.
5. **Images** (hourly task 10, once a day at 15:15 Pacific, `worker/library.ts`).
   Makes images from the image library's queue, up to what is left of 40 a day.
   Paused.
6. **Your review, then publish.**
   Posts go out at the 08:00 Pacific slot after you approve them.
   The blog's cached page is cleared in the hour a post's time comes.
7. **Newsletter** (five-minute tick, `worker/newsletter.ts`).
   Sends a published post through Kit.
   Off: `NEWSLETTER_ENABLED` is false (per `wrangler.jsonc`).
   It also needs a Kit key, which is not confirmed.

### Discovery

Finding portfolios beyond the community list.
Off, and the last step has never been connected to the list.

1. **The schedule never fires.**
   `discover.yml` has a daily schedule at 14:00 Pacific (22:00 UTC), but the job runs only when the repository variable `DISCOVERY_SCHEDULE` is `on`.
   That variable is not set, so every scheduled run is skipped.
   A manual run works only when the repository variable `DISCOVERY_TARGET` is `production`, and then writes to the production database; without it the run stops at its first step.
2. **Read the sources** (`pipeline/discovery/sources`): GitHub topics, Hacker News and two directories.
3. **Free check and filter** (`pipeline/discovery/check.mjs`, `filter.mjs`): code drops known sites and obvious junk.
   A site that passes waits for the hand-off (`pending`).
   There is no AI screen: Gemini is asked about a site once, when it is graded.
   Sites an earlier run left waiting for the removed screen stay where they are and are never handed off (`docs/DISCOVERY.md` says how to check them again by hand).
4. **Hand-off to grading** (`handoff.mjs`).
   Runs only with `DISCOVERY_HANDOFF` on.
   Off.
   Found sites are handed to the visitor grading queue, not to the list, so discovery cannot add a site to the list today.

## 6. Keeping watch

These do not hand work to each other.
Each one watches the jobs above.

| When | What | State |
| --- | --- | --- |
| a failed run | The jobs with their own failure notice file or update a GitHub issue: `sync-upstream.yml`, `health.yml`, `recheck.yml`, `backup.yml`, `limits.yml`, `prewarm.yml`, `judge-vote.yml`, `discover.yml`. | Running |
| a failed run | The others file nothing: `grade.yml`, `security.yml`, `regrade-not-portfolio.yml`. | Running |
| hourly | Night watch: an alert when last night's run never started or died. | Running |
| hourly | Email caps: an alert at 80% of a cap. | Running |
| after each night | Owner alerts: quota used up, a stage stopped, parked items, traction, a missing or expiring dispatch token. | Running |
| after each night | Owner alerts: a weekly summary of the open capture problems, each group's count and its change since the last email, with the page's link (`lib/capture-problems.mjs`). Emailed at most once in 7 days, and only when a count has gone up since the last email (a rise inside the 7 days is reported after them if it is still there; after the alert clears, a problem that comes back counts as new). The other nights it is shown in the admin but not emailed. Never on staging. | Off until the next release |
| any time | The Capture problems page (`/admin/capture-problems`), listed sites only: A a re-capture failed and the old capture is kept, B a first capture failed, C the stored capture is a bot check or has under 200 characters of text (captures from before page text was stored are counted apart as not checked), D a re-capture got worse. Each row has its reason, capture date and thumbnail, Gemini's grade, the health state and whether it has an open row on your review page. | Off until the next release |
| daily | A backup of the database (`backup.yml`), and a check that it is fresh (`limits.yml`). | Running |
| daily | A snapshot of free limits for Turso, R2 and Workers (`limits.yml`). | Running |
| weekly | Model watch and your goals email (Worker), and the security scan (`security.yml`). | Running |
| on a push | The direct push alarm reports a push to main that skipped a pull request (`direct-push.yml`). | Running |

## 7. Every workflow and Worker task

### GitHub workflows (`.github/workflows`)

| Workflow (name) | Trigger | What it does | State today |
| --- | --- | --- | --- |
| `sync-upstream.yml` (Sync upstream + ingest) | started by the night at 20:30 Pacific; fallback 06:00 UTC; manual | the free checks: list, capture, evidence | Running |
| `health.yml` (Nightly health check + cleanup) | started by the night; fallback 12:00 UTC; manual | health check, owner removals, weekly exclusions, purge | Running |
| `recheck.yml` (Hourly re-check of sites that stopped working) | started by the hourly task when due; fallback :40; manual | re-checks failing sites | Running |
| `grade.yml` (Grade my portfolio) | started by the Worker per request | captures visitor requests | Off |
| `judge-vote.yml` (AI comparisons, manual fallback) | manual only | the ranking v2 comparisons and the boards rebuilt, only when the repository variable `RANKING_V2` is `true` | Off (that variable is not set, so a manual run does nothing) |
| `regrade-not-portfolio.yml` (Re-check not-a-portfolio grades) | manual only | a one-off re-check tool | Off |
| `remeasure-all.yml` (Re-capture and re-measure the whole list) | manual only | re-captures every listed site in parallel shards after the measuring code changed, no AI | Off |
| `discover.yml` (Discover portfolios) | daily 22:00 UTC, gated; manual | finds new sites | Off |
| `backup.yml` (Backup DB to R2) | daily 05:00 UTC; manual | database snapshot | Running |
| `limits.yml` (Free limits snapshot) | daily 13:30 UTC; manual | free-limit numbers, backup freshness | Running |
| `prewarm.yml` (Prewarm metrics) | daily 09:00 UTC; manual | warms speed and polish scores | Running |
| `security.yml` (Security scan) | Monday 15:00 UTC; lock-file pull requests; manual | scans dependencies | Running |
| `deploy.yml` (Deploy) | release tag; a push to main under `data/`; manual | deploys production | Running |
| `release.yml` (Release) | a `vX.Y.Z` tag; manual | publishes a release | Running |
| `ci.yml` (CI) | pull requests to main; manual | typecheck, lint, tests, Worker build | Running |
| `commits.yml` (Commit messages) | push to main; pull requests; manual | checks commit style | Running |
| `auto-merge.yml` (Auto-merge) | update pull requests, and after CI | merges Dependabot and kit updates | Running |
| `direct-push.yml` (Direct push alarm) | push to main; tags; deletes | reports a push that skipped a pull request | Running |

Dependabot (`.github/dependabot.yml`) opens pull requests daily for release-kit and weekly for other packages.

### Worker crons (`wrangler.jsonc` `triggers.crons`)

| Cron (UTC) | Group | Tasks, in order | State today |
| --- | --- | --- | --- |
| `30 3 * * *` and `30 4 * * *` | nightly | `night start` (only the one that is 20:30 Pacific acts) | Running |
| `15 * * * *` | hourly | the ten tasks in section 3 | Running, with the states in section 3 |
| `0 16 * * MON` | weekly | `goals`, then `model watch` | Running |
| `*/5 * * * *` | five-minute | `grader`, then `newsletter` | Off |

### Worker tasks

| Task | What it does | State today |
| --- | --- | --- |
| `night start` | starts the end-of-day Workflow | Running |
| `recheck start` | starts `recheck.yml` when due | Running |
| `owner removals` | applies removals held 24 hours | Running |
| `removal alerts` | alerts for held removals | Running |
| `edge purge` | clears cached pages | Running |
| `email caps` | alerts at 80% of a cap | Running |
| `night watch` | alerts when a night is missing | Running |
| `people queue` | finishes queued visitor requests | Running, idle while grading is Off |
| `tiers` | daily tier cutoffs | Running (letters hidden) |
| `review auto-apply` | applies passing review rows | Running (`REVIEW_AUTO_APPLY` true) |
| `image library` | one daily batch of images | Paused |
| `goals` | weekly goals email | Running |
| `model watch` | weekly model list check | Running |
| `grader` | report emails, stuck captures | Off (`GRADER_ENABLED`) |
| `newsletter` | sends posts through Kit | Off (`NEWSLETTER_ENABLED`) |

Other settings, per `wrangler.jsonc`: `RANKING_V2` false, `GAMES_V2` false, `TOOLS_ENABLED` false, `EMAIL_SIGNIN_ENABLED` false, `CONTENT_MODE` `dry-run`, `KIT_BROADCAST_MODE` `draft`, `POLL_GENERATION_ENABLED` false.

### Decided, not yet done

Nothing decided is still waiting in code.

Already removed: the monthly report to the community list; on 2026-11-22, the nightly "Record page changes" step, the weekly comparison of two Gemini versions (`grade-compare.yml`), the older AI votes in `judge-vote.yml`, the "grade changed sites" and "re-grades" night stages, and discovery's AI screen; and, also on 2026-11-22, the hourly change fingerprints (the `freshness` task and its `FRESHNESS_ENABLED` switch, which was never on in production).
Their tables stay, with what they hold: `rating_resets` and `site_fingerprints` are no longer written, and `site_freshness` keeps only `forced_at` in use (its fingerprint columns are no longer written or read).
Scheduled jobs run released code, so these stop in production only with the next release.

## 8. How to keep this page true

When a job changes, re-check the file that holds the truth, then change this page in the same pull request.

| If this changes | Re-check |
| --- | --- |
| a workflow's schedule, gate or steps | the file in `.github/workflows/` |
| a Worker cron or hourly task | `wrangler.jsonc`, `worker/crons.ts`, `worker/index.ts` |
| the night's order, caps or times | `pipeline/budget.mjs`, `pipeline/night.mjs`, `worker/night.ts` |
| a production switch | the top-level `vars` in `wrangler.jsonc`, and the GitHub variables |
| the free checks | `.github/workflows/sync-upstream.yml`, `pipeline/capture.mjs` |
| the health ladder | `pipeline/health.mjs`, `pipeline/not-working.mjs`, `pipeline/exclusions.mjs`, `pipeline/recheck*.mjs` |
| the removal rule | `lib/reviews/door.mjs`, `worker/review.ts` |
| owner removals | `lib/games/claims.mjs`, `worker/owner-removals.ts`, `pipeline/owner-removals.mjs` |
| ranking and tiers | `app/api/rank/route.ts`, `lib/tiers.mjs`, `worker/tiers.ts` |
| visitor reports | `lib/problem-reports/intake.mjs`, `lib/problem-reports/store.mjs` |
| visitor grading | `worker/grader.ts`, `.github/workflows/grade.yml`, `pipeline/people.mjs` |
| blog, polls, library, newsletter | `pipeline/content/**`, `pipeline/polls.mjs`, `worker/library.ts`, `worker/newsletter.ts` |
| discovery | `pipeline/discovery/**`, `.github/workflows/discover.yml` |

The hosted copy, for reading on a phone, is https://claude.ai/artifact/2gzd31YPe4qGn6ypKrjHHU.
It is updated by hand from this page, so this file is the one to fix first.
