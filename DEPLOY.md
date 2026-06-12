# Deploying PortfolioRank

Target: Vercel (app) + Turso (votes, ratings, diagnostic caches) + Auth.js (GitHub
login) + Cloudflare R2 (screenshots, later). All free tier.

## Storage status

Done: all persistence runs on libSQL via `lib/db.ts` — a local file
(`data/portfoliorank.db`) in dev, Turso in production. No code changes needed at
deploy time, just env vars. Tables are auto-created on first use
(`votes`, `ratings`, `cache`).

Still local-only: nothing. The app is deployable once the env vars below exist.
Auth (GitHub login, vote tiers, rate limits) is the next code milestone.

## Steps (one-time)

1. **Turso** — https://turso.tech (free: 9 GB storage, 1B row reads/mo)
   ```bash
   # interactive login — run yourself: ! turso auth login   (or brew/curl install first)
   turso db create portfolio-rank
   turso db show portfolio-rank --url        # → TURSO_DATABASE_URL
   turso db tokens create portfolio-rank     # → TURSO_AUTH_TOKEN
   ```

2. **Env vars** — locally in `.env.local` and in Vercel project settings:
   ```
   TURSO_DATABASE_URL=libsql://...
   TURSO_AUTH_TOKEN=...
   PSI_API_KEY=...   # free: console.cloud.google.com → enable PageSpeed Insights API → API key
   ```
   (Later, for login: AUTH_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET.)

3. **Vercel** — import `n8watkins/portfolio-rank` at vercel.com/new (or `vercel` CLI),
   set the env vars, deploy. Custom domain later.

4. **Seed production** — `TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/migrate-json-to-db.mjs`
   ports any local votes up (optional; skips cleanly if no JSON files remain).

## Scalability picture (free-tier limits vs. expected load)

| Piece | Free limit | A viral day (~50k visitors, ~200k votes) |
|---|---|---|
| Vercel bandwidth/functions | 100 GB/mo, 1M invocations | fine — pages are small, API responses are tiny JSON |
| Turso | 9 GB storage, 1B row reads/mo, 25M writes/mo | a vote is 2 writes → 400k writes ≈ 1.6% of monthly quota in a day. Years of headroom on storage |
| Auth.js | self-hosted, no vendor limit | fine |
| PSI API | 25k/day with free key | fine (results cached 30 days) |
| mShots screenshots | unofficial, throttles | **the weak link** — replace with own captures (Phase 0) before any launch push |
| R2 (future screenshots) | 10 GB storage, free egress | comfortably covers ~2k webp full-page captures |

Bottom line: votes/DB scale effortlessly on Turso's free tier; the only real scaling
work is owning screenshots (already planned as Phase 0).
