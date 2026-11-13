# Release and staging audit

Audit of how work reaches staging and production, and whether staging is a faithful test bed.
Written 2026-11-12 from `origin/main` at `0293697` and the open pull requests at that time.
Each action item carries a status: **done**, **in progress** or **needs owner**.

## Problems found

1. Every lane hand-merges into one shared branch, `preview/staging-all`, which now carries 146 commits and about 30 merge commits on top of main, and lanes collide mid-merge.
2. Any push to main redeploys staging with main alone (`deploy.yml` ran staging first, then production), so a merge to main, including the bot's automatic data syncs (#120), silently wipes what lanes put on staging.
3. Seventeen open pull requests (#123 to #141), most of them drafts, in two long stacks, with five different `SCHEMA_VERSION` values (11 to 17) and seven branches that edit `tests/content.test.mjs`.
4. Schema versions are picked by hand per branch, and the comments in the branches disagree on the rule ("whichever lands second takes the next number" against "numbers only have to grow, so 16 is safe whichever lands first").
   With the old code a lower-numbered branch landing after a higher one never migrated at runtime, and every deploy wrote its own number back, so a main deploy lowered staging's recorded version from 17 to 12.
5. CI runs only on pull requests into main (`ci.yml` `branches: [main]`), so the stacked pull requests (#127, #129, #131, #134, #137) get no typecheck, Worker build or E2E until they are retargeted.
6. Five pull requests fail the "Commit messages" check only because their titles pass 100 characters once the squash merge adds ` (#NNN)`: #125, #131, #137, #138, #140.
7. The E2E runner used fixed ports (7691 to 7694) and one shared server log, so two agents running E2E at once tested against each other's server and could pass or fail on someone else's build.
8. Staging's database is a production copy from 2026-11-10 that predates full backups (only `votes`, `ratings` and part of `portfolios`), and nothing refreshes it.
9. Staging runs no scheduled jobs, so tiers and leaderboards refresh only when someone deploys or runs a script by hand, and "Write a draft now" refuses outside production.
10. Staging has the `SEND_EMAIL` binding and a database with real people's addresses, so any scheduled email job on staging could reach real people.

## Current map of open pull requests

Schema is the `SCHEMA_VERSION` on the branch (main is 12).
"Contains" lists other open branches whose commits the branch already holds.
CI is the state at the time of writing; "title" means only the title-length check fails.

| PR | Branch | Base | Draft | Schema | Flags it adds or reads | Contains | CI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #123 | play/compact-faceoff | main | yes | 11 (stale) | none | part of rank-tiers | green |
| #124 | feat/email-signin | main | yes | 13 | none (no flag) | | green |
| #125 | feat/admin-usage | main | no | 12 | none | | title |
| #127 | feat/admin-controls | feat/admin-usage | yes | 14 | `CONTENT_DRAFTS_PER_WEEK` | #125 | no CI (stacked) |
| #129 | feat/admin-layout | feat/admin-controls | yes | 14 | `CONTENT_DRAFTS_PER_WEEK` | #125, #127 | no CI (stacked) |
| #134 | feat/admin-overview | feat/admin-layout | no | 14 | none new | #125, #127, #129 | no CI (stacked) |
| #131 | feat/blog-owner-feedback | feat/admin-layout | yes | 14 | `CONTENT_MODE` | #125, #127, #129 | title, no CI |
| #130 | feat/check-freshness | main | yes | 15 | none (no flag) | #125 | green |
| #133 | feat/newsletter | main | yes | 16 | `NEWSLETTER_ENABLED` (off), `MAILROOM` | #124, #125, #127, #129, part of #131 and #134 | green |
| #132 | feat/rank-tiers | main | yes | 12 | none (no flag) | part of #123 | green |
| #137 | feat/tiers-elo | feat/rank-tiers | no | 12 | reads `RANKING_V2` | #132 | title, no CI |
| #136 | feat/free-tools | main | yes | 17 | `TOOLS_ENABLED` | | green |
| #138 | fix/grade-turnstile-tick | main | no | 12 | none | | title |
| #140 | feat/add-portfolio | main | yes | 17 | `TOOLS_ENABLED` | #132, #136, #137, #138, part of #123 | title, E2E pending |
| #135 | play/shell-links | main | yes | 12 | none | | green |
| #139 | docs/bots-seo | main | yes | 12 | none | | green |
| #141 | exp/batch-grading | main | yes | 12 | none | | green (one experiment script) |

Two stacks and five loose pull requests:

- **Admin and blog stack:** #125 then #127 then #129, then #134 and #131 on top; #133 (newsletter) sits on top of that stack and #124 (email sign-in).
  #130 (check freshness) also carries #125.
- **Ranking and tools stack:** #132 then #137, then #140 (add portfolio) on top, which also carries #136 (free tools) and #138; #123 overlaps #132.
- **Loose:** #135, #138, #139, #141 and #124.

Production flags today (`wrangler.jsonc`): `GRADER_ENABLED`, `GAMES_V2` and `RANKING_V2` are `"false"` in production and `"true"` on staging; `CONTENT_MODE` is `"dry-run"` in production and `"off"` on staging; `NEWSLETTER_ENABLED` and `TOOLS_ENABLED` exist only on their branches.

## How work reaches staging from now on

Staging is main plus every open pull request labeled `staging`, rebuilt automatically (`.github/workflows/staging.yml`, this pull request).

- It recomposes whenever main moves, a pull request gets or loses the label, or a labeled pull request gets new commits, so a merge to main never wipes staging.
- The labeled pull requests merge onto main in pull request order; one that conflicts is left out, named in the run summary and told in a comment, and the rest still deploy.
- Label the top of a stack (#140, #133, #134), since it carries its bases.
- Production deploys only from main (`deploy.yml`), no longer waits for a staging deploy of main, and keeps its own migration and smoke check.
- `preview/staging-all` is retired once the label replaces it: label #133, #134, #140, #135 and #123 to reproduce today's staging.

Why not the alternatives: deploying main with flags on to staging would show nothing that is still in review, and a long-lived integration branch is exactly what collides today.

## Go-live plan

Land on main in small steps, each pull request rebased on main and retargeted to main just before it lands, so CI runs on it.
Every feature that changes what visitors see stays behind a flag that is off in production, and each flag is switched on in its own small pull request after a day on staging.
With the schema fingerprint (below), the order no longer matters to migrations; each branch just keeps its tables in its own `lib/<feature>/schema.mjs` and adds one line to `lib/schema.mjs`.

**Wave 0: the release machinery (this audit).**

1. E2E ports (#146).
2. Schema fingerprint (#143).
3. Staging composition and this document (#144).
4. Staging fidelity (#145).

**Wave 1: small and invisible (no schema, no flag needed).**

5. #138 grade Turnstile tick (grader is off in production; shorten the title first).
6. #135 shell links (performance only).
7. #139 bots and SEO (docs only).
8. #125 admin usage page (admin only; shorten the title first).

**Wave 2: the admin and blog stack, admin-only surfaces.**

9. #127 admin controls, then #129 admin layout, then #134 admin overview, then #131 blog owner feedback, each retargeted to main after its base lands.
   `CONTENT_MODE` stays `dry-run` in production, so nothing publishes on its own.

**Wave 3: new tables, features off.**

10. #130 check freshness (changes when the nightly checks re-run; no flag, so watch the first night's run).
11. #124 email sign-in (adds a visible sign-in option with no flag; needs owner decision D3).
12. #133 newsletter with `NEWSLETTER_ENABLED` off.

**Wave 4: ranking, tiers and tools.**

13. #123 compact face-off (rebase on main; it carries schema 11 from an older main).
14. #132 rank tiers, then #137 tiers from face-off votes, behind `RANKING_V2` (owner decision D2).
15. #136 free tools, then #140 add portfolio, with `TOOLS_ENABLED` off.

**Wave 5: switch features on in production, one flag per pull request, a day apart.**

16. `RANKING_V2`, then `GAMES_V2`, then `GRADER_ENABLED` (needs `TURNSTILE_SITE_KEY` in `wrangler.jsonc` and the redesign pages), then `TOOLS_ENABLED`, then `NEWSLETTER_ENABLED`.

#141 (batch grading experiment) is an experiment script and should not land on main unless the owner wants it kept (D6).

## Owner decisions needed

- **D1. Production no longer waits for staging.** Production deploys from main after CI, with its own migration and smoke check, while staging composes main plus labeled pull requests in its own workflow. The alternative is to keep production waiting for a staging deploy of main alone, which would put main back on staging after every merge. Recommended: accept. Status: decided 2026-11-12, accepted; live with #144.
- **D2. Tiers behind a flag.** #132 and #137 change the public leaderboard with no flag of their own. Recommended: gate them behind `RANKING_V2` (already on in staging). Status: decided 2026-11-12, behind `RANKING_V2`.
- **D3. Email sign-in behind a flag.** #124 adds a visible sign-in option with no flag. Recommended: add `EMAIL_SIGNIN_ENABLED`, off in production. Status: decided 2026-11-12, its own flag, off in production.
- **D4. A staging Gemini key.** Staging now runs production's schedule, and "Write a draft now" works there, but only with its own key from a separate Google project (`portfolio-rank/STAGING_GEMINI_API_KEY`), held to a tenth of production's day. Without it every Gemini job on staging skips. Status: decided 2026-11-12, a separate staging key; the owner creates `portfolio-rank/STAGING_GEMINI_API_KEY`, and until then Gemini stays off on staging.
- **D5. Staging email allowlist.** Staging only emails the addresses in `STAGING_EMAIL_TO`, which is empty. Add your own address in `wrangler.jsonc` to receive staging's emails. Status: needs owner.
- **D6. Experiment and docs pull requests.** Close #141 or keep it as a script; land #139 or move it to the private notes. Status: decided 2026-11-12, #141 does not land; docs pull requests (#139, #142, #147, #152) land only when the owner asks.
- **D7. Weekly staging refresh.** The "Staging data" workflow replaces staging's data with production's newest backup every Monday, which also throws away anything made on staging that week. Recommended: weekly; monthly is the minimum for retention. Status: decided 2026-11-12, weekly.
- **D8. Require CI on main.** Add "Worker build" and "E2E" to the main ruleset (already approved in docs/DECISIONS.md, not yet done). Status: done; the main ruleset already requires Worker build and E2E (checked 2026-11-12).

## Action items

| # | Item | Status |
| --- | --- | --- |
| A1 | E2E runs take free ports and their own server log, and stop if their server did not start (#146) | done (#146, merged 2026-11-13; #178 makes a taken stand-in port fail fast, #186 keeps test runs off remote Cloudflare and leaves no workerd) |
| A2 | Schema migrates on a fingerprint of its statements, and the recorded version never goes down (#143) | done (merged 2026-11-12, deployed; fingerprint s1b8821ed recorded on staging and production) |
| A3 | Staging is main plus pull requests labeled `staging`, rebuilt on every change; production deploys alone (#144) | done (merged 2026-11-12) |
| A4 | The `staging` label exists | done |
| A5 | Staging runs production's crons under low Gemini caps, "Write a draft now" works there with its own key, staging email is allowlisted (#145) | done (#145, merged 2026-11-13; staging's hourly jobs run every six hours and the grader's tick every 30 minutes to keep its CPU low) |
| A6 | Weekly staging refresh from production's newest backup and six-hourly leaderboard rebuild (#145) | done (#145; the first refresh runs on Monday) |
| A7 | Shorten the titles of #125, #131, #137, #138 and #140 to 100 characters with the ` (#NNN)` suffix | done (the five titles were shortened or the pull requests landed under shorter titles) |
| A8 | Retarget stacked pull requests to main as their bases land, so CI runs on them | done for the admin stack (landed as one squash, #134, with #125, #127 and #129 closed as landed there) |
| A9 | New tests go in per-feature files instead of `tests/content.test.mjs`, which seven branches edit | needs owner (lane owners) |
| A10 | Label #133, #134, #140, #135 and #123 `staging` once #144 lands, then stop using `preview/staging-all` | changed: the per-PR labels do not compose yet (the two stacks conflict with each other), so staging runs main plus the integration pull request #158 (`preview/staging-all`, never merged), kept current with main until the stacks land |
| A12 | Staging's concurrency sits on the job, so a skipped run (an unlabeled pull request closing) no longer cancels a real deploy; this cancelled the first composed deploy after #144 | done (#154, merged 2026-11-12) |
| A13 | Make the site address one setting (`SITE_URL` for links, sitemap, canonical, Open Graph and the email sender) | done (#163, merged 2026-11-13) |
| A14 | A labeled pull request that conflicts keeps staging as it was instead of being dropped (#162) | done (#162, merged 2026-11-13; it has since kept staging intact through several conflicting merges) |
| A15 | Main merged into every stack branch and conflicts resolved (rank-tiers, tiers-elo, add-portfolio, admin-controls, admin-layout, admin-overview, blog-owner-feedback, email-signin, newsletter, worker-cpu) | done 2026-11-12 |
| A16 | Build caches pruned after each deploy (#172) | done (first runs removed 100 builds, 478.7 MB in production and 125 builds, 1,098.5 MB on staging) |
| A11 | Owner decisions D1 to D8 | done except D5 |

## Progress log

- 2026-11-12: merged #143 (schema fingerprint), #144 (staging composition), #154 (staging concurrency), #153 (night dead-man alert) and #157 (edge cache for days); each production deploy and smoke check passed.
- 2026-11-12: staging restored to all in-flight work through #158, including the latest #140 (add portfolio) and #149 (discovery, its screen and hand-off off).
- 2026-11-12: merging #155 (privacy pages, owner-approved) was refused by the agent's permission check ("merge without review"); the owner has to merge it or allow agent merges. Queue after it: #159, #160, #161, #156, #146, #145, #162, then #163 (held for the owner's Turnstile and zone setup).
- 2026-11-13: #163 (portfoliorank.dev, `SITE_URL`) landed; main merged into #158 with `SITE_URL` kept, and the in-flight code that still read `AUTH_URL` or the old host moved to `SITE_URL` on the integration branch (the lane branches still need it when they merge main).
- 2026-11-13: #164 (newsletter on Kit, stacked on #133) merged into #158; staging at https://staging.portfoliorank.dev passes the smoke check.
- 2026-11-13: the owner approved landing everything with new features off ("get it all set up, have it disabled"). Landed since, each with a production deploy and smoke check: #155, #159, #160, #161, #134 (with #125, #127 and #129), #151, #176, #156, #146, #145, #162, #179, #181, #180, #172, #148, #150, #178, #186 and #167.
- 2026-11-13: held from production because they change what visitors see with every flag off: #137 (tiers, which also carries #132, #123's compact face-off and the report redesign) and #131 (the blog layout). The tiers lane is making a tiers-only pull request gated on `RANKING_V2`, and the blog lane an engine-and-admin pull request with no public change; the layout and the face-off stay on staging for the owner's walkthrough.
- 2026-11-13: in progress, in order: #168, #169, #170, #173, #174, #165, #166, #171, #175 and #177, then #182, #183 and #184 after #140, and the tiers-only and blog-engine pull requests when they exist.

## Risks

- **Labeled pull requests build with the repository's secrets.** The staging workflow runs on `pull_request_target` and builds labeled branches of this repository only (never forks), and only a maintainer can add the label.
- **Conflicts leave a pull request off staging.** The run summary and a comment say so; the fix is a rebase, not a hand-merged shared branch.
- **Production loses its staging rehearsal of main.** CI's Worker build, E2E and production's own smoke check remain; see D1.
- **Mixed code versions on one database.** During a deploy an old and a new isolate may each migrate once, because their fingerprints differ; every migration is additive and idempotent, so this costs a few queries and changes nothing.
- **Staging refresh drops staging's data.** The refresh refuses production's address and any address that does not name staging, reads only the backups bucket and never connects to production.
- **Staging scheduled jobs.** Without a staging Gemini key they skip; with one they are capped at a tenth of production's day; they never get `GITHUB_DISPATCH_TOKEN`, and email reaches only `STAGING_EMAIL_TO`.
- **Stacks drift.** #140 already carries four other pull requests; landing the stack bottom-up and retargeting each step keeps the diffs reviewable.
