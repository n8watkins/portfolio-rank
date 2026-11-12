# How PortfolioRank posts are written

> **DRAFT, not legal advice.** Built as `/about-posts` ([app/about-posts/page.tsx](../../app/about-posts/page.tsx)) with the blog pages; keep the two in step. See [README.md](README.md).

Last updated: [owner: date it goes live].

## The label

Every post carries this line at the top:

> Written with AI from PortfolioRank data. [How posts are made](/about-posts) · [The data](link to the post's data)

## The short version

Posts on the PortfolioRank blog are written by AI (Google's Gemini) from PortfolioRank's own data.
I set the rules, the voice and the checks, and I read every post before it goes out.
I'd rather tell you that up front than have you guess.

## How a post is made

1. **Find:** each week the pipeline collects story ideas from the leaderboard, the experiments, and news about AI and hiring.
2. **Pick:** the best one or two ideas go ahead, mixing kinds so posts don't repeat.
3. **Facts:** code computes every number and draws every chart from the data.
   The AI never makes up a figure.
4. **Write:** Gemini writes the post around those facts.
5. **Check:** automatic checks run before anything is published (below).
6. **Review:** I read every draft that passes and publish it or throw it out.
7. **Publish:** on the blog, then in the newsletter.

## The checks

A draft that fails a check is revised automatically.
If it still fails after two rounds, it's dropped: never published.

- Every number in the text must match the computed data exactly.
- Every link must load and point to a real page; no invented quotes or sources.
- A second AI pass reviews tone and every claim.
- **Naming rule:** individual developers are named only for good reasons, like top sites, big climbers or redesigns that paid off.
  Low scores and anything critical are only discussed in aggregate.
  Anyone can ask not to be named at all: [removal.md](removal.md).

## Images

- Charts are drawn by code from the data.
- Screenshots of listed portfolios follow the naming rule.
- Stock photos come from Pexels and credit the photographer.
- Illustrations made by AI (Cloudflare Workers AI) are captioned "AI-generated illustration".

## Mistakes and corrections

- Every post says when its data is from, so you can tell when the numbers were true.
- If you spot a mistake, email nate@n8builds.dev or open an issue on [GitHub](https://github.com/n8watkins/portfolio-rank/issues); I fix or unpublish it within 14 days.

## What the posts are not

Rankings and grades are opinions, from people's votes and from an AI judge, measured against [published criteria](/grading).
They are not judgments of the developers themselves.
Every site on the list shipped, which is more than most.
