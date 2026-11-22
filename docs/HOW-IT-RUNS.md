# How PortfolioRank runs

This page is the short answer to "what runs, when, and in what order".
It was checked against the code on main on 2026-11-21, release v0.6.0.
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
Production switches come from `wrangler.jsonc` (top-level `vars`, not the staging block).
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
- **Monday 10:00 (18:00 UTC)**: staging's data is replaced with production's newest backup (`staging-data.yml`).

Staging only: staging's ratings are rebuilt every 6 hours (`staging-data.yml`), and staging has its own two Worker crons that run only the tasks marked "staging" in `worker/crons.ts`.

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
8. **Tiers** (`tiers`, `worker/tiers.ts`): once a day, when due, finds the tier cutoffs and rewrites only the letters that changed.
   The other ticks that day do nothing.
   The letters stay hidden from visitors while `RANKING_V2` is false (per `wrangler.jsonc`).
   Running.
9. **Change fingerprints** (`freshness`, `worker/freshness.ts`): checks one 168th of the list a tick to see whether pages changed.
   Off (`FRESHNESS_ENABLED` is false, per `wrangler.jsonc`).
   Going, but not removed yet: "when checks re-run" (`lib/freshness.mjs`) uses the same fingerprints to decide when Lighthouse, polish, screenshots and link checks are measured again, so removing it waits for the owner.
   It never triggered a re-grade.
10. **Apply review decisions** (`review auto-apply`, `worker/review.ts`): applies waiting rows in the review queue that pass the owner's rule.
    On with `REVIEW_AUTO_APPLY` true (per `wrangler.jsonc`).
    Running.
11. **Image library** (`image library`, `worker/library.ts`): does something only in the UTC hour `LIBRARY_RUN_HOUR_UTC` (23, so 23:15 UTC, 15:15 Pacific in winter), and nothing in the other 23 hours.
    Its Gemini checks use the `library` AI budget, so it is Paused.

Staging runs only some of these (`owner removals`, `removal alerts`, `edge purge`, `tiers`, `review auto-apply`, `people queue`, and `grader`).
It does not start GitHub jobs, and its emails go only to its own test address.

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
   2. writes review rows for bot-walled sites that were never captured, and for listed sites whose portfolio signals collapsed;
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
| 4 | Image library (`library`) | nothing at night | 40 | 25 min | Off at night, see the hourly task 11 |
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
   It is the community list, minus our exclusions, plus our additions.
   Two guards refuse a list that shrinks by more than 5%, or that loses more than 15% of the current addresses.
   A refusal fails the run, which files an issue.
4. **The list change becomes a pull request that merges itself** (`sync-upstream.yml`, branch `data/sync-upstream`).
   A change under `data/` on main then rebuilds production's release over the new list (`deploy.yml`).
5. **Capture** (`sync-upstream.yml`, `pipeline/capture.mjs`).
   The database roster is synced first: rows not on the list are marked delisted, with a 15% safety limit.
   A browser then visits each new site, takes the screenshots, and saves the page text and the facts code can measure.
   The same step re-captures up to 150 older sites (`NIGHTLY_REFRESH`, per `wrangler.jsonc`).
6. **Capture checks** (same step, code only).
   A capture that does not show the site is never stored or graded:
   1. An error, a parked page or a blank page is retried on later nights, after 1, 2, 4, 8 and 16 days, then every 30 days.
   2. A bot wall is never graded.
      A site that was never captured gets a row on your review page at the night's plan step.
   3. A page with only a canvas or video is held back and marked for review, but no review row is written for it yet.
      The fix is open as #266.
   4. A re-capture of a site that already has a good capture never replaces or fails it: the site waits 1, 2, 4, 8, 16 then 30 days before the next try (`refresh_failures`).
      From the next release, a re-capture that meets a bot or security check, or a gate, loader, dialog or mode picker still covering the page, also puts the site on your review list (`needs_review`), the same as a first capture.
      A bot check seen only on the phone-size visit, after the desktop view showed the site, does not: it stays a refresh failure with that reason.
   5. From the next release, a re-capture that lost a résumé, GitHub or contact link the old capture had, or most of its text, is recorded (`capture_changes`).
      A change that comes with new measuring code (a new `facts.v`) is recorded as the code's, not the site's.
   All of these are listed on the Capture problems page (see "Keeping watch").
7. **More free measuring** (same workflow, in this order): tall page images for older captures (up to 100 a night), page text and facts for sites waiting for a grade (up to 300), and project link checks that are due (up to 120).
8. **Grade** (night stage 1, `grade_new`).
   One Gemini request with the screenshot, the page text and the facts.
   It answers how good the site is and whether it is a portfolio.
   A stored screenshot that does not show the site is checked first and set aside.
   Paused.
9. **The removal rule** (the same moment, `lib/reviews/door.mjs` `doorDecision`, `atTheDoor`).
   Every AI grade goes through it:
   1. You ruled on the site before: your verdict stands.
   2. Gemini says portfolio: it is listed with its report card.
   3. Gemini says not a portfolio, the code finds fewer than 4 of 6 portfolio signals, and nothing earlier argues for the site: a removal is recorded.
      A junk rule that fires (`pipeline/junk-rules.mjs`) also lands here, even with 4 or more signals.
   4. Gemini says not a portfolio but the code finds 4 or more signals, or never measured them: the site stays listed and a row waits for you.
   5. You undid an earlier removal, a rule once listed the site, an earlier grade said portfolio, or another case is waiting: the site stays listed and waits for you.
10. **Apply the removal.**
    With `REVIEW_AUTO_APPLY` true (per `wrangler.jsonc`), the night applies a recorded removal at once.
    The hourly task (hourly task 10) applies any that were left waiting, and also confirms waiting relist rows when both graders say portfolio.
    Every automatic decision shows on your review page with Undo.
11. **Starting rank** (`lib/tiers-store.mjs` `rankForWrite`, as the grade is written).
    The site's starting place in the tiers comes from the code checks, not from Gemini's letter.
    Votes move it from there.
    Tier letters are hidden from visitors while `RANKING_V2` is false, so the leaderboard visitors see today is the older votes board.
12. **After that** the site takes part in votes and gets the nightly health check.
    It is not graded again, except for one fresh grade after you undo or reject a removal, a re-grade its owner asks for (graded once, after a new capture), and the manual tools.

### A site stops working

1. **Nightly health check** (`health.yml`, `pipeline/health-check.mjs`, started by the night).
   Every listed site is loaded.
   On a first failed check the site is `suspect`: it leaves all AI work at once, but stays visible.
2. **Re-check after 1 hour** (`recheck.yml`, `pipeline/recheck-run.mjs`, started by the hourly task).
   Up to 120 due sites a run, with a 20 minute limit.
   Five sites that were live are loaded beside them.
   If fewer than 3 of those load, the checker is at fault, nothing is recorded, and the run fails.
3. **Re-check the next day.**
   Still failing: the site is not working.
   It is hidden from browse, search, the leaderboard, the games and the sitemap, and its profile page answers "not found" (`lib/hidden.mjs`).
   Nothing is deleted.
4. **Keep re-checking** (hourly, when due): daily for the first 7 days, weekly to day 30, then monthly.
   A check that passes brings the site straight back.
5. **Day 90.**
   One more check is made on day 90.
   Only a check made on or after day 90 that fails takes the site off the list.
6. **The weekly export** (`health.yml`, `pipeline/exclusions.mjs`, every 6 or more days).
   The site is added to `data/excluded.json` and dropped from the list, through a pull request (`data/health-exclusions`) that merges itself, at most 10% of the list at once.
   Removed sites are re-checked later (days 7, 14 and 21, then monthly) and come back when they pass.
7. **Delisted rows are purged** (`health.yml`, `pipeline/purge-delisted.mjs`): a row off the list for 30 days is deleted with its screenshots.
   Votes and ratings stay.

No one is emailed at any step.
A site the check could not tell about for 28 days gives you an alert on the alerts page.
A different path exists for a site that answers with the wrong thing (parked, blank, a duplicate): 3 failed checks, a week apart, spanning at least 13 days.

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

### Ranking

The grade is Gemini's report card, from one look.
The rank is a number that moves with face-off votes.

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
5. **Images** (hourly task 11, once a day at 15:15 Pacific, `worker/library.ts`).
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
   A manual run works, and points at the staging database unless `DISCOVERY_TARGET` is `production`.
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
| a failed run | The others file nothing: `grade.yml`, `security.yml`, `staging-data.yml`, `staging-capture.yml`, `regrade-not-portfolio.yml`. | Running |
| hourly | Night watch: an alert when last night's run never started or died. | Running |
| hourly | Email caps: an alert at 80% of a cap. | Running |
| after each night | Owner alerts: quota used up, a stage stopped, parked items, traction, a missing or expiring dispatch token. | Running |
| after each night | Owner alerts: one line with the open capture problems per group and the page's link, while a count is above zero or changed (`lib/capture-problems.mjs`). Never on staging. | Off until the next release |
| any time | The Capture problems page (`/admin/capture-problems`): A a re-capture failed and the old capture is kept, B a first capture failed, C the stored capture is a bot check or has under 200 characters of text, D a re-capture got worse. Each row has its reason, capture date and thumbnail, Gemini's grade, the health state and whether it is on your review list. | Off until the next release |
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
| `staging-data.yml` (Staging data) | every 6 hours; Monday 18:00 UTC; manual | staging's data and ratings | Running (staging secrets not confirmed) |
| `staging-capture.yml` (Staging capture) | manual only | captures a sample on staging | Off |
| `staging.yml` (Staging) | push to main (not docs); labeled pull requests; manual | deploys staging | Running |
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
| `15 * * * *` | hourly | the eleven tasks in section 3 | Running, with the states in section 3 |
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
| `freshness` | weekly change fingerprints | Off (`FRESHNESS_ENABLED`), Going |
| `review auto-apply` | applies passing review rows | Running (`REVIEW_AUTO_APPLY` true) |
| `image library` | one daily batch of images | Paused |
| `goals` | weekly goals email | Running |
| `model watch` | weekly model list check | Running |
| `grader` | report emails, stuck captures | Off (`GRADER_ENABLED`) |
| `newsletter` | sends posts through Kit | Off (`NEWSLETTER_ENABLED`) |

Other settings, per `wrangler.jsonc`: `RANKING_V2` false, `GAMES_V2` false, `TOOLS_ENABLED` false, `EMAIL_SIGNIN_ENABLED` false, `CONTENT_MODE` `dry-run`, `KIT_BROADCAST_MODE` `draft`, `POLL_GENERATION_ENABLED` false.

### Decided, not yet done

Decided to be removed by the owner on 2026-11-21, and still in code:

- The hourly change fingerprints (hourly task 9, Off).
  "When checks re-run" uses the same fingerprints, so this waits for the owner's word on what replaces them.

Already removed: the monthly report to the community list; and, on 2026-11-22, the nightly "Record page changes" step, the weekly comparison of two Gemini versions (`grade-compare.yml`), the older AI votes in `judge-vote.yml`, the "grade changed sites" and "re-grades" night stages, and discovery's AI screen.
Their tables stay, with what they hold: `rating_resets` and `site_fingerprints` are no longer written.
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
| visitor grading | `worker/grader.ts`, `.github/workflows/grade.yml`, `pipeline/people.mjs` |
| blog, polls, library, newsletter | `pipeline/content/**`, `pipeline/polls.mjs`, `worker/library.ts`, `worker/newsletter.ts` |
| discovery | `pipeline/discovery/**`, `.github/workflows/discover.yml` |

The hosted copy, for reading on a phone, is https://claude.ai/artifact/2gzd31YPe4qGn6ypKrjHHU.
It is updated by hand from this page, so this file is the one to fix first.
