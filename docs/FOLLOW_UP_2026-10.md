# Portfolio Rank follow-up, October 2026

A step-by-step plan for the open work found on 2026-10-25.
Work through the parts in order: Part A unblocks the grades that Parts B and C promise.
Each step says who does it, what to run or click, and how to check that it worked.

Repo: `n8watkins/portfolio-rank`.
Live site: https://portfoliorank.vercel.app.
Every push to `main` deploys to production on Vercel in about 45 seconds, so ship through PRs.

## What we found

- Issue #3 ("Scheduled job failed: Sync upstream + ingest") was caused by `ubuntu-latest` moving to Ubuntu 26.04 on 2026-10-22.
  Playwright 1.60 cannot install Chromium there, so every scheduled sync from 2026-10-22 to 2026-10-25 failed at the Playwright install step.
- PR #5 pinned the sync job to `ubuntu-24.04` (`.github/workflows/sync-upstream.yml`).
  The manual run [40244406862](https://github.com/n8watkins/portfolio-rank/actions/runs/40244406862) then passed and captured the backlog: its log says `done: 19 captured, 0 gated out`.
- **New: nothing has been graded since late July 2026.**
  The same run's grading step logged `rubric done: 0/300 judged, 5 API call(s)`, and every call failed with `gemini HTTP 401: API key not valid`.
  The daily vote job (`judge-vote.yml`) has failed the same way on every run checked from 2026-07-29 to 2026-10-25, while runs up to 2026-07-24 had no 401s.
  Both workflows stay green because `pipeline/judge.mjs` logs the errors, stops after 5 in a row, and exits 0.
  So the `GEMINI_API_KEY` repo secret is invalid (revoked or rotated), and new portfolios have had screenshots but no AI grade and no AI votes for about three months.
- Issues #2 and #4 are the same submission from Shubham Sinha (https://shubhamsinha1010.github.io/), sent on 2026-08-08 and 2026-10-24.
  The site answers HTTP 200 and is not in `data/feed.json`, `data/additions.json`, `data/excluded.json` or the upstream README.
- The issue form `.github/ISSUE_TEMPLATE/submit-portfolio.yml` asks for the label `portfolio-submission`, but that label does not exist in the repo.
  GitHub drops labels that don't exist, which is why #2 and #4 have no labels.
- Nothing turns a submission issue into an entry in `data/additions.json`.
  The FAQ (`components/FAQ.tsx`, "How do I get added?") still says a submission "flows in, gets screenshotted and graded automatically".
  The homepage (`app/page.tsx`) says "Submit it" takes 30 seconds with a GitHub account, which is true but implies the same.

## Part A - Get grading working again

- [ ] **Step 1. Confirm the key is the problem** (agent)

Run:

```bash
gh run view 40244406862 -R n8watkins/portfolio-rank --log | grep -c "HTTP 401"
gh run list -R n8watkins/portfolio-rank --workflow judge-vote.yml -L 1 --json databaseId --jq '.[0].databaseId' \
  | xargs -I{} gh run view {} -R n8watkins/portfolio-rank --log | grep -c "HTTP 401"
```

Verify: both counts are 5 (the abort threshold).
If either is 0, read that run's log before going on: the cause is something else.

- [ ] **Step 2. Create a new Gemini API key and store it** (owner)

1. Open https://aistudio.google.com/apikey and create a key in the project the free tier is on.
2. Run `gh secret set GEMINI_API_KEY -R n8watkins/portfolio-rank` and paste the key when asked.
3. Put the same key in `.env.local` as `GEMINI_API_KEY=...` for local pipeline runs.
   The key is not used by Vercel, so nothing changes there.

Verify: `gh secret list -R n8watkins/portfolio-rank` shows `GEMINI_API_KEY` updated today.
Then check the key itself without printing it:

```bash
set -a; . ./.env.local; set +a
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"
```

It should print `200`, not `400` or `401`.

- [ ] **Step 3. Make the grading jobs fail when the key is bad** (agent)

A bad key must turn the run red, so the existing "Notify on failure" step files an issue.
In `pipeline/judge.mjs`:

1. In `runRubric` and `runPairwise`, treat an HTTP 401 or 403 from Gemini as fatal: log it and exit with code 1 right away (no retries, it will not fix itself).
2. When either loop stops on "5 consecutive errors", exit with code 1 after the summary line instead of falling through to exit 0.
3. Leave a quota 429 that recovers inside the run as it is.

Verify locally, without touching the database:

```bash
GEMINI_API_KEY=not-a-key node pipeline/judge.mjs rubric --limit 1; echo "exit=$?"
```

It should print the 401 and `exit=1`.
Run `npx tsc --noEmit`, open a PR titled `fix(judge): fail the run when Gemini rejects the API key`, and let the owner merge it.

- [ ] **Step 4. Grade the backlog** (owner)

Run `gh workflow run sync-upstream.yml -R n8watkins/portfolio-rank`, then `gh run watch -R n8watkins/portfolio-rank` on the new run.

Verify: the grading step's last line reads `rubric done: N/300 judged` with N above 0, and the log has no `HTTP 401`.
The backlog is about three months of new sites, and grading is capped at 300 a day on a free-tier quota shared with voting, so it can take a few daily runs to finish.
The next day, check that the 13:00 UTC "Daily AI vote" run logs `pairwise done: N vote(s) cast` with N above 0.

## Part B - Close issue #3

- [x] **Step 5. Close #3 as fixed** (agent, done 2026-10-26)

Closed before Part A, at the owner's request, with a comment that says the sync is fixed and grading is not yet: it links this plan for the Gemini key.
Once Part A is done, add a short comment on #3 that grading works again (for example "Gemini key replaced; run <id> graded N sites").

Verify: `gh issue view 3 -R n8watkins/portfolio-rank --json state --jq .state` prints `CLOSED`.
The next scheduled sync (daily 06:00 UTC) should be green; if it fails, the workflow opens a new issue, because it only reuses an open one.

## Part C - Add Shubham Sinha's portfolio

- [ ] **Step 6. Create the submission label** (owner)

```bash
gh label create portfolio-submission -R n8watkins/portfolio-rank --color 0E8A16 --description "Portfolio submitted through the issue form"
gh issue edit 2 -R n8watkins/portfolio-rank --add-label portfolio-submission
```

Verify: `gh label list -R n8watkins/portfolio-rank | grep portfolio-submission` prints the label, and new submissions from the form get it automatically.

- [ ] **Step 7. Check the site is live and not listed** (agent)

```bash
curl -sL -o /dev/null -w "%{http_code} %{url_effective}\n" --max-time 15 https://shubhamsinha1010.github.io/
grep -ci "shubhamsinha1010" data/feed.json data/additions.json data/excluded.json
curl -fsSL https://raw.githubusercontent.com/emmabostian/developer-portfolios/master/README.md | grep -ci "shubhamsinha1010"
curl -s -o /dev/null -w "%{http_code}\n" "https://portfoliorank.vercel.app/p/https%3A%2F%2Fshubhamsinha1010.github.io"
```

Verify: the first line is `200` on an `https` URL, every count is `0`, and the detail page is `404`.
Also open the site in a browser and confirm it is a real portfolio page (not a parked or placeholder page).
On 2026-10-25 all of these held.

- [ ] **Step 8. Add the entry to `data/additions.json`** (agent)

The format is in `AUTOMATION.md` ("The list") and `pipeline/generate_feed.py`: a JSON array of `{name, url, tagline?}`.
`data/feed.json` is rebuilt as upstream minus `excluded.json` plus `additions.json`, deduped by normalized URL.
Use the tagline from #2 and the URL without a trailing slash, like the rest of the feed:

```json
[
  {
    "name": "Shubham Sinha",
    "url": "https://shubhamsinha1010.github.io",
    "tagline": "Python Backend & AI Engineer"
  }
]
```

Check the rebuild locally without committing `feed.json` (the sync job rebuilds and commits it):

```bash
curl -fsSL https://raw.githubusercontent.com/emmabostian/developer-portfolios/master/README.md -o /tmp/upstream-README.md
python3 pipeline/generate_feed.py /tmp/upstream-README.md /tmp/feed-check.json --exclude data/excluded.json --add data/additions.json
grep -c "shubhamsinha1010" /tmp/feed-check.json
```

Verify: the script prints `1 added` in its summary and the grep prints `1`.
Commit only `data/additions.json` on a branch as `feat(data): add Shubham Sinha's portfolio`, open a PR that says `Refs #2`, and leave the merge to the owner.

- [ ] **Step 9. Merge and run the sync** (owner)

Merge the PR from Step 8, then run `gh workflow run sync-upstream.yml -R n8watkins/portfolio-rank` and watch it with `gh run watch`.

Verify in the run log:

1. The "Commit refreshed feed.json" step made a `chore: sync portfolios from upstream` commit.
2. `git show origin/main:data/feed.json | grep -c shubhamsinha1010` prints `1` after `git fetch`.
3. The capture step's `done:` line counts at least 1 captured.
4. The grading step judged at least 1 site and logged no `HTTP 401`.

- [ ] **Step 10. Confirm it is live with a screenshot and a grade** (agent, then owner)

After Vercel deploys the sync commit (about a minute):

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://portfoliorank.vercel.app/p/https%3A%2F%2Fshubhamsinha1010.github.io"
```

Verify: `200`.
Then open that page in a browser at desktop and phone width and check that the hero screenshot loads (not a placeholder) and the AI review section shows a tier and axis scores.
If the screenshot shows but the grade does not, Part A is not done: go back to Step 4.

- [ ] **Step 11. Close #4 as a duplicate and answer #2** (owner)

```bash
gh issue close 4 -R n8watkins/portfolio-rank --duplicate-of 2 --comment "Thanks! This is the same portfolio as #2, so I'm tracking it there."
gh issue close 2 -R n8watkins/portfolio-rank --reason completed --comment "Sorry for the wait, Shubham. You're on PortfolioRank now, with a screenshot and an AI grade: https://portfoliorank.vercel.app/p/https%3A%2F%2Fshubhamsinha1010.github.io . It joins the face-offs and the leaderboard from here."
```

Verify: `gh issue list -R n8watkins/portfolio-rank --state open` no longer lists #2 or #4, and #4 shows "Closed as duplicate of #2".

## Part D - Submissions that really flow in

The site promises that a submission is screenshotted and graded automatically, but a person has to edit `data/additions.json`.
There are two ways to make the promise true.
The owner picks one in Step 12; the copy change in Step 13 ships either way until the bot is live.

- [ ] **Step 12. Decide: bot or copy** (owner)

- **Option 1, the bot (recommended):** Steps 14 to 19.
  A workflow checks each submission, comments the result, and adds the entry when the owner applies an `approved` label.
  The owner's only job per submission is one click.
- **Option 2, honest copy only:** keep the manual Part C process and make Step 13's copy permanent.

Write the decision here: ______

- [ ] **Step 13. Make the copy match what happens today** (agent)

In `components/FAQ.tsx`, change the "How do I get added?" answer from "it flows in, gets screenshotted and graded automatically" to:

> Submit it. Once it's approved, the next daily sync screenshots and grades it.

Keep the "Submit it" link as it is.
In `app/page.tsx`, keep "Submit it" and change the rest of that sentence to "Each submission is reviewed, then screenshotted and graded."
Write the new copy with a plain dash or a full stop, not the em dash the current copy uses.

Verify: `npx tsc --noEmit` passes, then run `npm run dev` and read the homepage footer and the FAQ at 1440 px and 390 px wide.
Ship it as `docs(site): say submissions are reviewed before they are added`.
If the bot ships (Option 1), change it back in Step 19.

- [ ] **Step 14. Add the validation library and its tests** (agent)

Add `scripts/submission/lib.mjs` with pure functions and no network calls in the parsing parts:

- `parseIssueForm(body)` reads `### Your name`, `### Portfolio URL` and `### Tagline (optional)` from the issue-form body, treating `_No response_` as empty.
- `normKey(url)` is an exact port of `norm_key` in `pipeline/generate_feed.py`: lowercase, drop `www.`, drop the trailing slash of the path.
- `checkSubmission({ url, feed, additions, excluded, fetchImpl })` returns `{ ok, reasons[] }` and rejects:
  - a URL that is not `https:`, has credentials, or points at an IP literal or `localhost`,
  - a site that does not answer 200 within 10 seconds (follow at most 5 redirects; the final URL must also be `https:`),
  - a URL whose `normKey` is already in `data/feed.json` or `data/additions.json` (a duplicate),
  - a URL whose `normKey` is in `data/excluded.json` (taken down; never re-add).

Add `scripts/submission/lib.test.mjs` using `node:test`, with a stubbed `fetchImpl`, covering each rejection, a clean pass, `_No response_`, and `www.`/trailing-slash/case duplicates.
Add a parity test that runs `python3 pipeline/generate_feed.py` on a tiny fixture README plus fixture additions and checks the bot's duplicate decision matches the feed builder's.
Add `"test": "node --test scripts/"` to `package.json` and a `npm test` step to `.github/workflows/ci.yml` after the typecheck.

Verify: `npm test` passes locally and on the PR.

- [ ] **Step 15. Add the intake workflow** (agent)

Add `.github/workflows/submission-intake.yml` and `scripts/submission/intake.mjs`.

- Trigger: `issues` with types `opened`, `edited` and `labeled`.
- Job `validate` runs when the issue has the `portfolio-submission` label and the event is not the `approved` label being added.
  It runs `intake.mjs validate`, which reads the issue from `$GITHUB_EVENT_PATH` and posts or updates one bot comment (find it by a hidden `<!-- submission-bot -->` marker) with a pass or the list of reasons.
  On a pass it says the owner will approve it; on a fail it says what to fix and that editing the issue re-runs the check.
- Job `approve` runs when the label added is `approved`, the issue also has `portfolio-submission`, and the sender is the repo owner (`github.event.sender.login == github.repository_owner`).
  It re-runs the checks (the site may have changed), appends `{name, url, tagline}` to `data/additions.json`, commits it as `feat(data): add <name>'s portfolio (#<n>)`, pushes to `main`, starts the sync with `gh workflow run sync-upstream.yml`, comments with the future detail-page link, and closes the issue as completed.
- Permissions on the workflow: `contents: read` by default; `validate` gets `issues: write`; `approve` gets `issues: write`, `contents: write` and `actions: write` (to start the sync).
- Concurrency group `submission-intake` with `cancel-in-progress: false`, so two approvals never race on `additions.json`; `approve` also does `git pull --rebase` before pushing and retries once.
- Security: the issue body is untrusted.
  Never put `${{ github.event.issue.* }}` inside a `run:` script; the script reads the event JSON from disk.
  Pin `actions/checkout` and `actions/setup-node` to the same versions the other workflows use.

`main` has no branch protection today, so the `GITHUB_TOKEN` push works.
A push made with `GITHUB_TOKEN` starts no other workflow, which is why `approve` starts the sync with `workflow_dispatch` explicitly.
Vercel's Git integration still deploys the commit.

Verify: `npx --yes actionlint` (or the actionlint binary) reports no errors, and `npm test` passes.

- [ ] **Step 16. Create the `approved` label** (owner)

```bash
gh label create approved -R n8watkins/portfolio-rank --color 1D76DB --description "Owner approved: the bot adds this portfolio"
```

Verify: `gh label list -R n8watkins/portfolio-rank | grep approved`.

- [ ] **Step 17. Document the flow** (agent)

In `AUTOMATION.md`, change the "Direct submission" row of the intake table from "Issue form -> `data/additions.json`" to describe the bot, add `submission-intake.yml` to the Actions table (and change "GitHub Actions (5)" to 6), and add a short "Submissions" section with the labels, the checks and the owner's one click.
Verify: the table's workflow list matches `ls .github/workflows`.

- [ ] **Step 18. Test the bot end to end** (owner, with the agent watching the runs)

1. Merge the PR from Steps 14, 15 and 17.
2. Open a submission through the live site's "Submit it" link with a URL that is already listed (pick one from `data/feed.json`).
   The bot should comment that it is a duplicate.
3. Edit the issue to an `http://` URL; the comment should update in place to say it must be `https`.
4. Close that test issue as not planned.
5. For the next real submission, check the bot's pass comment, then add `approved`.

Verify: the `approve` run commits to `main`, starts a sync run, comments the detail link and closes the issue; after the sync the detail page returns 200 with a screenshot and grade (same checks as Step 10).

- [ ] **Step 19. Restore the promise in the copy** (agent)

Once Step 18 passes, change the FAQ answer to: "Submit it. Once it's approved, it's screenshotted and graded on the next sync, usually within a day."
Verify with `npx tsc --noEmit` and a look at the FAQ at 1440 px and 390 px wide.

## Part E - Remove the Ubuntu 24.04 pin later

- [ ] **Step 20. Upgrade Playwright when it supports Ubuntu 26.04** (agent)

Check the Playwright release notes (https://playwright.dev/docs/release-notes) for Ubuntu 26.04 support.
The repo has `"playwright": "^1.60.0"` and installs 1.60.0; the latest stable on 2026-10-25 was 1.64.1.
Prove it on a real runner before relying on it: on a branch, run `npm install -D playwright@<version>`, and temporarily add a `workflow_dispatch` job on `ubuntu-latest` that runs `npx playwright install --with-deps chromium` and `node pipeline/capture.mjs --limit 1 --only shubhamsinha1010`.

Verify: that job passes on `ubuntu-latest` (26.04), and the local capture still works with `node pipeline/capture.mjs --limit 1 --only shubhamsinha1010 --force`.
Remove the temporary job before the PR.

- [ ] **Step 21. Unpin the runner** (agent)

In `.github/workflows/sync-upstream.yml`, set `runs-on: ubuntu-latest` again and delete the "Pinned: ubuntu-latest moved to 26.04..." comment above it.
Ship it in the same PR as Step 20 (`build(deps): upgrade Playwright and run the sync on ubuntu-latest again`).

Verify: after merge, `gh workflow run sync-upstream.yml -R n8watkins/portfolio-rank` passes, its log shows the Playwright install and `done:` capture line, and the next 06:00 UTC scheduled run is green too.

## Also noticed

- Every workflow uses `actions/checkout@v4` and `actions/setup-node@v4` with `node-version: 20`, and runs now warn that Node 20 actions are deprecated.
  Moving to the current major versions and Node 22 is a small, separate PR.
- The takedown form (`remove-portfolio.yml`, label `takedown`) is also handled by hand; the Part D bot could later append to `data/excluded.json` the same way.
