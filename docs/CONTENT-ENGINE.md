# Content engine design

The design of PortfolioRank's automatic blog, for the owner to read before any of it is built.
Nothing here is code yet.
It turns the content engine plan, the security review, the Gemini budget page and the decisions in [DECISIONS.md](DECISIONS.md) into one buildable design, trimmed to what the owner asked for: "don't overbuild".

Sources, all read on 2026-11-10:

- [Content engine plan](https://claude.ai/artifact/RrodYrSbswXAHSNAzTS42s)
- [Security review](https://claude.ai/artifact/NxQ7yS4P28dhUsiZ2WhKWk), owner decisions at the top
- [Gemini budget](https://claude.ai/artifact/44NyzmGV1NsuenjNPtZNAH), "People first, AI with the leftovers"
- [POST_TEMPLATE.md](content/POST_TEMPLATE.md), [DECISIONS.md](DECISIONS.md), [MODEL-LIMITS.md](MODEL-LIMITS.md), [COSTS.md](COSTS.md), [legal/ai-content.md](legal/ai-content.md)

Places where the owner has to choose are marked **Owner decision needed**, with a recommendation.
They are collected at the end.

## In one paragraph

Once or twice a week, PortfolioRank writes a short blog post from its own data: who climbed the leaderboard, what an experiment found, how people and the AI disagree, what changed in Google's models.
Code computes every number and draws every chart; Gemini 3.5 Flash-Lite only writes the words around them.
Before a post goes out, code checks every number and name, a search checks every claim that doesn't come from our data, a topic filter keeps it on careers, hiring and portfolios, and every image comes from a copyright-safe source.
A draft that fails is revised at most twice, then dropped.
It all runs inside the end-of-day run on whatever Gemini quota people didn't use, with hard caps and one kill switch.
The first week runs privately (a dry run) before anything is published.

## What the owner already decided

From DECISIONS.md and the security review, 2026-11-10:

- **Positive by design:** posts are about what the best developers are doing and how to fit the job market; topics and news are limited to careers, hiring and portfolios; anything hostile or off-topic is skipped.
- **Claims checked before publishing, not purged after:** numbers from our data are checked by code; outside claims are checked with a Tavily search; a claim that can't be checked is cut.
- **No auto-unpublish:** the earlier idea of unpublishing a post when later data contradicts it is dropped (it moves to "Superseded" in DECISIONS.md with this change).
- **AI note:** every post says it was "written with AI from PortfolioRank data", with the data linked.
- **Copyright-safe images only:** our charts and screenshots, free-licence stock, generated illustrations; do our best and improve over time.
- **Pace: 1-2 posts a week**, the best-scoring draft each time.
- **The naming rule:** developers are named only for positive reasons (top sites, climbers, redesigns that paid off); anything critical is in aggregate only.
- **Facts from code, words from Gemini:** Gemini never invents a figure.
- **Fully automatic and fail-closed:** no review step; the owner is informed, not asked.
- **People first:** content runs in the end-of-day run, after new grades and ranking comparisons, on what is left of the day's quota (stage "Content", at most 100 requests and 30 minutes a night; [AUTOMATION.md](../AUTOMATION.md#the-stages)).
- **The gates shrink to the essentials:** facts from code, outside claims searched, topic filter, safe images, caps and a kill switch, and one week of private dry run.

## The six gates

These replace the seven design gates in the security review.
Each one is code with a test before the first post goes out.

### 1. Facts come from code

- For each story, a fact builder (plain code, no AI) reads the database and returns a **fact sheet**: a list of facts, each with an id, a value, how it is shown ("38%", "2,104 portfolios"), the query that produced it, and the time it was computed.
- Gemini writes with **placeholders**, never digits: "`{{f3}}` of the top 100 link a resume".
  Code fills in the values, so a number in a post cannot be wrong or made up.
- After filling, code scans the text for any number that didn't come from a placeholder.
  Years, list numbers and numbers inside the sentence of a checked outside claim (gate 2) are allowed; anything else fails the draft.
- Charts are drawn from the same fact sheet, so a chart can't disagree with the text.
- The fact sheet is stored with the post, so anyone (the owner, a later check) can see where each number came from.

### 2. Outside claims are searched

An outside claim is anything about the world that our data doesn't show ("hiring managers spend about seven seconds on a portfolio").

- One Gemini request lists every outside claim in the draft, as exact sentences.
- Code searches each one with Tavily (basic search, 1 credit), at most 6 claims a post.
- One Gemini request judges each claim against the search results, which travel as untrusted data, never as instructions (the same rule as page text in grading).
- A supported claim keeps a link to the source that supports it; code checks the link loads.
- A quote is kept only if code finds it word for word in the fetched source page.
- Anything unsupported is cut, and the draft is revised without it.

Tavily's free plan gives 1,000 credits a month ([Tavily credits](https://docs.tavily.com/documentation/api-credits)); at 2 posts a week, 6 claims each and a few news searches, the engine uses about 100 a month.

**Owner decision needed: which Tavily key.**
Recommended: a separate PortfolioRank key (`portfolio-rank/TAVILY_API_KEY` in `pass-env`, a Worker secret), so Wren's allowance and PortfolioRank's can't starve each other.

### 3. Topic filter

- Allowed topics: developer portfolios, hiring and the job market for developers, developer careers and skills, PortfolioRank's own data and method, AI as it touches hiring and developer work, and Gemini model news as it touches our judge.
- Code first drops news results whose title or source matches a short deny list (politics, crime, disasters, named lawsuits, layoffs at a named company).
- The pick step (one Gemini request) labels each idea with a topic and a tone; anything outside the allowed topics, or negative about a person or a company, is skipped.
- The final review (gate 3 runs again on the finished draft, in the same request as the naming check below) fails a draft that drifted off topic or turned hostile.

### 4. The naming rule, as code

- Each fact builder returns the **only** portfolios a post may name: the positive ones (top sites, climbers, redesigns that improved their rating), never anyone on the removal list ([legal/removal.md](legal/removal.md)).
- Code finds every portfolio name, domain and URL in the draft and fails it if any is not on that list.
- Screenshots are allowed only of named, positive sites.
- Low scores, drops and "worst of" lists exist only as aggregates (counts and shares), which the fact builders enforce: they never return a named site with a negative fact.

### 5. Safe images

See "Images" below.
In short: only four sources, every one with a known licence; code records the source, licence and credit of every image; generated illustrations are reviewed and labelled; a slot with no good image gets a chart or nothing.

### 6. Caps, a kill switch and a dry run

- **One switch, `CONTENT_MODE`**, a Worker variable: `off` (default), `dry-run` (drafts go to a private queue only) or `publish`.
  Setting it to `off` stops the stage at the next batch; posts already published stay up.
- **Caps, enforced by code:**

  | Cap | Value |
  | --- | --- |
  | Posts published | 2 in any 7 days, counted in the same database write that publishes |
  | Drafts started | 1 a night |
  | Revision rounds | 2 a draft, then it is dropped |
  | Gemini | the "Content" stage: at most 100 requests and 30 minutes a night, through the budget accountant, after people and the stages before it |
  | Tavily | 10 searches a post, 40 a week |
  | Workers AI images | 9 candidates a post (3 slots x 3) |
  | Newsletter | only through the shared email gate and its caps |

- **Dry run: one week** in `dry-run` before the first real post (see "Dry run" below).

What was in the security review and is left out on purpose: auto-unpublish on contradiction, a similarity check against sources (the quote rule and short excerpts cover it), and a second dry-run week.

## The pipeline

The stages run in the end-of-day run's "Content" stage ([pipeline/night.mjs](../pipeline/night.mjs)), after new grades, changed grades and ranking comparisons.
All Gemini requests are on `gemini-3.5-flash-lite`, logged as job `content`, and asked through the budget accountant, so content never takes from people or from the stages before it.
If the quota is gone, the work waits for the next night; it never falls back to 3.1.

| Stage | What happens | Gemini requests | Other calls |
| --- | --- | ---: | --- |
| 1. Find | Code collects story ideas from the data (see "What it reads"), finished experiments, closed polls, this week's model watch report and up to 4 news searches | 0 | Tavily: up to 4 |
| 2. Pick | One request scores up to 20 ideas for interest, topic and tone, and avoids repeating last week's kind of post; the best 2 go ahead, a third waits as a reserve | 1 | |
| 3. Facts | The idea's fact builder computes the fact sheet, the chart specs and the names the post may use | 0 | |
| 4. Write | One request writes the post in the template's shape, with placeholders for numbers, one image slot spec per image (purpose, kind, alt text), the title, two alternative titles, the share line and a newsletter blurb | 1 | |
| 5. Check | Code: numbers, names, links, length, no em dashes. Gemini: outside claims listed (1), claims judged against searches (1), final review of topic, tone, naming and voice (1) | 3 | Tavily: up to 6; link checks |
| 6. Revise | When a check fails: one rewrite with the failures listed, then stage 5 again; at most twice, then the draft is dropped | 0 to 8 | Tavily: a few |
| 7. Images | Code makes charts and fetches or generates candidates; one Gemini request per slot looks at the candidates and the paragraph and picks one or none; one retry per slot | 3 to 6 | stock APIs, Workers AI |
| 8. Publish | Code stores the post with `publish_at` set to the next morning (08:00 Pacific), marks it for the newsletter, and records it for the owner's weekly summary | 0 | |

A post costs about **9 Gemini requests** when nothing fails and **about 19** at worst.
Two posts a week plus the pick is about 20 to 40 requests a week, a small part of the "Content" stage's 100 a night, which the polls lane shares ([DECISIONS.md](DECISIONS.md#polls)).
At paid rates (MODEL-LIMITS.md, about $0.004 a request with a longer prompt) that is under $0.20 a week.

A typical week:

| Night (Pacific) | Work |
| --- | --- |
| Sunday | Find and pick: 2 ideas, 1 reserve |
| Monday | Post A: facts, write, check, revise, images; published Tuesday 08:00 |
| Wednesday | Post B the same way; published Thursday 08:00 |
| Any night a post fails | The reserve idea gets the next free night |

A busy day for people, when the quota runs out before the night, simply moves a post to the next night.

**Owner decision needed: the publishing days and time.**
Recommended: Tuesday and Thursday at 08:00 Pacific, with the weekly summary to the owner on Sunday.

## What it reads

Only PortfolioRank's own tables, read-only, plus the two outside searches above.

| Source | Tables | Story kinds | Ready? |
| --- | --- | --- | --- |
| Rankings | `site_ratings`, `rank_history`, `comparisons` (ranking v2) | top sites, biggest climbers, redesigns that paid off, AI vs people disagreements (aggregate) | after `RANKING_V2` is switched on ([RANKING.md](../RANKING.md)) |
| Grades | `portfolios` (rubric, facts, page text), `rubric_history` | what high scorers share, trends in roles and stacks, 3.1 vs 3.5 | now |
| Experiments | `comparisons` tagged by method, the Sunday grade comparison, the planned experiments table | "Can one AI request replace ten?", "3.5 vs 3.1: do they grade the same?" | 3.1 vs 3.5 now; the others as experiments finish |
| Polls | the polls lane's closed polls and their totals | "Developers voted: does a portfolio need a resume?" | when polls ship |
| Model watch | `model_watch_runs` (the weekly report) | "Google released a new Flash-Lite. We re-ran the judge." (only after an experiment has run) | when model watch merges |
| Our own running | `gemini_daily`, `night_runs` | build-in-public posts (what the free quota does in a month) | now |

The fact builders are the only code that reads these tables for content.
Each one is small, tested on a fixture database, and returns facts plus the names that may appear.
The first two to build are "3.1 vs 3.5" (data exists today) and "Leaderboard movement" (once ranking v2 is on).

Page text from portfolios is untrusted and never goes to the writer as instructions; for trend stories, code counts things in it (roles, stacks, words) and only the counts reach Gemini.

## Images

Every post has a hero and 2 or 3 inline images (POST_TEMPLATE.md).
Gemini proposes each slot (what it should show, which kind, alt text) while writing; code then fills it from one source, in this order of preference:

| Source | How | Licence and credit | Review |
| --- | --- | --- | --- |
| **Charts made by code** | SVG from the fact sheet, PNG for share cards through the same `next/og` renderer the site already uses for its cards | ours | none needed: drawn from the checked facts; alt text from the slot spec |
| **Real screenshots** | the captures we already store in R2 (`hero.jpg`) | ours; only of named, positive sites, never of anyone on the removal list | code checks the naming rule |
| **Free-licence stock** | Unsplash and Pexels search APIs | Unsplash: hotlink the image URL, call the download endpoint, credit photographer and Unsplash ([docs](https://unsplash.com/documentation)); Pexels: credit the photographer and link Pexels ([docs](https://www.pexels.com/api/documentation/)) | Gemini picks among 3 candidates for fit |
| **Workers AI illustrations** | `@cf/black-forest-labs/flux-1-schnell` on the free allowance (about 170 a day at 1024 x 1024, [ASSUMPTIONS.md](ASSUMPTIONS.md) B4) | generated; captioned "AI-generated illustration" | Gemini looks at 3 candidates and rejects text errors, odd hands or faces, anything resembling a real person, brand logos and fake screenshots of real products |

Rules for all images:

- Never an image found through a web or news search, and never a screenshot of a site that isn't a listed portfolio.
- Code stores each image's source, licence, credit line and the review's verdict with the post.
- A slot that gets no good image after one retry becomes a chart, or is dropped; a post can publish with fewer images, never with a bad one.
- Gemini's paid image model is not used.

**Owner decision needed: stock photos with people in them.**
Recommended: allowed, but never as the hero and never next to a named developer, so a stranger's face can't be read as that developer.

## Where posts live

Two options:

| | Database (recommended) | MDX files in the repository |
| --- | --- | --- |
| How a post goes out | a row in a `posts` table; the blog pages read it, with images in R2 | the pipeline opens a pull request that merges itself, then a deploy |
| Speed | live at `publish_at`, no deploy | a deploy per post (minutes, and a failed CI blocks it) |
| Unpublish or fix | flip a status or edit the row from the admin page, instantly | another pull request and deploy |
| History | the post's fact sheet, checks and images in the database, in the nightly backup | git history |
| Safety | the post body is Markdown rendered with no raw HTML and no scripts | MDX can run code, which is wrong for text an AI wrote |
| Fits the pipeline | the end-of-day run already writes to the database from Cloudflare | needs a GitHub write token on the Worker |

**Owner decision needed: database or MDX.**
Recommended: the database, with Markdown bodies (not MDX) rendered by a strict renderer that allows no raw HTML.

The blog itself is part of the redesign ("Blog `/blog`" in DECISIONS.md "Structure of the redesign"): `/blog`, `/blog/[slug]`, tags, an RSS feed and share images.
Each post shows the AI note with a link to `/about-posts` (the page drafted in [legal/ai-content.md](legal/ai-content.md)) and to its data.

**Owner decision needed: where the AI note sits.**
The security review says a footer; the drafted disclosure page says a line at the top.
Recommended: a short line under the title ("Written with AI from PortfolioRank data") and the fuller note with the data link at the end of the post.

## The newsletter hook

The content engine never sends email itself.

- Publishing a post sets `newsletter_pending` on it.
- The weekly newsletter job (built with the newsletter, DECISIONS.md "A weekly newsletter") collects the posts published since the last issue, adds the top 5 and the biggest climber, and sends through the shared email gate with its hard caps.
- Email goes through Cloudflare Email Service (owner, 2026-11-10, after the content plan was written); the gate is the only code that knows that, so a later change of provider doesn't touch the content engine.
- Until the newsletter exists, `newsletter_pending` just stays set, and the first issue can pick up the latest posts.

**Owner decision needed: the newsletter in a week with no post.**
Recommended: send it anyway with the top 5 and the biggest climber, since those change every week.

## What the owner sees

- **Weekly summary (informed, not asked):** each Sunday, through the owner alerts (the same mechanism as model watch: recorded and shown in the admin view now, emailed once the Cloudflare Email Service sender is wired): what was published, what was dropped and why, Gemini and Tavily use, and anything that hit a cap.
- **Admin page** (part of the redesign's admin area, admin only): drafts, published posts, dropped drafts with their failed checks, the fact sheet and image sources of each post, an unpublish button and the current `CONTENT_MODE`.
- **Corrections:** with no auto-unpublish, a wrong post is fixed or unpublished by the owner from the admin page; each post says "data as of" its fact sheet's date so readers know when the numbers were true.

## Dry run

- One week with `CONTENT_MODE=dry-run`: the full pipeline, the same checks and caps, but posts go to a private queue on the admin page only, never to `/blog`, RSS or the newsletter.
- What it must show before publishing: at least 2 drafts that passed every check, no naming-rule or topic failure that slipped past the checks (the owner can read the drafts), and request counts close to the estimates above.
- The seeded test drafts (wrong numbers, an invented statistic, a low scorer named, instructions hidden in a news result, a generated image with garbled text) run in the test suite before the dry run starts, not in it.

**Owner decision needed: who ends the dry run.**
Recommended: the owner switches `CONTENT_MODE` to `publish` by hand after the week; it never switches itself.

## Model choice

**Owner decision needed: 3.5 for everything, or 3.1 for bulk analysis.**
Recommended: every content request on 3.5 (one consistent writer and reviewer, inside the content stage), and no bulk reading of portfolio text by Gemini in the first version: trend stories count things with code.
The budget page's idea of reading every portfolio's text on 3.1 for trends ("non-ranking analysis", which DECISIONS.md allows on 3.1) can come later as a labelled experiment if code counts turn out too shallow.

## Implementation plan

Each step is one pull request with its risks turned into tests (the security review's process), reviewed before merge.

1. **Owner reads this document and answers the decisions below.**
2. **Storage and the switch:** the `posts` table (body, status, `publish_at`, fact sheet, checks, images with source and licence, `newsletter_pending`), `content_runs` for each night's work and drops, `CONTENT_MODE` defaulting to `off`, and the publish cap in the same write, with no Gemini.
3. **Blog pages** in the redesign: `/blog`, `/blog/[slug]`, tags, RSS, share images, the AI note, `/about-posts`, a strict Markdown renderer; it shows nothing until a post exists.
4. **Fact builders** for "3.1 vs 3.5" and "Leaderboard movement", with charts drawn from the facts; tests on fixture databases, including that no negative fact ever carries a name, with no Gemini.
5. **Writer and code checks:** the write request with placeholders, number filling and the stray-number scan, the naming check, link checks, the template checks, the revision loop and the drop; tested with seeded bad drafts and a mocked Gemini.
6. **Outside claims and the topic filter:** claim listing, Tavily search, the support judgement, the verbatim quote rule, the deny list and the final review; tested with injected instructions in fake search results.
7. **Images:** charts, screenshots, Unsplash and Pexels with credits, Workers AI candidates and the review; tested with seeded bad images.
8. **The night stage:** wire the "Content" stage into the end-of-day run through the accountant (find and pick on Sunday, one post a night on the publishing nights), the caps, and the weekly owner summary.
9. **Dry run:** one week in `dry-run`; the owner switches to `publish`.
10. **After launch:** the newsletter hook is picked up when the newsletter ships; more story kinds as their data arrives (polls, experiments, model watch); news tie-ins once the core runs cleanly.

Steps 2, 3 and 4 can start in parallel; 5 needs 2 and 4; 8 needs 5 to 7.

## Owner decisions needed

1. **Tavily key:** a separate PortfolioRank key (recommended) or Wren's.
2. **Publishing days and time:** Tuesday and Thursday 08:00 Pacific, summary on Sunday (recommended).
3. **Stock photos with people:** allowed, never as the hero or next to a named developer (recommended).
4. **Where posts live:** the database with Markdown bodies (recommended) or MDX files in the repository.
5. **Where the AI note sits:** a short line under the title and the full note with the data link at the end (recommended).
6. **Newsletter in a week with no post:** send the top 5 and the climber anyway (recommended).
7. **Ending the dry run:** the owner switches to `publish` by hand (recommended).
8. **Models:** 3.5 for all content requests, trends counted by code, 3.1 analysis later as an experiment (recommended).
