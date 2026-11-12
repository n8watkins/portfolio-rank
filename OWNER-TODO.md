# Owner to-do: PortfolioRank

Everything on PortfolioRank that waits on the owner, updated 2026-11-10.
Other projects (Wren, net_trailers, keys elsewhere) are tracked separately in the ops repo: `follow-ups/2026-11-10-other-projects.md`.
Decisions and their reasons live in `docs/DECISIONS.md`; the plan in `docs/ROADMAP.md`.

## Decide now

- [ ] **Wave A**: start the back-end lanes the assumptions review doesn't affect (polls back end, content-engine design doc, model watch). Recommended: yes.
- [ ] **Grade my portfolio**: wait for the assumptions review. It found that a public grader needs Gemini's paid tier (EU, Switzerland and UK users; personal data on the free tier) and that capturing visitors' sites on GitHub's runners may break GitHub's terms.
  The Gemini part is decided (2026-11-10): free tier everywhere, no region blocking, a clear notice and a bring-your-own-key option (docs/DECISIONS.md); the GitHub runners question is still open.
- [ ] **Redesign preview** at http://localhost:7690 (branch `preview/redesign`): approve, or send changes.
- [ ] Guess the rank scoring (100 points for exact, zero at 4x off, "close" within 2x) and whether players guess the merged rank only or pick a view.
- [ ] Polls in the main nav. Recommended: no, footer and the phone "More" menu.
- [x] Staging site: approved 2026-11-10 and built at https://staging.portfoliorank.n8builds.dev; it needs the setup steps under "Commands to run once".
- [ ] Pause the daily AI face-off votes until the new ranking switches on. Recommended: yes.
- [x] Email provider for reports, alerts and the newsletter: Cloudflare Email Service for all email (decided 2026-11-10; SES dropped).
- [x] Require CI checks before merging: approved 2026-11-10.
  Your part: add "Worker build" and "E2E" as required status checks in the `main` ruleset (Settings, Rules, Rulesets); agents can't edit rulesets.

## Keys and tokens

New values go into pass-env with `pass-env set <entry>` in your own terminal; agents send them with `pass-env pipe`, never by value.

- [x] `GEMINI_API_KEY` (Actions): replaced 2026-11-10 and working.
- [x] `TURSO_AUTH_TOKEN`, `PSI_API_KEY`: replaced 2026-11-04.
- [x] `AUTH_SECRET` on the Worker; R2, Turso and sync secrets in Actions: set.
- [ ] `GITHUB_DISPATCH_TOKEN`: fine-grained token for this repo only, Actions read and write; `pass-env set portfolio-rank/GITHUB_DISPATCH_TOKEN`; the agent sends it to the Worker. Lets Cloudflare start the screenshot jobs on time.
- [x] Turso login in pass-env, for the recompute and restore commands: `portfolio-rank/TURSO_DATABASE_URL` and `portfolio-rank/TURSO_AUTH_TOKEN` are set and read production (checked read-only 2026-11-10).
- [ ] Before the public grader launches: a paid Gemini key (billing on this project, with a budget alert).
- [ ] Content engine keys (all optional; the engine runs without them, cutting outside claims and skipping stock photos), each from a free tier, set with `pass-env set <entry>`; the agent sends them to the Worker as secrets of the same name without the prefix:
  - `portfolio-rank/TAVILY_API_KEY`: a new PortfolioRank key (not Wren's) from https://app.tavily.com (free plan: 1,000 credits a month; the engine uses about 100).
  - `portfolio-rank/PEXELS_API_KEY`: from https://www.pexels.com/api/ (free: 200 requests an hour, 20,000 a month).
- [ ] Content engine dry run: switch `CONTENT_MODE` to `dry-run` in `wrangler.jsonc` when you want the week of private drafts to start, review them at `/api/admin/content`, then switch to `publish` by hand (docs/CONTENT-ENGINE.md).
- [ ] Optional: `SENTRY_AUTH_TOKEN` secret and `SENTRY_ORG` / `SENTRY_PROJECT` variables for readable error traces.
- [x] Turnstile widget `PortfolioRank`: created, and `TURNSTILE_SECRET_KEY` is on both Workers.
  The site key `0x4AAAAAAF8GDSY7kmBfRpoD` goes into `wrangler.jsonc` with the redesign (`DEPLOY.md`, "Grade my portfolio: owner steps", step 1).

## Commands to run once

- [x] Staging database: created, filled from the 2026-11-10 backup and wired to the staging Worker and the deploy workflow (`DEPLOY.md`, "Setting staging up", steps 1 to 3 and 5).
- [ ] Staging GitHub OAuth app (`DEPLOY.md`, "Setting staging up", step 4); an agent then sends the two values to the staging Worker (step 5).
  Until it exists the staging smoke check fails at sign-in, and that stops production deploys from main.
- [ ] Refresh the staging copy once a full backup exists (any from 2026-11-11 on): the 2026-11-10 one held only votes, ratings and part of portfolios.
  Delete `portfolio-rank-staging` in Turso and recreate it with a new token (step 2); an agent runs steps 3 and 5 again.

- [ ] Restore test: restore last night's backup into a scratch database and compare counts (steps in `docs/ASSUMPTIONS.md`, section G, once merged).
- [ ] Ratings recompute, when the new leaderboard switches on: `pass-env run -e TURSO_DATABASE_URL=portfolio-rank/TURSO_DATABASE_URL -e TURSO_AUTH_TOKEN=portfolio-rank/TURSO_AUTH_TOKEN -- node scripts/recompute-ratings.mjs --read-only`, then without `--read-only`.
- [x] Turn on the full re-grade (`RUBRIC_REGRADE=true`) after the 3.5-only nightly runs look clean (done 2026-11-11: night 2026-11-10 ran 403 of 418 requests, 0 failed, nothing parked).
- [ ] Re-read the Gemini free-tier limits for this project in AI Studio (the 500 a day per model isn't in Google's public docs).

## Whenever convenient

- [ ] Legal drafts in `docs/legal/`: contact email, governing law, minimum age and retention are filled in (2026-11-10); the few questions still open are listed in `docs/legal/README.md`.
- [ ] Optional vote guard: `HUMAN_MAX_DRAWS_PER_DAY` (off now). `MIN_GITHUB_ACCOUNT_AGE_DAYS` is 30 (votes, claims and owner actions).
- [ ] HSTS preload: whether to submit the domain to browser preload lists.
- [ ] Later: $25 one-time for a Google Play developer account (a 12-tester, 14-day closed test comes first for new personal accounts).
