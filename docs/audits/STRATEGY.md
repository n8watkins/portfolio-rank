# PortfolioRank strategy after the November 2026 audits

Written 2026-11-13 from the six audits in this folder.
Everything here waits for the owner's approval; until then all background Gemini spending in production is at 0 (see gemini-prompting.md for the switch and how to undo it).

## The audits

| Audit | File | PR |
|---|---|---|
| Gemini prompting and fixes | gemini-prompting.md | #148 |
| Blog engine | blog-engine.md | #142 |
| Release and staging | release-and-staging.md | #144 (with #143, #145, #146) |
| Free-tier limits | free-tier-limits.md | #150, #151 |
| Discovery pipeline | discovery-pipeline.md | #149 |
| Fresh eyes | fresh-eyes.md | #147 |

## What we learned, in one paragraph each

Gemini is the scarce resource, and grading uses 91% of it.
The grading prompt has known flaws: no described score levels, score before reason, the projects section often cut off, and a letter nobody should use any more.
Google counts its own "busy" errors against our daily quota, so retries are expensive.

The blog engine has never produced a passing draft: about 9 requests a draft, and the model rewrites the whole post at every step, losing length.
Code should build the structure and Gemini should write prose once.

Release is the biggest risk before going live: 17 open PRs, five schema versions, stacks with no CI, and staging that any merge to main can wipe.
Four PRs (#143 to #146) fix the mechanics.

Free tiers are mostly fine after #150, except Workers CPU, which is on pace for about 119% of the account's included 30M ms this month (n8builds-web uses 35% of it).

Discovery is built and free, but the real bottleneck is grading capacity: at 10 graded discovered sites a day, 4,000 sites take over a year.

Fresh eyes found four high-severity gaps: no alert email in production, dead nightly runs go unnoticed, the old "use the free tier" grade path can spend Gemini from a visitor request, and no privacy page is live.

## Priorities

### P0: protect the site and the free tiers (this week, no Gemini)

1. Workers CPU: find what in n8builds-web burns CPU, and land long edge caching for PortfolioRank pages (BOTS-AND-SEO, profile phase 2), so crawls stop costing CPU.
2. Alerts: set OWNER_EMAIL on the production Worker; make a missed or dead nightly run raise an alert.
3. Privacy: publish /privacy, /terms and a removal path; add an expiry rule to backups so the 30-day promise is true.
4. Land #150 (Turso writes only changed rows; captures stop storing the unused full-page image).
5. Close the visitor-to-Gemini gap in the old grade path before GRADER_ENABLED is ever turned on.

### P1: release foundation (this week, no Gemini)

1. Land #143 (schema by fingerprint), #146 (test ports), #144 (staging = main plus PRs labelled staging), #145 (staging fidelity).
2. Then land the rest in the order in release-and-staging.md, each behind a flag that stays off in production.
3. Turn flags on in production one at a time, a day apart.

### P2: grading rebuilt, measured against the owner's judgment

1. Owner answer key: about 40 portfolios sorted by the owner (about 15 minutes, no Gemini).
2. Rubric v3: reason before score, described levels for every score, a code-built excerpt that always includes the projects, no Gemini letter, role-aware wording, a "how to improve" line per axis.
3. Experiments (below) decide v3 and batching.
4. Re-grade the library once with the winner; starting ranks become a blend of the report-card score and the check points.

### P3: blog rebuilt (code-built structure, about 3 requests a post), then the newsletter

### P4: discovery switched on, paced by grading capacity

### P5: profile and SEO phase 2 (readable profile addresses, sitemap index, structured data)

## What can continue now without Gemini

- All of P0 and P1.
- The blog rebuild, tested only against a fake Gemini.
- Discovery's free stages (collect, check, filter) on staging.
- Profile phase 2.
- Building the answer-key page.

## Where Gemini goes after the freeze

Daily free allowance is about 500 requests on 3.5 and a separate allowance on 3.1, and busy errors count, so plan to use at most 70%.

| Job | Model | Requests a day | Notes |
|---|---|---|---|
| Grading new and changed sites | 3.5 | about 80 to 150 | 5 sites a request if experiment B passes, so 400 to 750 sites a day |
| Experiments | 3.5 | up to 80 while they run | Reserved, then released to grading |
| AI head-to-heads at tier boundaries | 3.5 | about 20 | Only where precision matters (SSS, S, A edges) |
| Blog | 3.5 | about 1 averaged (about 6 a week) | After the rebuild |
| Image library | 3.5 | about 5 | Only when a post needs an image |
| Discovery AI screen | 3.1 | about 20 to 50 | 20 sites a request; first catch-up about 340 once |
| Headroom for busy errors | 3.5 | about 150 | Never planned for work |

Re-grades stay off until v3.

## Priority experiments

| Order | Experiment | Question | Cost | Decides |
|---|---|---|---|---|
| 0 | Owner answer key | What does the owner think is better? | none | The yardstick for everything below |
| 1 | v2 vs v3 rubric | Does v3 agree with the answer key more, and with itself? | about 160 on 3.5 | Which rubric grades the library |
| 2 | Solo vs batch of 5, on v3 | Do scores stay steady when graded 5 at a time, and is the batch's order right? | about 60 | Grading speed (5 times) and free comparisons |
| 3 | Richer evidence | Do phone and projects screenshots improve agreement? | about 80 | What evidence every grade gets |
| 4 | Starting-rank blend | Which mix of report-card score and check points best matches the answer key? | none | The starting letter for every portfolio |
| 5 | Blog pipeline, 3 rounds of 2 | Does the new pipeline pass first time and read well? | about 20 | Blog goes live, newsletter starts |

Round 1 from 2026-11-12 (25 Gemini and 17 Sonnet runs on v2) is kept as a baseline in exp-batch.

## Decisions for the owner

Each has a recommendation; "go with the picks" approves all of them.

### Release
1. Staging = main plus PRs labelled staging (#144). Pick: yes.
2. The new ranking (#132, #137) goes behind RANKING_V2. Pick: yes.
3. Email sign-in (#124) gets its own flag. Pick: yes.
4. Staging gets its own Gemini key. Pick: yes.
5. Weekly staging refresh from production's backup (clears staging-made data). Pick: yes.
6. Require Worker build and E2E checks on main. Pick: yes.

### Cost and limits
7. Delete 2,269 unused full-page screenshots (567 MB). Pick: yes.
8. Expire old page-cache builds. Pick: yes.
9. Tier refresh every 6 hours instead of hourly. Pick: yes.
10. A Turso platform token for the daily usage snapshot. Pick: yes.

### Product and privacy
11. Approve the "Add your portfolio" and profile screenshots. Pick: review first.
12. Privacy wording: "Checking a site adds it to PortfolioRank; you can ask for removal at any time." Pick: yes.
13. "Remove my portfolio" also for sites still waiting to be graded. Pick: yes.
14. Starting rank = 60% report-card score, 40% check points, refined by votes, after experiment 4 confirms. Pick: yes.
15. AI votes count at one quarter of a person's vote, only at tier boundaries. Pick: yes.

### Bots and SEO
16. Let verified search bots past the flood rule. Pick: yes.
17. AI crawlers: allow search and assistants, block training, block SEO-tool crawlers. Pick: yes.
18. Register Google Search Console and Bing Webmaster (one DNS record). Pick: yes.

### Discovery
19. Switch on the AI screen after the freeze (about 340 requests on 3.1 once). Pick: yes.
20. Hand-off pace to grading follows grading capacity (start at 50 a day). Pick: yes.

### Now
21. Resume the paused nightly run for its free work only (grading and all Gemini stay at 0). Pick: yes.
22. Build the owner answer-key page. Pick: yes.

### Domain
23. Make the site address one setting now (links, sitemap, share cards, email sender), and move PortfolioRank to its own domain at go-live, before profiles are indexed, with portfoliorank.n8builds.dev redirecting and a "built by n8builds" link kept. Costs about $10 to $15 a year through Cloudflare Registrar. Pick: yes.
