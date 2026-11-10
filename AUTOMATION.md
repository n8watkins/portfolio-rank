# Automation & Architecture

How PortfolioRank stays current with **no manual work**. This is the source of
truth for the data flow and the GitHub Actions.

## Data flow

```
emmabostian/developer-portfolios (upstream, community-curated)
        │  (only MERGED entries — upstream review is the trust gate)
        ▼
  sync-upstream Action  ──rebuild──►  data/feed.json
        │                               = upstream − excluded.json + additions.json
        ▼
  capture.mjs  ──►  screenshots ──► Cloudflare R2 (public)   + diagnostics ──► Turso
        ▼
  judge.mjs rubric  ──►  Gemini tier + 6-axis grades ──► Turso (portfolios.ai_rubric)
        ▼
  judge.mjs pairwise  ──►  Gemini ELO votes ──► Turso (votes, ratings)
        ▼
  Next.js app (Cloudflare Workers)  ──►  grid · /rank face-off · /top leaderboard · /p/[slug]
```

## The list (two intake doors + a takedown)

`data/feed.json` is rebuilt daily as **`upstream − excluded.json + additions.json`**
(deduped by normalized URL; original URL strings preserved so DB keys never break).

| Source | Trust | Mechanism |
|---|---|---|
| **Upstream merge** | High (Emma reviewed it) | Auto-pulled by `sync-upstream` |
| **Direct submission** | Unvetted | Issue form → `data/additions.json` |
| **Takedown / opt-out** | — | "Remove my portfolio" issue → `data/excluded.json` (dropped forever) |

## GitHub Actions (5)

All run on GitHub-hosted runners. The repo is **public → unlimited free Actions
minutes**; the only real budget is the Gemini free tier. Every scheduled job
files (and de-dupes) a GitHub **issue on failure**, so nothing fails silently.

| Workflow | Trigger | What it does | Secrets |
|---|---|---|---|
| **`ci.yml`** | PR → main | `tsc --noEmit` and the Worker build; gates what the next deploy ships | none |
| **`sync-upstream.yml`** | daily 06:00 UTC + manual | Rebuild `feed.json` from upstream's merged README, commit if changed, then **capture + AI-grade** new sites (serve-frames → R2) | TURSO, GEMINI, R2 |
| **`judge-vote.yml`** | daily 13:00 UTC + manual | Gemini **pairwise-metrics voting**: compare S/A/B pairs by hero (from R2) + cached Lighthouse/polish signals, cast ELO votes (≤30/day, flash-lite chain only) | TURSO, GEMINI, SHOTS_BASE_URL |
| **`backup.yml`** | daily 05:00 UTC + manual | Gzip snapshot of `votes`/`ratings`/`ai_rubric` → private R2 bucket `portfolio-rank-backups` (~0.3 MB/run) | TURSO, R2_ACCOUNT_ID, R2_BACKUP_* |
| **`prewarm.yml`** | daily 09:00 UTC + manual | Warm the PSI (Lighthouse) + inspect (polish) caches for S/A/B sites by hitting the prod API, so the voting robot's comparisons have real metrics | TURSO |

Schedules are staggered: backup (05:00) → sync+grade (06:00) → vote (13:00, clear
of the sync window). `sync-upstream` holds the `ingest` concurrency lock for DB
writes; `judge-vote` uses its own `ai-vote` group (write-light) so it never
queues behind a long sync.

## Budget model

- **Gemini (free tier, shared):** grading self-limits to *new* sites/day; voting
  capped at 30/day. Both abort cleanly on sustained 429s. See the AI judge
  section below for the models.
- **R2 (10 GB free):** ~570 MB of serve-frames (hero/mobile/full; motion strips
  stay local) + ~0.2 MB/day backups → far under the cap, $0.
- **GitHub Actions:** unlimited (public repo).
- **PSI/Lighthouse:** 25k runs/day — ample.

## AI judge (Gemini)

`pipeline/judge.mjs` calls Gemini through `pipeline/gemini.mjs`.

- **Key:** sent in the `x-goog-api-key` header, never as `?key=` in the URL.
  Newer AI Studio keys ("AQ." style) are rejected in the URL, and a URL key leaks into logs.
- **Models:** `gemini-3.5-flash-lite` first, `gemini-3.1-flash-lite` as the backup (owner's choice, 2026-11-10).
  A call moves to the backup only when 3.5 is rate limited (429), overloaded (5xx) or unreachable.
  A rejected key (401, 403, 400 `API_KEY_INVALID`) or a bad request never falls back.
  When both models are unavailable, the chain is retried after 15, 30 and 45 seconds.
  `--model M` uses only `M`, with no fallback.
- **Failing loudly:** `judge.mjs` exits 1 when the key is rejected, or when there was work and every call failed, so the "Notify on failure" step files an issue.
  Running out of daily quota after some successes still exits 0.
- **Which model judged:** each rubric stores the model that actually answered in `ai_rubric.model`, and each AI vote stores it in `votes.model`.
- **One AI voter:** every vote the flash-lite chain casts uses one logical rater id, `ai:flash-lite`, whichever model answered.
  `rater_id` is a voter's identity: the unique `(rater_id, pair_key)` index allows one vote per voter per matchup, and the judge skips pairs its rater id already voted on.
  Per-model rater ids would let the backup vote a second time on a pair the primary already judged, giving the AI two votes on that matchup and skewing ELO toward the AI.
  With one logical id, the database guarantees one AI vote per matchup, and the leaderboard (`ratings`, which never looks at `rater_id`) stays consistent.
  The first pairwise run moves the earlier `ai:gemini-3.1-flash-lite` votes to `ai:flash-lite` with `model = 'gemini-3.1-flash-lite'`, so the new judge does not re-vote those pairs.
  A model outside the chain (`--model M --allow-model`) is a different judge and votes as `ai:M`.

## Required repo secrets

`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `GEMINI_API_KEY`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
`R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY` (an R2 token with Object Read & Write on `portfolio-rank-backups` only),
`SHOTS_BASE_URL` (public R2 base). Optional: `GH_SYNC_TOKEN` (keep the upstream
fork mirror synced too). The app reads `SHOTS_BASE_URL` from `wrangler.jsonc` vars to
serve images.

## Local pipeline scripts

- `pipeline/capture.mjs [--upload-only] [--only s] [--force]` — Playwright capture + R2 upload
- `pipeline/judge.mjs rubric|pairwise [flags]` - Gemini grading / voting (`node --test tests/gemini-judge.test.mjs` tests its Gemini client offline)
- `pipeline/generate_feed.py <readme> <out> [--exclude f] [--add f]` — build feed.json
- `scripts/backup-db.mjs` — DB → R2 snapshot · `scripts/export-grades.mjs` — grades → CSV
- `scripts/r2-check.mjs` — R2 connectivity · `scripts/r2-upload-one.mjs <key>` — single-site upload
