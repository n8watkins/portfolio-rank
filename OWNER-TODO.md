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
- [ ] Turso login in pass-env, for the recompute and restore commands: `pass-env set portfolio-rank/TURSO_DATABASE_URL` and `pass-env set portfolio-rank/TURSO_AUTH_TOKEN`.
- [ ] Before the public grader launches: a paid Gemini key (billing on this project, with a budget alert).
- [ ] Optional: `SENTRY_AUTH_TOKEN` secret and `SENTRY_ORG` / `SENTRY_PROJECT` variables for readable error traces.
- Turnstile keys need nothing from you: the agent can create the widget through Cloudflare.

## Commands to run once

- [ ] Staging setup: a Turso login, the staging database filled from last night's backup, and a staging GitHub OAuth app (`DEPLOY.md`, "Setting staging up", steps 1 to 4; an agent can do steps 3 and 5 once the pass entries exist).

- [ ] Restore test: restore last night's backup into a scratch database and compare counts (steps in `docs/ASSUMPTIONS.md`, section G, once merged).
- [ ] Ratings recompute, when the new leaderboard switches on: `pass-env run -- node scripts/recompute-ratings.mjs --read-only`, then without `--read-only`.
- [ ] Turn on the full re-grade (`RUBRIC_REGRADE=true`) after the 3.5-only nightly runs look clean.
- [ ] Re-read the Gemini free-tier limits for this project in AI Studio (the 500 a day per model isn't in Google's public docs).

## Whenever convenient

- [ ] Legal placeholders in `docs/legal/`: contact email, jurisdiction, minimum age (13 or 16), how long data is kept.
- [ ] Optional vote guards: `HUMAN_MAX_DRAWS_PER_DAY`, `MIN_GITHUB_ACCOUNT_AGE_DAYS` (off now).
- [ ] HSTS preload: whether to submit the domain to browser preload lists.
- [ ] Later: $25 one-time for a Google Play developer account (a 12-tester, 14-day closed test comes first for new personal accounts).
