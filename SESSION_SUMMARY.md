# Session summary — 2026-06-19/20

What got built/changed in this session (47 commits). Newest themes grouped, not
chronological. For the authoritative architecture see **AUTOMATION.md**; for
current state see **HANDOFF.md**.

## Storage & automation (the big unblock)
- **Cloudflare R2 live** — bucket created, made public, secrets in GitHub +
  Vercel; all 1,702 sites' serve-frames (hero/mobile/full; motion strips stay
  local) uploaded; prod serves its own screenshots (mShots is fallback only).
- **5 GitHub Actions** (public repo → free minutes; failure → auto-filed issue):
  - `ci.yml` — `tsc` typecheck gate on PRs.
  - `sync-upstream.yml` — daily: pull Emma's merged README → rebuild `feed.json`
    (`= upstream − excluded.json + additions.json`, deduped) → capture + AI-grade
    new sites. (Replaced the redundant `ingest.yml`.)
  - `judge-vote.yml` — daily: AI pairwise-metrics voting (hero + Lighthouse/polish),
    tier-concentrated, budget-capped.
  - `backup.yml` — daily: gzip snapshot of votes/ratings/ai_rubric → R2 (~0.2 MB).
  - `prewarm.yml` — daily: warm PSI + inspect caches for all live sites.
- **Pipeline scripts** added: `export-grades`, `backup-db`, `r2-check`,
  `r2-upload-one`, `prewarm-metrics`, `backfill-inspect`, `retry-github`,
  `wipe-25flash`. `capture.mjs`/`judge.mjs`/`generate_feed.py` made CI-safe
  (tolerate missing `.env.local`).

## AI judging
- Standardized on **`gemini-3.1-flash-lite`** only; purged stray gemini-2.5-flash
  data.
- **Rubric grading** is hybrid: local motion strips when present, else **grade
  from R2** (hero+full + stored motion flag) so the cloud can clear the backlog.
  Aborts after 5 consecutive errors (quota guard). ~1,185 graded.
- **Pairwise-metrics voting robot**: Gemini compares two heroes + cached
  Lighthouse/polish, double-weight ⭐ super-votes, moves ELO. Adversarially
  reviewed; fixes applied (transient-R2 guard, mark-seen-on-error, etc.).

## Voting screen (/rank)
- Pick **animation** (winner glows/scales, loser fades), **screenshot-only** vote
  target (metadata moved out), **detail toggle**, **undo last vote** (reverts exact
  ELO), **⭐ Superstars** (earn 1/5 votes → double-weight super-vote + Most Loved),
  **auto-open** both sites on the new pair, signed-in pill in the header.

## Leaderboard (/top)
- **Champion #1** spotlight (hero + GitHub @handle for github.io), **Top 5**,
  **paginated** rest, **💖 Most Loved** board, honest "what this measures" framing,
  link to /how. Cold-start threshold lowered to 1 vote.

## Homepage
- **Top-ranked marquee** (top 15, R2 heroes) above the browse grid, **FAQ**
  accordion, **dead/parked/error sites filtered** from browse, search moved left,
  fewer grid rows (18) + Show more, bigger Submit, Ko-fi + n8builds footer buttons.

## Detail pages (/p/[slug])
- **AI design review** shown for all graded sites (S/A/B get the letter; C/D a
  neutral "AI" badge), reordered **Lighthouse → polish → AI**, smaller screenshot,
  **OG/Twitter share cards**, **⭐ loved** count, **Socials** (GitHub/LinkedIn/X).

## Socials scraping
- `inspect` scrapes **GitHub + LinkedIn + X** (with an **/about** fallback +
  **browser-like UA**). Backfilled all live sites: **98% reachable, 1,156 GitHub /
  1,061 LinkedIn / 509 X**.

## Auth & account
- Prominent signed-in state → **account dropdown** (My votes / Settings / Sign
  out), **direct sign-out** (no confirm page), **/settings** page (auth-open
  toggle), login visible on /rank.

## Security & resilience
- **SSRF** fix (IPv6-mapped-IPv4 + link-local), **takedown** path (issue →
  excluded.json), **CI gate**, **DB backups**, **failure alerts**, sitemap/robots,
  error/not-found pages, PortfolioRank **favicon**.

## Content & docs
- **/how** explainer page (ELO + AI-judging articles + video placeholder).
- Blog writeup moved off-repo to the N8 Notions (Sanity) site as "Making a Giant
  List Actually Fun to Browse"; the in-repo `.md` was deleted.
- README/PLAN/DEPLOY/GRADING brought current; AUTOMATION.md added; doc-staleness
  audited.

## Likes / Lists / Profile (shipped 2026-06-20)
- **Likes (♥)** — own table/signal, separate from ⭐ super-votes and from lists;
  on detail, rank cards, browse grid; public "saved" count on detail.
- **Named lists** — full CRUD + `/list/[slug]` public shareable (owner inline
  edit), "Add to list" picker with inline creation. Owner-scoped, roster-only,
  write-transactional APIs (`/api/likes`, `/api/lists*`).
- **`/profile` hub (private)** — stats (votes, Superstars, likes, lists), your
  likes grid, lists manager. `lib/stats.ts` shares `raterStats`/`starBalance`.
- Built → 5-dimension adversarial review → 13 confirmed fixes. See `LISTS_PLAN.md`.

## Planned, not built
- **Auto-updating portfolio count** in docs → backlog note in `PLAN.md`.
- Dropped per owner: notifications, 20-at-once AI judging.
