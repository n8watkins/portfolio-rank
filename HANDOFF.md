# HANDOFF — PortfolioRank

Read this + PLAN.md + GRADING_CRITERIA.md + DEPLOY.md in full before doing anything.
Do not re-ask the user anything answered here or there.

## What this is

PortfolioRank turns emmabostian/developer-portfolios (1,779-entry alphabetical README
of developer portfolios, no frontend anywhere) into a ranked, browsable site: humans
cast head-to-head "which is better?" votes (ELO), AI (Gemini Flash, 500 req/day free)
bootstraps rankings, and free APIs provide objective diagnostics. Owner: Nathan Watkins
(github n8watkins, n8builds.dev, ko-fi.com/n8watkins).

- Repo: https://github.com/n8watkins/portfolio-rank (public, standalone — NOT a fork)
- Data source: `data/feed.json`, mirrored from the user's fork
  github.com/n8watkins/developer-portfolios (kept for syncing upstream, which gets
  daily community PRs)
- Stack: Next.js 15 App Router + Tailwind v4 on port **7678** (`npm run dev`);
  Turso (libSQL) for all persistence; Auth.js + Cloudflare R2 planned (see PLAN.md
  stack table)
- **DEPLOYED: https://portfoliorank.vercel.app** (project `portfolio-rank`, Vercel scope
  natkins23s-projects; `portfolio-rank.vercel.app` without the hyphen-less spelling is an
  unrelated stock-portfolio app). **Auto-deploy IS live**: push to `main` → production in
  ~45s (GitHub connected via `vercel git connect`; domain added as a project domain so it
  follows every deploy). Deployment protection disabled via API so URLs are public.

## State (all verified working locally AND in production, pushed through commit 674aaab)

- **Auth.js GitHub sign-in + three-tier votes: LIVE** (commit a7e05c0). Anon voters get a
  sticky `pr_anon` cookie and 10 practice votes — logged with `rater_type='anon'` but they
  NEVER update the `ratings` table; then the sign-in gate. Signed-in votes are
  `rater_type='human'`, rater_id `gh:<github numeric id>`, and move official ELO. One vote
  per pair per rater (either direction, 409), 100/day limit (429), vote URLs restricted to
  the roster (403). `/votes` = vote history/bookmarks. AuthButton in header. AUTH_SECRET,
  AUTH_GITHUB_ID, AUTH_GITHUB_SECRET all set in `.env.local` AND Vercel production
  (GitHub OAuth app created 2026-06-12, callback points at production — local sign-in
  needs a second OAuth app, not created). Provider verified live via
  /api/auth/providers. Signed-in vote path NOT yet exercised end-to-end — user needs
  to sign in on prod and cast a vote, then check it lands in `ratings` + /votes.
- **Phase 0 capture pipeline: BUILT, sample-verified** (commit 674aaab).
  `node pipeline/capture.mjs [--limit N] [--concurrency C] [--only substr] [--force]` —
  gates (dead/parked/blank) + hero/mobile/full-page/3-frame strip + diagnostics into the
  `portfolios` table (prod Turso — intended). 16 sites captured locally in `captures/`
  (gitignored). Adaptive settle loop handles slow preloaders (verified on a 25s loader).
  ~20s/site at concurrency 4 → full 1,779 ≈ 2.5h, NOT yet batch-run. R2 upload code ready
  but dormant — **BLOCKED on user: R2 bucket + token**. App serves own shots once
  `SHOTS_BASE_URL` (public R2 base) is set; until then mShots fallback everywhere.

- **/** — compact hero, searchable card grid of all portfolios, A–Z letter chips,
  role filter chips (regex on taglines — note 924/1779 entries have no tagline),
  "+ Submit yours" → GitHub issue form (`.github/ISSUE_TEMPLATE/submit-portfolio.yml`)
- **/rank** — face-off voting: two cards with live screenshots (WordPress mShots,
  free/unofficial, v0 only), diagnostics chips, visit/details links, "Open both
  sites" button, ←/→/↓ keyboard, ELO updates via `/api/rank`
- **/top** — ELO leaderboard, min 3 votes to qualify, links to detail pages
- **/p/[slug]** (slug = encodeURIComponent(url)) — screenshot, ELO, OG share-card
  preview, polish checklist, Lighthouse scores
- **/api/rank** GET pair (uncertainty-weighted sampling) / POST vote;
  **/api/inspect** live HTML polish checks (cached 7d); **/api/psi** Lighthouse via
  PageSpeed API (cached 30d, failures never cached)
- **PSI_API_KEY: LIVE** in `.env.local` and Vercel production env. Key is restricted in
  Google Cloud console to the PageSpeed Insights API only (verified: other APIs return
  "blocked"). 25k runs/day quota — batch-auditing all 1,779 portfolios is now possible.
- **API hardening (commit 98f4cef)**: /api/inspect and /api/psi accept only URLs present
  in feed.json (`lib/roster.ts`) — 403 otherwise. Closes quota-burn + SSRF. Verified in prod.
- **Contest status: voting is open, production DB has ZERO votes** — no humans have
  voted, AI judging not built. Leaderboard empty until sites reach 3+ votes.
- **Database: LIVE on Turso** — `libsql://portfolio-rank-n8watkins.aws-us-east-2.turso.io`,
  credentials in `.env.local` (gitignored, never commit). Tables `votes`, `ratings`,
  `cache` auto-create via `ensureSchema()` in `lib/db.ts`. Local dev WRITES TO PROD
  by design (user wants local votes to count); comment out TURSO_* in .env.local to
  fall back to a local file. Prod DB is clean (no test votes).

## Next steps, in order

1. **Verify signed-in vote end-to-end** — user signs in at portfoliorank.vercel.app,
   casts a vote; confirm it updates `ratings` (rater_type='human') and shows on /votes.
2. **USER: create Cloudflare R2 bucket** (+ API token): set R2_ACCOUNT_ID,
   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET in `.env.local`, enable public
   access on the bucket, set SHOTS_BASE_URL (public bucket URL) in `.env.local` + Vercel.
3. **Run the full capture batch** — `node pipeline/capture.mjs --concurrency 6` (~2.5h,
   resumable: already-checked URLs are skipped without --force). Then re-run with R2 on
   (or add a backfill-upload flag) so shots serve from R2 in prod.
4. **Phase 1 AI bootstrap** — Gemini Flash rubric + pairwise votes into the same ELO
   system (GRADING_CRITERIA.md §6), `rater_type='ai'`. Uses captures from step 3
   (strip0-2.png + extracted text).
5. Growth features (decided, not started): per-portfolio embeddable rank badge SVG,
   "score my portfolio" instant report, auto OG share cards, weekly feed.json sync from
   the fork.

## Conventions & gotchas

- Commit after every verified change; trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Push — every push to main auto-deploys to production.
- Vercel CLI is logged in as `natkins23`; project linked in `.vercel/`. Dashboard-only
  settings can be changed via REST API with the CLI token from
  `~/.local/share/com.vercel.cli/auth.json` (used for deployment protection + domains).
- **NEVER run `npm run build` while the dev server is running** — both use `.next/`
  and the build corrupts the running server (broke once: "Cannot find module './331.js'").
  Verify with `npx tsc --noEmit` + curl against the dev server instead.
- Dev server runs in background on port 7678 (7678 = "PORT" on a phone keypad).
- mShots returns a placeholder image while generating; `Shot` component in
  app/rank/page.tsx retries until naturalWidth ≥ 700.
- Upstream list repo has NO license → their README prose isn't copyable; the link
  data is. Credit Emma Bostian prominently (footer + README origin section). User
  explicitly wants goodwill with upstream.
- Rankings framing: showcase the best, never surface a "worst" list.
- Vote math: `lib/elo.ts`, K=32, base 1200. Pair selection samples 8 random entries,
  faces off the two least-voted.
- User created Ko-fi (not Buy Me a Coffee): ko-fi.com/n8watkins — already wired in
  `lib/site.ts` (all external URLs live there).

## File map

- `app/page.tsx` — home (hero, grid, footer); `components/PortfolioGrid.tsx` — search/letter/role filters
- `app/rank/page.tsx` — face-off UI; `app/api/rank/route.ts` — pair + vote endpoints
- `app/top/page.tsx` — leaderboard; `app/p/[slug]/page.tsx` — detail page
- `app/api/inspect/route.ts` — polish checks; `app/api/psi/route.ts` — Lighthouse
- `components/Diagnostics.tsx` — InspectChips (rank cards) + DetailDiagnostics (detail page)
- `components/Header.tsx` — nav (logo, Top, Rank, star count, Ko-fi)
- `lib/db.ts` — libSQL client + schema; `lib/cache.ts` — DB-backed cache; `lib/elo.ts`; `lib/site.ts` — URLs/branding
- `data/feed.json` — portfolio roster (1,779); `data/PORTFOLIOS.md` — mirrored upstream list
- `pipeline/` — scripts from the fork for Phase 0 (parking detection, feed generation)
- `scripts/migrate-json-to-db.mjs` — one-off v0 JSON→DB migration (already run)
- `PLAN.md` — roadmap/phases; `GRADING_CRITERIA.md` — full grading spec; `DEPLOY.md` — deploy steps + scalability table
