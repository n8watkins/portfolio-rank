# HANDOFF — PortfolioRank

Read this + AUTOMATION.md + PLAN.md + GRADING_CRITERIA.md + DEPLOY.md in full
before doing anything. Do not re-ask the user anything answered here or there.

## ⚡ Update 2026-06-20 (supersedes anything below that conflicts)

The blockers in the old "Next steps" are **done**; the pipeline is fully automated.
See **AUTOMATION.md** for the authoritative architecture + GitHub Actions.

- **R2 is LIVE.** Cloudflare R2 bucket `portfolio-rank` (public base
  `https://pub-680e930bd59047488d688e63d7477fee.r2.dev`). All 1,702 sites'
  serve-frames (hero/mobile/full — motion strips stay local) uploaded; prod
  serves its own screenshots from R2 (verified). Secrets set in GitHub Actions
  AND Vercel prod (`SHOTS_BASE_URL`). **R2 token should be rotated** (it was
  pasted in a chat session); update `.env.local` then re-push secrets.
- **AI judge: grading ~done** (gemini-3.1-flash-lite, ~1,180+/1,779 rubrics) and
  the **daily pairwise voting robot is live** (`judge-vote.yml`, S/A/B,
  metrics-enriched, ≤30 votes/day). **Only gemini-3.1-flash-lite** — never 2.5.
- **5 GitHub Actions** (ci, sync-upstream, judge-vote, backup, prewarm) — see AUTOMATION.md.
  `feed.json` = upstream − `data/excluded.json` + `data/additions.json`.
- **Mobile face-off fixed** (serves mobile.jpg via `app/shots/` route in dev,
  R2 in prod), **SSRF bypass closed**, **CI gate**, **daily DB backup to R2**,
  **takedown path** (footer + issue → excluded.json), **sitemap/robots/error pages**.
- **Cold caches / open items:** PSI+inspect metrics are populated lazily by
  visits, so voting mostly judges visuals until a PSI/inspect prewarm runs.
  Product decisions still open: grid cards link straight to external sites
  (bypass detail pages + SEO); AI grades are computed but shown nowhere.

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

- **Auth.js sign-in + three-tier votes: LIVE.** Anon voters get a sticky `pr_anon`
  cookie and 10 practice votes — logged with `rater_type='anon'` but they NEVER update
  the `ratings` table; then the sign-in gate. Signed-in votes are `rater_type='human'`,
  rater_id is provider-prefixed (`gh:<github id>`, `g:<google sub>` — `session.raterId`,
  the old `session.githubId` is gone) and move official ELO. One vote per pair per rater
  (either direction, 409), 100/day limit (429), **min 2s between votes per rater**
  (429 `too_fast`, anti-bot pacing), vote URLs restricted to the roster (403). `/votes` =
  vote history/bookmarks. AUTH_SECRET + AUTH_GITHUB_ID/SECRET set in `.env.local` AND
  Vercel production (GitHub OAuth app created 2026-06-12, callback points at production —
  local sign-in needs a second OAuth app, not created). Signed-in vote NOT yet exercised
  on prod by a real user.
- **Security hardening: DONE, verified** (commit 874fad4, after a subagent audit).
  (1) Vote integrity is now atomic: `votes` has `pair_key` (newline-joined sorted pair —
  NOT NUL, which SQLite truncates TEXT at) and a `UNIQUE(rater_id, pair_key)` index; the
  POST /api/rank handler runs all limit checks + insert + ELO upsert inside one
  `db().transaction("write")`, so concurrent requests can't race past the dup-check /
  pacing / daily cap or lost-update ELO. Dup is caught as the UNIQUE violation → 409.
  Verified: 8 concurrent same-pair votes → exactly 1 lands; reversed re-vote → 409.
  (2) /api/claim now counts against the daily cap (budget = DAILY_VOTE_LIMIT − today's
  votes) so churning anon cookies can't mint unlimited official votes. (3) `lib/safefetch.ts`
  — /api/inspect follows redirects manually, rejecting any hop on a private/loopback/
  metadata host (SSRF), and caps the buffered body (DoS); blocklist unit-tested 16/16.
  (4) Security headers (CSP, X-Frame-Options DENY, nosniff, Referrer-Policy,
  Permissions-Policy) on all routes via next.config.ts — VERIFIED LIVE on prod.
  Writeup lives in `blog/building-portfoliorank.md` (casual blog post w/ captioned meme
  placeholders, for the user's personal blog — REFRAMED 2026-06-20 to be about using
  generative AI to make existing content fun to browse, keeping one light security beat);
  README links to it. Residual/accepted: DNS-rebind (host
  blocklist is name-based, not resolved-IP); multi-OAuth-account sybil voting (inherent
  to any voting site); capture.mjs still trusts hostile pages (owner-run, lower priority).
- **Sign-in modal + practice-vote claim: BUILT, verified locally** (`components/
  SignInModal.tsx`, `app/api/claim/route.ts`, `components/ClaimVotes.tsx` in root layout).
  Modal (GitHub button; Google button appears automatically once AUTH_GOOGLE_ID/SECRET
  exist — provider added conditionally in auth.ts) replaces all default-signin-page links;
  /rank nudges anon first-timers once per tab session (sessionStorage `pr_signin_nudged`)
  with a skip into practice mode. On sign-in, ClaimVotes POSTs /api/claim once per tab
  session: anon votes are re-attributed to the human rater and applied to ELO (dup pairs
  dropped), `pr_anon` cookie cleared. Claim flow e2e-tested locally with a minted session
  JWT (anon vote → ratings untouched → claim → ELO applied) and all test data removed.
  NOTE: the 2 pre-auth-era `rater_id='local'` test votes (+ their 4 ratings rows) are
  GONE — prod `votes` and `ratings` were both empty as of 2026-06-12 (later session);
  presumably the user wiped them. Vote tables start from a clean slate.
- **Phase 0 capture pipeline: BUILT, sample-verified** (commit 674aaab).
  `node pipeline/capture.mjs [--limit N] [--concurrency C] [--only substr] [--force]` —
  gates (dead/parked/blank) + hero/mobile/full-page/3-frame strip + diagnostics into the
  `portfolios` table (prod Turso — intended). **FULL BATCH COMPLETE (2026-06-12):**
  all 1,779 sites processed — 1,692 live with captures, 44 dead, 43 error. ~2.0 GB in
  `captures/` (gitignored, local only — NOT yet on R2; R2 still blocked on user). The
  AI judge reads these local files, so don't delete `captures/` until both the R2
  upload AND the rubric/pairwise passes are done. Already-checked URLs skip without
  `--force`; `--upload-only` backfills `captures/` to R2 once R2_* env vars exist.
  Adaptive settle loop handles slow preloaders (verified on a 25s loader).
  ~20s/site at concurrency 4 → full 1,779 ≈ 2.5h. R2 upload code ready
  but dormant — **BLOCKED on user: R2 bucket + token**. App serves own shots once
  `SHOTS_BASE_URL` (public R2 base) is set; until then mShots fallback everywhere.

- **Phase 1 AI judge: BUILT, sample-verified against prod** (`pipeline/judge.mjs`).
  `node pipeline/judge.mjs rubric [--limit N] [--only s] [--force] [--rpm R]` — 1 Gemini
  call/site (strip0 + strip2 + full.jpg) → tier S–D + six 1–5 axes + notes +
  is_portfolio flag, stored as JSON in `portfolios.ai_rubric` (column added by the
  script). `node pipeline/judge.mjs pairwise [--votes N]` — hero-vs-hero votes, A/B
  order randomized, written directly to `votes` as `rater_type='ai'` /
  `rater_id='ai:gemini-2.5-flash'` with the ELO upsert in the same write transaction
  (mirrors POST /api/rank; AI votes DO move official ELO — that's the bootstrap).
  Verified: 2 rubrics stored, 3 pairwise votes landed with correct K=32 ELO and full
  pair_keys. GEMINI_API_KEY is in `.env.local` (local pipeline only, NOT in Vercel —
  nothing in the app calls Gemini). Model gemini-2.5-flash; paced --rpm 8 (free-tier
  RPM); free budget ~500 req/day, plan full runs accordingly (1,779 rubrics ≈ 4 days).

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
- **Contest status: voting is open, no real human votes yet** — only the 2 pre-auth-era
  'local' test rows noted above; AI judging not built. Leaderboard empty until sites
  reach 3+ votes.
- **Database: LIVE on Turso** — `libsql://portfolio-rank-n8watkins.aws-us-east-2.turso.io`,
  credentials in `.env.local` (gitignored, never commit). Tables `votes`, `ratings`,
  `cache` auto-create via `ensureSchema()` in `lib/db.ts`. Local dev WRITES TO PROD
  by design (user wants local votes to count); comment out TURSO_* in .env.local to
  fall back to a local file.

## Next steps, in order

1. **Verify signed-in vote end-to-end** — user signs in at portfoliorank.vercel.app,
   casts a vote; confirm it updates `ratings` (rater_type='human') and shows on /votes.
   Also confirm practice votes cast before sign-in get claimed (toast-free, check DB).
2. **USER: create Google OAuth client** (console.cloud.google.com → APIs & Services →
   Credentials → OAuth client ID, type Web app): authorized redirect URI
   `https://portfoliorank.vercel.app/api/auth/callback/google`. Put AUTH_GOOGLE_ID +
   AUTH_GOOGLE_SECRET in `.env.local` + Vercel production, redeploy — the Google button
   appears in the modal automatically.
3. **USER: create Cloudflare R2 bucket** (+ API token): set R2_ACCOUNT_ID,
   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET in `.env.local`, enable public
   access on the bucket, set SHOTS_BASE_URL (public bucket URL) in `.env.local` + Vercel.
4. **Run the full capture batch** — `node pipeline/capture.mjs --concurrency 6` (~2.5h,
   resumable: already-checked URLs are skipped without --force). Then re-run with R2 on
   (or add a backfill-upload flag) so shots serve from R2 in prod.
5. **Run the Phase 1 AI bootstrap** — judge.mjs is built and verified (see State);
   once the capture batch finishes, run `node pipeline/judge.mjs rubric` daily until
   all sites are judged (~500 req/day free budget → ~4 days), then
   `node pipeline/judge.mjs pairwise --votes N` with leftover budget to seed ELO.
6. Growth features (decided, not started): per-portfolio embeddable rank badge SVG,
   "score my portfolio" instant report, auto OG share cards, weekly feed.json sync from
   the fork.

## Conventions & gotchas

- Commit after every verified change; trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Push — every push to main auto-deploys to production.
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
- **Voting is atomic now**: POST /api/rank does ALL checks + insert + ELO upsert inside
  one `db().transaction("write")`. Add new vote-side invariants INSIDE that tx, not as a
  separate pre-check (the whole point was killing check-then-write races). Dup detection
  relies on the `votes_rater_pair_idx` UNIQUE index + `pairKey()`.
- **`pairKey()` separator is `"\n"` on purpose** — do NOT use a NUL/`\0` byte: SQLite
  silently truncates TEXT at a NUL, which corrupted pair_key during dev (caught via `xxd`).
  Any separator that can't appear in a URL and isn't NUL is fine.
- **Don't `pkill -f "next dev"`** — the pattern matches Claude's own shell wrapper and
  kills the command (exit 144). Kill by port instead: `ss -ltnp | grep :7678` → `kill <pid>`.
- After `rm -rf .next`, the first request to each route triggers a cold compile that can
  take 60–110s (one GET took 105s). Use generous curl `--max-time` and warm the route once
  before timing anything.
- User created Ko-fi (not Buy Me a Coffee): ko-fi.com/n8watkins — already wired in
  `lib/site.ts` (all external URLs live there).

## File map

- `app/page.tsx` — home (hero, grid, footer); `components/PortfolioGrid.tsx` — search/letter/role filters
- `app/rank/page.tsx` — face-off UI (+ sign-in modal nudge); `app/api/rank/route.ts` — pair GET + atomic vote POST
- `app/top/page.tsx` — leaderboard; `app/p/[slug]/page.tsx` — detail page; `app/votes/page.tsx` — vote history (uses session.raterId)
- `app/api/claim/route.ts` — converts anon practice votes → official on sign-in (daily-cap-bound)
- `app/api/inspect/route.ts` — polish checks (SSRF-hardened); `app/api/psi/route.ts` — Lighthouse
- `auth.ts` — Auth.js config (GitHub always; Google conditional on env); `lib/rater.ts` — getRater + vote limits
- `components/SignInModal.tsx` — in-app OAuth modal; `components/ClaimVotes.tsx` — fires /api/claim on sign-in (in layout)
- `components/Diagnostics.tsx` — InspectChips + DetailDiagnostics; `components/Header.tsx` — nav + AuthButton
- `lib/db.ts` — libSQL client + schema/migrations; `lib/safefetch.ts` — SSRF-safe fetch + size cap
- `lib/cache.ts` — DB-backed cache; `lib/elo.ts` — ELO + `pairKey()`; `lib/site.ts` — URLs/branding; `lib/roster.ts` — feed allowlist
- `next.config.ts` — security headers; `blog/building-portfoliorank.md` — blog post (building with AI; user's personal blog)
- `data/feed.json` — portfolio roster (1,779); `data/PORTFOLIOS.md` — mirrored upstream list
- `pipeline/` — scripts from the fork for Phase 0 (parking detection, feed generation)
- `scripts/migrate-json-to-db.mjs` — one-off v0 JSON→DB migration (already run)
- `PLAN.md` — roadmap/phases; `GRADING_CRITERIA.md` — full grading spec; `DEPLOY.md` — deploy steps + scalability table
