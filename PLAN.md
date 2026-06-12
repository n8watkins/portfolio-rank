# portfolio-rank — Plan

Turn the developer-portfolios list (1,779 entries, alphabetical README, value locked up)
into a ranked, browsable site where AI bootstraps the ranking and humans refine it.

Grading spec: see GRADING_CRITERIA.md. Everything there is machine-assessed; humans only
ever cast one-click votes.

## Deployment

- Upstream (emmabostian/developer-portfolios) is **not deployed anywhere** — no homepage,
  no GitHub Pages. It's a README. We are building the first real frontend for this dataset.
- Our app: **Next.js on Vercel** (frontend + API routes) + **Turso** (libSQL DB), Auth.js (GitHub
  login), Cloudflare R2 (screenshot storage). Pipeline scripts run locally / GitHub Actions cron.
- The fork stays a clean data source (`feed.json`); the app lives in this repo and ingests
  it. Keep merging upstream PRs in the fork.

## The human-comparison problem (the core UX question)

Voting fails if a vote requires visiting two strangers' websites — that's minutes per vote
and nobody does it twice. The fix: **the screenshot pipeline does the heavy lifting, so a
human vote takes ~5 seconds and never requires leaving our site.**

### Face-off screen (the default "vibe vote")

- Two cards side by side. Each card shows the **desktop hero screenshot**, with a
  **mobile-width thumbnail** in the corner.
- **Hover (or hold, on mobile) = auto-scrolling full-page preview** — the pre-captured
  full-page screenshot pans top-to-bottom in ~3s, like a silent video tour. Sites where we
  detected motion play a short pre-recorded scroll capture (webm) instead, so animated
  sites get credit for it.
- Click the better one. That's the whole interaction. ELO updates, the result flashes
  ("crowd agreed 73%" / rating delta), next pair slides in.
- Keyboard: ← / → vote, ↓ skip ("can't tell / both bad" — skips are signal too).
- "Peek" link under each card opens the live site in a new tab for the curious; vote
  weight is the same, it's just there for trust.

### Optional depth — vibe vs. rubric

- Default vote = pure vibe, one click, no questions asked.
- After voting, three optional one-tap chips: **Design / Content / Personality** —
  "what won it for you?" Skippable, but each tap feeds axis-level data without ever
  showing anyone a form.
- A settings toggle ("rubric mode") for power users replaces chips with the full 1–5
  axes. Off by default. Nobody is forced through it.

### Making people come back

- Session framing: "Rank 10" daily set with a running streak.
- After 20+ votes: "your taste profile" — which axes you reward vs. the crowd, your
  agreement % with AI. Shareable.
- Leaderboard movement is visible ("this vote moved Sarah K. up 3 spots") so votes feel
  consequential.

## Phases

### Phase 0 — Capture pipeline (local, free)  ← start here
1. Ingest `feed.json` → SQLite/Postgres `portfolios` table.
2. Gate pass: liveness + parked-domain filter (reuse fork's checker). Expect 20–30% dead.
3. Playwright capture per live site: desktop hero (1440px), mobile hero (390px),
   full-page shot, 3-frame motion strip, short scroll webm when motion detected.
   Same run records: console errors, network log (weight / requests / 404s),
   responsive overflow check, dark-mode diff, DOM-shape hash.
4. Upload media to Cloudflare R2.

### Phase 0.5 — Objective scoring (free APIs)
1. Extract PSI client from site-forge checkup route → `packages/site-audit`
   (one function: `audit(url)`; CLI for batch). MCP wrapper = later, optional.
2. PSI run over all live sites (~1 day at free quota).
3. Polish-checklist HTML parse run.
4. Originality clustering over DOM hashes.

### Phase 1 — AI bootstrap (Gemini Flash, 500/day)
1. Rubric pass: 1 call/site → tier + axis scores + justifications (~4 days).
2. Pairwise cron: remaining daily budget on uncertainty-prioritized in-bucket
   comparisons → seed ELO. Credible top-100 in ~1 week.

### Phase 2 — The site (Next.js + Turso + Vercel)
1. **Browse**: card grid sorted by ELO; scorecard + badges per card; filters
   (role/tagline, badges); detail page with screenshots, scores, AI justification.
2. **Face-off**: voting UX above. GitHub OAuth to vote; browse is public.
3. Anti-abuse: one vote/user/pair, ~100 votes/user/day server-side, raw vote log kept
   so ELO can be recomputed after purging any bad actor.

### Phase 3 — Polish & retention
- Taste profiles, streaks, "AI vs crowd" disagreement page.
- Weekly GitHub Action: re-sync fork's feed.json, capture new entries, refresh stale
  screenshots, PSI re-run.
- "Active builder" GitHub badges.

## Stack summary

| Piece | Choice | Why |
|---|---|---|
| Frontend/API | Next.js (App Router) on Vercel | free tier, he knows it |
| DB | Turso (libSQL) | free 9GB/1B reads, local file in dev, same SQL |
| Auth | Auth.js + GitHub OAuth | free, self-hosted |
| Screenshot storage | Cloudflare R2 | free egress |
| Capture | Playwright (local + GH Actions) | free, already needed for screenshots |
| Objective audit | PSI API (extracted from site-forge) | free 25k/day, real Lighthouse |
| AI judge | Gemini Flash free tier | 500 req/day budget, vision-capable |
| Ranking | ELO (K decays with vote count), human+AI tagged votes | simple, recomputable |
