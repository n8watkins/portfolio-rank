# PortfolioRank

**The best developer portfolios. Ranked.**

1,700+ community-curated developer portfolios — browsable, searchable, and (soon) ranked
by head-to-head human votes and AI scoring instead of alphabetical order.

🌐 **Live: [portfoliorank.vercel.app](https://portfoliorank.vercel.app)** · ☕ [Support on Ko-fi](https://ko-fi.com/n8watkins)

## Origin

It started with this tweet by [Ali Spittel](https://twitter.com/ASpittel), which inspired
[Emma Bostian](https://github.com/emmabostian) to create
[developer-portfolios](https://github.com/emmabostian/developer-portfolios) — the
community list this project is built on:

<a href="https://twitter.com/ASpittel/status/1171604728951779328">
	<img width="597" alt="Ali Spittel's tweet: asking developers to share their portfolios" src="assets/ASpittel_tweet.png">
</a>

## Why

The original list is an incredible community resource — thousands of contributors since
2019 — but it's a README sorted A→Z. Nobody can find the *good* ones. PortfolioRank gives
the dataset a real frontend and a ranking system:

- **Browse** — card grid of every portfolio, searchable by name, role, or domain
- **Face-off voting** *(planned)* — two portfolios side by side, pick the better one,
  ELO decides the leaderboard
- **AI bootstrap** *(planned)* — Gemini judges design/content pairwise to seed rankings
  before human votes accumulate
- **Objective scorecards** *(planned)* — real Lighthouse scores (via PageSpeed Insights),
  polish checks, and originality detection for every site

See [PLAN.md](PLAN.md) for the roadmap and [GRADING_CRITERIA.md](GRADING_CRITERIA.md) for
exactly how sites are graded.

## Development

```bash
npm install
npm run dev   # → http://localhost:7678
```

Next.js (App Router) + Tailwind. Data lives in `data/feed.json`; pipeline scripts in
`pipeline/`.

## Data & credit

Portfolio data originates from
[emmabostian/developer-portfolios](https://github.com/emmabostian/developer-portfolios),
curated by Emma Bostian and 1,700+ contributors — go star it. The raw list is mirrored in
[`data/PORTFOLIOS.md`](data/PORTFOLIOS.md); `data/feed.json` is the structured version.
Want your portfolio included? Add it there via PR and it'll flow into PortfolioRank on
the next sync.

All code here is MIT-licensed. Rankings are opinions (the crowd's and an AI's), not
judgments of the developers themselves — every site on this list shipped, which is more
than most.
