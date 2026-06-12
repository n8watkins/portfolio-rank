# Deploying PortfolioRank

Target: Vercel (app) + Supabase (votes, auth, caches). Both free tier.

## What blocks deploy today

The v0 API routes persist to local files (`data/ratings.json`, `data/votes.jsonl`,
`data/*-cache.json`). Vercel's filesystem is read-only, so those must move to Supabase
first. Everything else deploys as-is.

## Steps (one-time, ~15 min of clicking)

1. **Supabase project** — create at https://supabase.com/dashboard (free tier).
   - SQL editor → paste and run `supabase/schema.sql`.
   - Auth → Providers → enable **GitHub** (create the GitHub OAuth app it asks for at
     github.com/settings/developers; callback URL is shown in the Supabase UI).
   - Copy: Project URL, anon key, service-role key.

2. **Env vars** — locally in `.env.local` and in Vercel project settings:
   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...   # server-only, never NEXT_PUBLIC
   PSI_API_KEY=...                 # free key, console.cloud.google.com → PageSpeed Insights API
   ```

3. **Code swap (Claude does this once keys exist)** — replace file persistence in
   `app/api/rank/route.ts` and `lib/cache.ts` with Supabase tables (`votes`, `ratings`,
   `site_checks`); add sign-in + anon session IDs; rate-limit votes per rater.

4. **Vercel** — `vercel` CLI login + link repo (or import `n8watkins/portfolio-rank`
   in the dashboard). Set env vars, deploy. Custom domain later.

## Scalability picture (free-tier limits vs. expected load)

| Piece | Free limit | A viral day (~50k visitors, ~200k votes) |
|---|---|---|
| Vercel bandwidth/functions | 100 GB/mo, 1M invocations | fine — pages are small, API calls are tiny JSON |
| Supabase DB | 500 MB | a vote row is ~100 bytes → 200k votes ≈ 20 MB. Years of headroom |
| Supabase auth | 50k MAU | fine |
| PSI API | 25k/day with free key | fine (results cached 30 days) |
| mShots screenshots | unofficial, throttles | **the weak link** — replace with own captures (Phase 0) before any launch push |
| Supabase storage egress (future screenshots) | 5 GB/mo | tight under virality → move images to Cloudflare R2 (10 GB storage, free egress) |

Bottom line: votes/auth/DB scale effortlessly; the only real scaling work is owning
screenshots (already planned as Phase 0) and putting them on R2 if traffic spikes.
