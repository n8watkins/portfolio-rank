# Deploying PortfolioRank

## Cloudflare Workers

The app runs on a Cloudflare Worker built with OpenNext (`@opennextjs/cloudflare`) at https://portfoliorank.n8builds.dev; `wrangler.jsonc` and `open-next.config.ts` hold the config.
The custom domain is a `routes` entry in `wrangler.jsonc`, so every deploy keeps it, and the workers.dev address is off.

- **Deploy by hand:** `npm run deploy` (builds, then `wrangler deploy`).
  The build prerenders the home page, so run it with `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `SHOTS_BASE_URL=/shots` in the environment, or the first render after a deploy shows no ranking until ISR refreshes it (5 minutes).
- **Deploy from GitHub:** `.github/workflows/deploy.yml` builds on every push to main and deploys once the repository has a `CLOUDFLARE_API_TOKEN` secret (an API token with the "Edit Cloudflare Workers" permission); until then it skips the deploy with a notice.
- **Preview locally:** `npm run preview` runs the built Worker on workerd, reading secrets from `.dev.vars`.
- **Secrets** (`npx wrangler secret put <NAME>`, never in a file): `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `PSI_API_KEY`.
  `SHOTS_BASE_URL` and `AUTH_URL` (the site's address) are plain variables in `wrangler.jsonc`; `lib/site.ts` holds the same address for canonical URLs, share links and the sitemap.
- **Screenshots and favicons:** the Worker answers `/shots/<shot_key>/<file>` and `/favicon/<domain>` itself, before the app (`worker/assets.ts`), from the edge cache when it can.
  Screenshots come from the `SHOTS` binding (the `portfolio-rank` R2 bucket the pipeline uploads to); pages add `?v=<capture time>`, so a recapture gets a new URL and each version is served with `Cache-Control: public, max-age=31536000, immutable`.
  Favicons come from Google's favicon service for roster domains only, with a placeholder when a site has none, cached for a week.
  The bucket's public r2.dev address is for the pipeline (the `SHOTS_BASE_URL` repository secret); pages never link it.
- **ISR:** the home page (`revalidate = 300`) is cached in the `portfolio-rank-opennext-cache` R2 bucket, and a Durable Object queue deduplicates its background re-renders.
- **GitHub sign-in:** the OAuth app's callback URL is `https://portfoliorank.n8builds.dev/api/auth/callback/github`.
- **Actions:** the pipeline jobs talk to Turso and R2 directly and are unaffected.
  `prewarm.yml` calls the site's API at the `PROD_BASE_URL` repository variable (`https://portfoliorank.n8builds.dev`).

## Reading the logs

Workers Logs keeps every request (`observability` in `wrangler.jsonc`, `head_sampling_rate: 1`).
In the Cloudflare dashboard, open Workers & Pages, then the `portfolio-rank` Worker, then Logs.
To stream them live, run `npx wrangler tail portfolio-rank --format pretty`.
`--search` matches log messages only, not request URLs, so use `--status error` or no filter to see requests.
Failures log one JSON line with `event`, `reason` and `route`: Auth.js errors as `auth_error` with the error type (such as `CallbackRouteError` or `InvalidCheck`), a masked message and the provider's OAuth error code, and errors thrown in pages, route handlers or middleware as `unhandled_exception` with the route (`instrumentation.ts`).
They never carry secrets, tokens, OAuth codes or state values, cookies, emails or other personal data.

## Original Vercel setup (retired 2026-11, kept for reference)

Target: Vercel (app) + Turso (votes, ratings, portfolios, diagnostic caches) + Auth.js
(GitHub login) + Cloudflare R2 (screenshots). All free tier.

## Status (2026-06-20): fully deployed

All of it is live in production (portfoliorank.vercel.app). Persistence runs on libSQL
via `lib/db.ts` — a local file (`data/portfoliorank.db`) in dev, Turso in prod; tables
auto-create on first use (`votes`, `ratings`, `portfolios`, `cache`, `likes`, `lists`, `list_items`). Auth (GitHub login,
vote tiers, rate limits) is shipped. Screenshots are captured by Playwright and served
from Cloudflare R2 (mShots is only a fallback now). The whole pipeline runs itself via
daily GitHub Actions — see **AUTOMATION.md**.

## Steps (one-time)

1. **Turso** — https://turso.tech (free: 9 GB storage, 1B row reads/mo)
   ```bash
   # interactive login — run yourself: ! turso auth login   (or brew/curl install first)
   turso db create portfolio-rank
   turso db show portfolio-rank --url        # → TURSO_DATABASE_URL
   turso db tokens create portfolio-rank     # → TURSO_AUTH_TOKEN
   ```

2. **Env vars** — the app (`.env.local` for dev, Vercel project settings for prod):
   ```
   TURSO_DATABASE_URL=libsql://...
   TURSO_AUTH_TOKEN=...
   PSI_API_KEY=...        # console.cloud.google.com → enable PageSpeed Insights API → key
   AUTH_SECRET=...        # openssl rand -base64 33
   AUTH_GITHUB_ID=...     # GitHub OAuth app (callback → /api/auth/callback/github)
   AUTH_GITHUB_SECRET=...
   SHOTS_BASE_URL=/shots   # the app links captures on its own domain (next dev: app/shots)
   ```
   The pipeline + GitHub Actions also need these as **repo secrets** (and in `.env.local`
   for local runs): `GEMINI_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `SHOTS_BASE_URL`. AUTOMATION.md lists which
   workflow uses what.

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
| Gemini (AI judge) | free-tier req/day | **the real ceiling** — grading is budget-capped + voting is 30/day, both abort cleanly on quota; staggered Actions avoid self-collision |
| Screenshots — own (R2) | 10 GB storage, free egress | live: ~570 MB of serve-frames + ~0.2 MB/day DB backups — far under cap; mShots is only a fallback now |

Bottom line: votes/DB scale effortlessly on Turso's free tier and screenshots are owned
on R2; the only metered resource to watch is the shared Gemini daily budget, which the
Actions are capped to respect.
