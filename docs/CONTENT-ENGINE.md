# Content engine design

The design of PortfolioRank's automatic blog.
The owner answered every decision on 2026-11-10 with the recommended option; they are marked **Owner decision** below and collected at the end.
The back end (plan steps 2 and 4 to 8) is built and switched off (`CONTENT_MODE` "off"); see "What is built" at the end.
The blog pages (step 3) come with the redesign.
It turns the content engine plan, the security review, the Gemini budget page and the decisions in [DECISIONS.md](DECISIONS.md) into one buildable design, trimmed to what the owner asked for: "don't overbuild".

Sources, all read on 2026-11-10:

- [Content engine plan](https://claude.ai/artifact/RrodYrSbswXAHSNAzTS42s)
- [Security review](https://claude.ai/artifact/NxQ7yS4P28dhUsiZ2WhKWk), owner decisions at the top
- [Gemini budget](https://claude.ai/artifact/44NyzmGV1NsuenjNPtZNAH), "People first, AI with the leftovers"
- [POST_TEMPLATE.md](content/POST_TEMPLATE.md), [DECISIONS.md](DECISIONS.md), [MODEL-LIMITS.md](MODEL-LIMITS.md), [COSTS.md](COSTS.md), [legal/ai-content.md](legal/ai-content.md)

The owner's choices are marked **Owner decision** where they apply.
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

**Owner decision (2026-11-10): which Tavily key.**
A separate PortfolioRank key (`portfolio-rank/TAVILY_API_KEY` in `pass-env`, a Worker secret), so Wren's allowance and PortfolioRank's can't starve each other.

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
In short: only our charts and screenshots, the owner-approved image library, Pexels and one fresh illustration, every one with a known licence; code records the source, licence, credit and approval of every image; generated illustrations are checked and labelled; a slot with no good image gets a chart or nothing.

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
Two posts a week plus the pick is about 20 to 40 requests a week, a small part of the "Content" stage's 100 a night, which polls share (one poll a week, at most 2 requests a week; [AUTOMATION.md](../AUTOMATION.md#polls)).
At paid rates (MODEL-LIMITS.md, about $0.004 a request with a longer prompt) that is under $0.20 a week.

A typical week:

| Night (Pacific) | Work |
| --- | --- |
| Sunday | Find and pick: 2 ideas, 1 reserve |
| Monday | Post A: facts, write, check, revise, images; published Tuesday 08:00 |
| Wednesday | Post B the same way; published Thursday 08:00 |
| Any night a post fails | The reserve idea gets the next free night |

A busy day for people, when the quota runs out before the night, simply moves a post to the next night.

**Owner decision (2026-11-10): the publishing days and time.**
Tuesday and Thursday at 08:00 Pacific, with the weekly summary to the owner on Sunday.

## What it reads

Only PortfolioRank's own tables, read-only, plus the two outside searches above.

| Source | Tables | Story kinds | Ready? |
| --- | --- | --- | --- |
| Rankings | `site_ratings`, `rank_history`, `comparisons` (ranking v2) | top sites, biggest climbers, redesigns that paid off, AI vs people disagreements (aggregate) | after `RANKING_V2` is switched on ([RANKING.md](../RANKING.md)) |
| Grades | `portfolios` (rubric, facts, page text), `rubric_history` | what high scorers share, trends in roles and stacks, 3.1 vs 3.5 | now |
| Experiments | `comparisons` tagged by method, the Sunday grade comparison, the planned experiments table | "Can one AI request replace ten?", "3.5 vs 3.1: do they grade the same?" | 3.1 vs 3.5 now; the others as experiments finish |
| Polls | closed polls with totals, winner and margin (`pollResults` in [lib/polls/store.mjs](../lib/polls/store.mjs)) | "Developers voted: does a portfolio need a resume?" | back end built (#76); votes once the poll card ships |
| Model watch | `model_watch_runs` (the weekly report) | "Google released a new Flash-Lite. We re-ran the judge." (only after an experiment has run) | built (#74) |
| Our own running | `gemini_daily`, `night_runs` | build-in-public posts (what the free quota does in a month) | now |

The fact builders are the only code that reads these tables for content.
Each one is small, tested on a fixture database, and returns facts plus the names that may appear.
The first two to build are "3.1 vs 3.5" (data exists today) and "Leaderboard movement" (once ranking v2 is on).

Page text from portfolios is untrusted and never goes to the writer as instructions; for trend stories, code counts things in it (roles, stacks, words) and only the counts reach Gemini.

## Images

Every post has a hero and 2 or 3 inline images (POST_TEMPLATE.md).
While writing, Gemini gives each slot a brief at no extra request: the kind (chart, screenshot or picture), what it shows, the mood, 5 keywords and the alt text.
Code then fills each slot once ([pipeline/content/images.mjs](../pipeline/content/images.mjs)), from the first step that works:

| Step | Source | How | Licence and credit | Check |
| ---: | --- | --- | --- | --- |
| 1 | **Charts made by code** and **our screenshots** | SVG from the fact sheet; the captures in R2 (`hero.jpg`), only of named, positive sites | ours | none needed: drawn from the checked facts; code checks the naming rule |
| 2 | **The image library** | the approved image whose tags best match the brief's keywords, not used in the last 10 posts | generated, ours; captioned "AI-generated illustration" | the owner approved it |
| 3 | **Pexels** | one search with the keywords, the top 3, one Gemini look to choose; at most 1 search a slot and 2 a post, counted per month | credit the photographer and link Pexels ([docs](https://www.pexels.com/api/documentation/)) | Gemini rejects text, odd hands or faces, look-alikes of real people, logos and fake screenshots |
| 4 | **One fresh illustration** | Flux Schnell in the house style, center-cropped to 16:9; Lucid Origin only if Schnell errors; at most 1 a post, within the 40 AI images a day | generated; captioned "AI-generated illustration"; it joins the library as pending (or rejected-auto) | one Gemini check on the cropped image ([pipeline/content/workers-ai.mjs](../pipeline/content/workers-ai.mjs)) |
| 5 | **Fallback** | the best library match even if used recently, then an unused chart | as above | as above |

Rules for all images:

- Never an image found through a web or news search, and never a screenshot of a site that isn't a listed portfolio.
- Hard limits: 1 hero and up to 3 inline images, at most 3 Gemini image checks a post, and no retries anywhere: every failure moves to the next step, and a slot with nothing left is dropped; a post can publish with fewer images, never with a bad one.
- Code stores each image's source, licence, credit, caption and approval (owner-approved library image, automatic check, or drawn by code) with the post.
- Never pay: Workers AI only runs within the free daily allowance (below), and Gemini's paid image model is not used.

### The image library

Owner decisions of 2026-11-10 ([DECISIONS.md](DECISIONS.md#content-engine)).
A library of house-style illustrations ([pipeline/content/house-style.mjs](../pipeline/content/house-style.mjs)): strictly flat 2D vector, warm greys with one amber accent, no text, no people, no logos.

- **The queue:** 26 tech-first themes x 5 subjects = 130 images, made in rounds (the first subject of every theme, then the second, and so on), each with alt text and tags for matching.
- **Every night:** the end-of-day run's "Image library" stage ([pipeline/content/library-stage.mjs](../pipeline/content/library-stage.mjs)), after Content, makes up to `LIBRARY_PER_NIGHT` (40) images: one Flux Schnell call each (Lucid Origin only if Schnell errors), a center crop to 16:9 (1024 x 576), one Gemini check of the cropped image with no retry (it rejects any text-like marks, people, logos, 3D and off-style images), then R2 under the private prefix `private/library/<SITE_ENV>/` and a row in `image_library`.
  The queue is done in about 4 nights.
- **Statuses:** `pending` (passed the check, waiting for the owner), `approved`, `rejected` (dropped by the owner), `rejected-auto` (failed the check, kept for the owner to see), `retired`.
  Only approved images are ever used.
  A queue item gets one image, ever; one whose model calls both errored has no row and comes up on a later night.
- **Review:** `/admin/images` (only for `ADMIN_GITHUB_LOGIN`; a 404 for anyone else) lists the pending images with keep and drop, the failed ones (keep one anyway if the check was wrong), and the library with usage counts and a retire button.
  Decisions are POSTs to `/api/admin/library` that must come from the site with a JSON body (CSRF), checked on the server.
- **One batch by hand:** the page's "Make 5 now" button (`POST /api/admin/library/generate`, production only) runs the night stage's work for up to 5 queue items, with the same 40-images-a-day limit, the "library" stage's Gemini cap and no retries.
  Setting `LIBRARY_PER_NIGHT` to "0" stops the nightly work; `LIBRARY_MODEL` "flux2dev" switches the library to Flux 2 Dev (multipart input, 1024 x 576 and 16 steps so it fits the 2,500-neuron guard, 2,400 neurons an image, so one a day).
- **The never-pay guard** ([lib/content/neurons.mjs](../lib/content/neurons.mjs)): **at most 40 AI images a UTC day** (`MAX_AI_IMAGES_PER_DAY`), counted per image, for the library and the posts together.
  Behind it, at most 2,500 neurons a UTC day (`AI_NEURON_CEILING`; 40 Schnell images are about 2,320), half of PortfolioRank's 5,000 slice of the account's free 10,000 ([COSTS.md](COSTS.md#workers-ai)); Cloudflare resets the allowance at 00:00 UTC.
  Before every call, one image and the call's estimated neurons are reserved for the day (`ai_image_days`) in one statement that only succeeds while both stay within their limits; a failed reservation skips the call, with no retry, and a reservation is never given back.
  Either setting above its maximum (or not a whole number) is rejected and turns Workers AI off; staging's limits are 0.
  Estimates round partial tiles up: Schnell 58, Lucid Origin 1,512 (768 x 432, 20 steps), Flux 2 Dev 2,400 (1024 x 576, 16 steps).
  "AI images today: N of 40" shows on `/admin/images` and in `GET /api/admin/quota`.
- **Seed:** the round-1 and round-2 sample images were not imported; the nightly run makes the same subjects in the final house style.

**Owner decision (2026-11-10): stock photos with people in them.**
Allowed, but never as the hero and never next to a named developer, so a stranger's face can't be read as that developer.

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

**Owner decision (2026-11-10): database or MDX.**
The database, with Markdown bodies (not MDX) rendered by a strict renderer that allows no raw HTML.

The blog itself is part of the redesign ("Blog `/blog`" in DECISIONS.md "Structure of the redesign"): `/blog`, `/blog/[slug]`, tags, an RSS feed and share images.
Each post shows the AI note with a link to `/about-posts` (the page drafted in [legal/ai-content.md](legal/ai-content.md)) and to its data.

**Owner decision (2026-11-10): where the AI note sits.**
The security review says a footer; the drafted disclosure page says a line at the top.
A short line under the title ("Written with AI from PortfolioRank data") and the fuller note with the data link at the end of the post.

## The newsletter hook

The content engine never sends email itself.

- Publishing a post sets `newsletter_pending` on it.
- The weekly newsletter job (built with the newsletter, DECISIONS.md "A weekly newsletter") collects the posts published since the last issue, adds the top 5 and the biggest climber, and sends through the shared email gate with its hard caps.
- Email goes through Cloudflare Email Service (owner, 2026-11-10, after the content plan was written); the gate is the only code that knows that, so a later change of provider doesn't touch the content engine.
- Until the newsletter exists, `newsletter_pending` just stays set, and the first issue can pick up the latest posts.

**Owner decision (2026-11-10): the newsletter in a week with no post.**
Send it anyway with the top 5 and the biggest climber, since those change every week.

## What the owner sees

- **Weekly summary (informed, not asked):** each Sunday, through the owner alerts (the same mechanism as model watch: recorded and shown in the admin view now, emailed once the Cloudflare Email Service sender is wired): what was published, what was dropped and why, Gemini and Tavily use, and anything that hit a cap.
- **Admin page** (part of the redesign's admin area, admin only): drafts, published posts, dropped drafts with their failed checks, the fact sheet and image sources of each post, an unpublish button and the current `CONTENT_MODE`.
- **Corrections:** with no auto-unpublish, a wrong post is fixed or unpublished by the owner from the admin page; each post says "data as of" its fact sheet's date so readers know when the numbers were true.

## Dry run

- One week with `CONTENT_MODE=dry-run`: the full pipeline, the same checks and caps, but posts go to a private queue on the admin page only, never to `/blog`, RSS or the newsletter.
- What it must show before publishing: at least 2 drafts that passed every check, no naming-rule or topic failure that slipped past the checks (the owner can read the drafts), and request counts close to the estimates above.
- The seeded test drafts (wrong numbers, an invented statistic, a low scorer named, instructions hidden in a news result, a generated image with garbled text) run in the test suite before the dry run starts, not in it.

**Owner decision (2026-11-10): who ends the dry run.**
The owner switches `CONTENT_MODE` to `publish` by hand after the week; it never switches itself.

## Model choice

**Owner decision (2026-11-10): 3.5 for everything, or 3.1 for bulk analysis.**
Every content request on 3.5 (one consistent writer and reviewer, inside the content stage), and no bulk reading of portfolio text by Gemini in the first version: trend stories count things with code.
The budget page's idea of reading every portfolio's text on 3.1 for trends ("non-ranking analysis", which DECISIONS.md allows on 3.1) can come later as a labelled experiment if code counts turn out too shallow.

## Implementation plan

Each step is one pull request with its risks turned into tests (the security review's process), reviewed before merge.

1. **Owner reads this document and answers the decisions below.**
2. **Storage and the switch:** the `posts` table (body, status, `publish_at`, fact sheet, checks, images with source and licence, `newsletter_pending`), `content_runs` for each night's work and drops, `CONTENT_MODE` defaulting to `off`, and the publish cap in the same write, with no Gemini.
3. **Blog pages** in the redesign: `/blog`, `/blog/[slug]`, tags, RSS, share images, the AI note, `/about-posts`, a strict Markdown renderer; it shows nothing until a post exists.
4. **Fact builders** for "3.1 vs 3.5" and "Leaderboard movement", with charts drawn from the facts; tests on fixture databases, including that no negative fact ever carries a name, with no Gemini.
5. **Writer and code checks:** the write request with placeholders, number filling and the stray-number scan, the naming check, link checks, the template checks, the revision loop and the drop; tested with seeded bad drafts and a mocked Gemini.
6. **Outside claims and the topic filter:** claim listing, Tavily search, the support judgement, the verbatim quote rule, the deny list and the final review; tested with injected instructions in fake search results.
7. **Images:** charts, screenshots, the approved image library, Pexels with credits, one fresh illustration with one check, the never-pay neuron guard; tested with seeded bad images.
8. **The night stage:** wire the "Content" stage into the end-of-day run through the accountant (find and pick on Sunday, one post a night on the publishing nights), the caps, and the weekly owner summary.
9. **Dry run:** one week in `dry-run`; the owner switches to `publish`.
10. **After launch:** the newsletter hook is picked up when the newsletter ships; more story kinds as their data arrives (polls, experiments, model watch); news tie-ins once the core runs cleanly.

Steps 2, 3 and 4 can start in parallel; 5 needs 2 and 4; 8 needs 5 to 7.

## Owner decisions (answered 2026-11-10)

The owner chose every recommended option:

1. **Tavily key:** a separate PortfolioRank key, `portfolio-rank/TAVILY_API_KEY`.
2. **Publishing days and time:** Tuesday and Thursday 08:00 Pacific, the summary on Sunday.
3. **Stock photos with people:** allowed, never as the hero or next to a named developer.
4. **Where posts live:** the database, with Markdown bodies.
5. **Where the AI note sits:** a short line under the title and the full note with the data link at the end.
6. **Newsletter in a week with no post:** it still sends, with the top 5 and the climber.
7. **Ending the dry run:** the owner switches `CONTENT_MODE` to `publish` by hand.
8. **Models:** `gemini-3.5-flash-lite` for all content requests, trends counted by code, 3.1 analysis later as an experiment.

## What is built

The back end, in dry-run shape and switched off (`CONTENT_MODE` "off" in both Worker environments).

| Part | Where |
| --- | --- |
| Tables `posts` and `content_runs` (schema version 6), the switch, the publish cap in the same write, the admin read | [lib/content/schema.mjs](../lib/content/schema.mjs), [lib/content/store.mjs](../lib/content/store.mjs) |
| Fact builders: "3.1 vs 3.5" and "Leaderboard movement" as planned, plus "What the best-graded portfolios share" and "Dark mode, motion and page weight", which read today's grades and capture measurements, so there is something to write while the first two wait for re-grades and ranking v2 | [pipeline/content/facts.mjs](../pipeline/content/facts.mjs) |
| Charts drawn from the facts (SVG) | [pipeline/content/charts.mjs](../pipeline/content/charts.mjs) |
| The writer, placeholders and filling, the revision request | [pipeline/content/writer.mjs](../pipeline/content/writer.mjs) |
| Code checks: stray numbers, the naming rule, links, the template | [pipeline/content/checks.mjs](../pipeline/content/checks.mjs) |
| Outside claims through Tavily, the verbatim quote rule | [pipeline/content/claims.mjs](../pipeline/content/claims.mjs) |
| The topic filter: deny list, pick, final review | [pipeline/content/topic.mjs](../pipeline/content/topic.mjs) |
| Images: charts, R2 screenshots, the image library, Pexels, one fresh illustration with one check | [pipeline/content/images.mjs](../pipeline/content/images.mjs) |
| The night stage, the schedule, the caps, the weekly owner summary | [pipeline/content/engine.mjs](../pipeline/content/engine.mjs), wired in [pipeline/night.mjs](../pipeline/night.mjs) and [worker/night.ts](../worker/night.ts) |
| Admin review of drafts (JSON) | `GET /api/admin/content` ([app/api/admin/content/route.ts](../app/api/admin/content/route.ts)) |
| The image library: queue, night stage, review page, never-pay guard, Pexels counter | [lib/content/library.mjs](../lib/content/library.mjs), [pipeline/content/library-stage.mjs](../pipeline/content/library-stage.mjs), [app/admin/images/page.tsx](../app/admin/images/page.tsx), [lib/content/neurons.mjs](../lib/content/neurons.mjs), [lib/content/pexels-searches.mjs](../lib/content/pexels-searches.mjs) |

How it runs, in short:

- The Content stage runs the weekly polls first, then one content job a night while `CONTENT_MODE` is not "off": the pick on Sunday night (or the first night of a week without one), a draft on Monday and Wednesday nights, and a later night when an earlier draft of the week was dropped or deferred.
- A draft runs in one batch and never spends more than that batch has left (at most 20 requests); it needs at least 4 to start, else it waits for the next night.
- One round is the write request, the claim listing, the claim judgement (only when Tavily found results) and the final review; a failed round is revised, at most twice, then the draft is stored as `dropped` with its failures.
- Outside claims are cut by code (exact sentences), not by a rewrite; a rewrite happens only when a code check or the review fails.
- The writer gets each fact's placeholder, label and display, never its raw value or query; code assembles the TL;DR block, the image markers and the call to action, and puts each sentence on its own line.
- The number check allows years, list numbers, the Gemini model names, the rubric's "1 to 5", the post's allowed names and addresses, and the sentences of supported outside claims; the template's 250 to 400 words get 10% slack.
- Charts are stored in the `SHOTS` bucket under `content/<SITE_ENV>/<post id>/` and illustrations under `private/library/<SITE_ENV>/`, which `/shots` does not serve; the blog lane serves them.
  Pexels photos are hotlinked with their credit.
- Each optional source is skipped cleanly: without `TAVILY_API_KEY` every outside claim is cut; without `PEXELS_API_KEY` the Pexels step is skipped; without the `AI` binding (or with no neuron room) the fresh illustration is skipped.
- The weekly summary is an owner alert of kind "info" (`content-weekly`) on Sunday nights while the engine is on.
- The checks beyond the template live in [pipeline/content/quality.mjs](../pipeline/content/quality.mjs) (paragraphs, superlatives and ties, callout, hook, actions); the review preview is [pipeline/content/preview.mjs](../pipeline/content/preview.mjs); `WRITER_MODE` ("staged" by default, or "single"; [pipeline/content/staged.mjs](../pipeline/content/staged.mjs)) picks how the first draft is written: staged is an outline, two section requests and a finish request (4 requests, 5 after an outline retry), single is one request.
- Tests: [tests/content.test.mjs](../tests/content.test.mjs), [tests/admin-content.test.mjs](../tests/admin-content.test.mjs), [tests/image-library.test.mjs](../tests/image-library.test.mjs) and [tests/admin-library.test.mjs](../tests/admin-library.test.mjs).
