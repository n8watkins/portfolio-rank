# Content engine design

The design of PortfolioRank's automatic blog.
The owner answered every decision on 2026-11-10 with the recommended option; they are marked **Owner decision** below and collected at the end.
The back end (plan steps 2 and 4 to 8) is built and switched off (`CONTENT_MODE` "off"); see "What is built" at the end.
The blog pages (step 3) and the owner's review are built ("Review and publish").
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
- **Fail-closed, and the owner approves every post** (2026-11-11, replacing "no review step"): a draft that fails its checks is dropped; one that passes waits on `/admin/blog` until the owner publishes or rejects it (see "Review and publish").
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
  | Drafts started | 1 a night, plus at most 5 a Pacific day from "Write a draft now" |
  | Revision rounds | 2 a draft, then it is dropped |
  | Gemini | the "Content" stage: at most 100 requests and 30 minutes a night, through the budget accountant, after people and the stages before it |
  | Tavily | 10 searches a post, 50 a week (a quarter of the monthly 200) |
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
| Rankings | `rank_history` (ranking v2) | trends across the leaderboard: top sites and biggest climbers (`leaderboard-movement`) | after `RANKING_V2` is switched on ([RANKING.md](../RANKING.md)) |
| Grades | `portfolios` (rubric, capture measurements) | what the AI grader rewards and penalizes (`top-grades`), dark mode, motion, phones and page weight (`page-craft`) | now |
| Re-grades | `rubric_history` (same model and rubric version only) | how portfolios change: before and after a page change (`regrade-changes`) | as re-grades after page changes accumulate |
| People's votes | `votes` with both sites' grades and measurements | what people vote for and against (`vote-patterns`) | once 40 votes between graded portfolios exist |
| Polls | closed polls with totals, winner and margin (`pollResults` in [lib/polls/store.mjs](../lib/polls/store.mjs)) | "Developers voted: does a portfolio need a resume?" | back end built (#76); votes once the poll card ships |

Owner direction of 2026-11-11 ("Owner direction" below): no story is about how PortfolioRank is built or run, so the model comparison (3.1 vs 3.5), model watch news and build-in-public posts from `gemini_daily` and `night_runs` are not story kinds.
The fact builders are the only code that reads these tables for content.
Each one is small, tested on a fixture database, and returns facts plus the names that may appear.

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
  The owner can edit a queued subject's wording, skip it or reset it on `/admin/images` ("Up next", `POST /api/admin/library/queue`, table `image_library_overrides`); a subject that already has an image can't change.
- **Alt text and tags:** every image gets short, specific alt text when it is made (the built-in subjects have hand-written alt text; an edited or custom subject gets one from its words and its theme, at most 160 characters) and tags: the theme's tags, then the subject's keywords without the house-style filler words; the style ("flat vector") shows as a tag but is never matched against a brief.
  Both are editable on the image's card; the page searches alt text, subjects and tags, and filters by tag.
- **Every hour:** the Worker's hourly tick ([worker/library.ts](../worker/library.ts), the existing `15 * * * *` cron, [pipeline/content/library-stage.mjs](../pipeline/content/library-stage.mjs)) makes up to `LIBRARY_PER_HOUR` (40, owner 2026-11-11; the day's 40 is the only real limit, so the first tick of a UTC day can use all of it, and the night's post then fills its slots from the library, Pexels or a chart instead of a fresh illustration) images, except from 20:00 to midnight Pacific: one Flux Schnell call each through the `portfoliorank-ai` gateway (Lucid Origin only if Schnell errors), a center crop to 16:9 (1024 x 576), one Gemini check of the cropped image with no retry (it rejects any text-like marks, people, logos, 3D and off-style images), then R2 under the private prefix `private/library/<SITE_ENV>/` and a row in `image_library`.
  At up to 40 a day, the queue is done in about 4 days.
  The night's "Image library" stage is only the Gemini cap for job `library` (40 a day); it does no work in the night.
- **Statuses:** `pending` (passed the check, waiting for the owner), `approved`, `rejected` (dropped by the owner), `rejected-auto` (failed the check, kept for the owner to see), `retired`.
  Only approved images are ever used.
  A queue item gets one image, ever; one whose model calls both errored has no row and comes up on a later night.
- **Review:** `/admin/images` (only for the account in `ADMIN_GITHUB_ID`; a 404 for anyone else) is a thumbnail grid under tabs that stay in view: To review (pending images, with Approve and Drop on each thumbnail), Approved (with Retire), Dropped, Failed check (approve one anyway if the check was wrong) and All, each with its count.
  It opens on To review, or on Approved when nothing waits for review.
  A thumbnail opens the image large with its alt text and tags (editable), its decision (A approves, D drops, the arrows step through the tab) and the drafts tied to it; the tab and the open image are in the address (`?view=`, `?image=`), and Back closes the large view.
  Make now, Make your own, Up next and "How images are made" are compact panels beside the grid (below it on phones).
  Drop takes the image out at once and shows an Undo toast; Undo puts it back where it was (`restore`).
  Decisions are POSTs to `/api/admin/library` that must come from the site with a JSON body (CSRF), checked on the server.
  Nothing on the page, and nothing in the engine, deletes an image: rejecting or unpublishing a post leaves its images, their uses and their associations as they are.
- **Associations:** the large view lists the drafts and posts the image is tied to, with their status: "used in" (`image_library_uses`), "considered for" (up to 3 close tag matches a slot looked at and did not pick, `image_library_considered`) and "made for" (a post's fresh illustration).
- **Make now** (`POST /api/admin/library/generate`, production only): the owner picks 1, 2, 5 or 10, or "Make up to N" (all that is left of the day), or a single subject of their own ("Make your own": a subject of 8 to 300 characters after cleaning and an optional theme, with a preview of the final prompt with the house style).
  The page asks for one image a request, so it shows "Making 1 of 2... about 5 seconds each" with the day's and the hour's counts next to the button.
  Every answer says what happened in plain words: "Made N", "Today's 40 are used", "Today's neuron allowance is used", "Paused 8 pm to midnight Pacific", or, for the AI Gateway's own 429, "The AI Gateway allows N an hour: raise it in AI Gateway settings".
  Same limits as the tick (40 a day, 2,500 neurons, quiet in the evening), the same Gemini check within the "library" job's cap, no retries; a custom subject never uses up a queue slot.
  Setting `LIBRARY_PER_HOUR` to "0" stops all library work; `LIBRARY_MODEL` "flux2dev" switches the library to Flux 2 Dev (multipart input, 1024 x 576 and 16 steps so it fits the 2,500-neuron guard, 2,400 neurons an image, so one a day).
- **How images are made:** a panel on the page, read from the existing counters with no metered call: the model and its neurons an image, the cost ($0), made today of 40 (no hourly cap), this hour, this month and all time, kept, dropped and retired, today's neurons as a share of the 2,500 slice, the fallback model, whether Flux 2 Dev is on, and how many posts used a library image.
- **The never-pay guard** ([lib/content/neurons.mjs](../lib/content/neurons.mjs)): **at most 40 AI images a UTC day** (`MAX_AI_IMAGES_PER_DAY`) with no hourly cap of its own (owner, 2026-11-11: the code's 40 a day is the only real limit, replacing 2 an hour; the AI Gateway's 40 per 3,600 seconds only bounds a burst and is not sized to stay free), counted per image, for the library and the posts together; every call goes through the `portfoliorank-ai` AI Gateway ([lib/ai-gateway.mjs](../lib/ai-gateway.mjs), [AI-GATEWAY.md](AI-GATEWAY.md)), whose 429 means stop, with no retry.
  Behind it, at most 2,500 neurons a UTC day (`AI_NEURON_CEILING`; 40 Schnell images are about 2,320), half of PortfolioRank's 5,000 slice of the account's free 10,000 ([COSTS.md](COSTS.md#workers-ai)); Cloudflare resets the allowance at 00:00 UTC.
  Before every call, one image and the call's estimated neurons are reserved (`ai_image_calls`, one row per call) in one statement that only succeeds while the day's images and the day's neurons stay within their limits (the rolling hour is counted against the same 40, so it never stops a call first); a failed reservation skips the call, with no retry, and a reservation is never given back.
  Any setting above its maximum (or not a whole number) is rejected and turns Workers AI off; staging's limits are 0.
  Estimates round partial tiles up: Schnell 58, Lucid Origin 1,512 (768 x 432, 20 steps), Flux 2 Dev 2,400 (1024 x 576, 16 steps).
  Today's images, the hour's images and the neurons show on `/admin/images` and in `GET /api/admin/quota`.
- **Seed:** the round-1 and round-2 sample images were not imported; the hourly tick makes the same subjects in the final house style.

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

## Review and publish

Owner decision of 2026-11-11: the engine writes drafts, the owner approves each one before it publishes.

- **Draft mode** is `CONTENT_MODE` "dry-run": every draft that passes its checks is stored as `draft` with its scheduled `publish_at` (the next 08:00 Pacific); nothing reaches `/blog`, RSS or the newsletter on its own.
  "publish" (automatic publishing) stays in the code and is not used.
- **The queue,** `/admin/blog` (only the `ADMIN_GITHUB_ID` account; a 404 for anyone else): drafts waiting for review, published and scheduled posts, and rejected, dropped or unpublished ones with why.
- **The review page,** `/admin/blog/[id]`: the post exactly as readers will see it (the same article component as `/blog/[slug]`), with Publish and Reject on top and, under it, the checks of every round, the outside claims kept and cut, the fact sheet and each image's source, licence and approval.
- **Publish now and Schedule** (`POST /api/admin/content/<id>`, same-origin JSON like the image library's): "Publish now" (`{ "action": "publish_now" }`, owner 2026-11-12) puts a draft live at once, and also a published post whose time is still ahead; "Schedule for <its 08:00 Pacific slot>" (`{ "action": "publish" }`) publishes for that time while it is still ahead (once it has passed, only Publish now is offered).
  Either way the cap of 2 posts in any 7 days is counted in the same write, and a full week answers "weekly cap" and leaves the post as it is; publishing sets `newsletter_pending`.
- **Reject** a draft or **Unpublish** a published post, each with an optional note; every decision is kept on the post as `checks.owner` (action, who, when, note).
- **Links to portfolios** go to the portfolio's PortfolioRank page (`/p/<url>`), which links on to the site (owner, 2026-11-12; [lib/content/portfolio-links.mjs](../lib/content/portfolio-links.mjs)): the engine stores a new post with every `[Name](site_url)` of a portfolio on its fact sheet pointing at our page (after the checks, which still check and load the site itself), and the article renderer sends any link that matches a portfolio we list (`data/feed.json`, the list `/p/` answers for) to its page, so older posts link the same way; a stored `/p/` link to a portfolio no longer listed opens the site instead of a 404.
  Outside sources keep their own addresses.
- **More articles:** under a post, up to 3 other published posts, those sharing the most tags first, then the newest (`morePosts` in [lib/content/blog.mjs](../lib/content/blog.mjs)).
  There is no newsletter sign-up yet: the newsletter is planned (DECISIONS.md "A weekly newsletter") but has no back end here, in mailroom (which is transactional only) or elsewhere, so the post page shows none rather than a form that goes nowhere.
- **The pages** are ISR with a 5-minute revalidate, so a published post is on `/blog`, its tag pages and the feed within 5 minutes of its publish time, and anonymous visitors cost no database read in between; the sitemap lists posts once a day.
  Drafts and unpublished posts are a 404 on `/blog/[slug]`; their images (`/blog/media/<post id>/<slot>`) are served only to the admin, and a live post's images are public and cached for a day.

## Owner direction (2026-11-11): about portfolios, short, with a payoff

After reading the 2026-11-10 drafts the owner found them trite and too long for what they said, and the build-in-public postmortem ("my key wasn't working") was exactly what the blog must not be.

- **About portfolios, never about building PortfolioRank.**
  No bug postmortems, build-in-public, what the site costs to run, our stack, our pipeline or our model setup.
  These are gone from the engine, not only from the prompt: the "3.1 vs 3.5" model comparison is no longer a story kind, the allowed topics (`TOPICS` in [pipeline/content/topic.mjs](../pipeline/content/topic.mjs)) no longer include "PortfolioRank data and method" or "Gemini model news", and the final review fails a post about how the site is built or run.
- **The topics:** what people vote for and against (`vote-patterns`, from people's head-to-head votes), what the AI grader rewards and penalizes (`top-grades`, and `page-craft` for dark mode, motion, phones and page weight), how portfolios change over time (`regrade-changes`: same-judge re-grades before and after a page change), trends across the leaderboard (`leaderboard-movement`), new portfolios worth seeing, and portfolio or developer-hiring news with a real angle.
  "New portfolios worth seeing" and hiring news are not built yet: the roster stores no date a portfolio was added, and news needs its own builder with Tavily searches.
- **Shorter, with a payoff:** every post states one clear takeaway a reader can use on their own portfolio, early: the opener ends with it, addressed to the reader.
  About 500 to 800 words unless the data earns more (the template check allows 475 to 840), with throat-clearing and anecdotes that don't pay off cut.
- **Facts:** no claim about PortfolioRank's infrastructure (one draft said "Amazon SES"; email goes through the Cloudflare mailroom), and any fact the writer can't source from our data or a cited link is cut (gate 2 already cuts unsupported outside claims).
- **Enforced by code before review:** the editorial check ([pipeline/content/scorecard.mjs](../pipeline/content/scorecard.mjs) `editorialChecks`, run with the other code checks) fails a draft with dev meta or infrastructure words (our pipeline, stack or costs, a postmortem, "we built", vendors such as Amazon SES, Cloudflare, Turso or Tavily, model versions and quotas) or without a takeaway for the reader in its first 150 words.
  A failing draft is revised with the problem listed, then dropped, so it never reaches the review queue; the scorecard shows the same two rules on every draft.

## Write a draft now

The owner's draft on demand, from `/admin/blog` (only the `ADMIN_GITHUB_ID` account).

- **What it does:** an optional topic or angle (at most 200 characters) and an optional story kind (else the ready kind whose latest post is oldest), then the same writer, outside-claim research, images and code checks as the night ([pipeline/content/manual.mjs](../pipeline/content/manual.mjs) runs [pipeline/content/engine.mjs](../pipeline/content/engine.mjs) `runDraft`); the angle steers the writer over the same facts.
- **Background job with live status:** `POST /api/admin/content/draft` queues a row in `content_jobs` ([lib/content/jobs.mjs](../lib/content/jobs.mjs)) and starts the `DraftWorkflow` ([worker/draft.ts](../worker/draft.ts), Workflow `portfolio-rank-draft`, binding `DRAFT`), so the draft can take its minutes after the request returns.
  While it runs, the job is the first row of "Waiting for you": the step it is on (Reading the data, Writing, Researching, Checking, Picking images, Saving), the time so far and "usually 1 to 3 minutes"; the row polls `GET /api/admin/content/draft?id=<job>` every 3 seconds, and the server renders it on every load, so it survives a refresh and the owner can leave the page.
  When the job ends the page refreshes and the draft is in the list; the "Write a draft now" panel keeps the last outcome and what it spent.
  Production only (the Gemini key and the counters live there); each try is one Workflow step the platform never retries, so a draft never spends its caps twice.
- **When Google's AI is busy** (owner, 2026-11-12, after a draft failed on three 503s in a row; [pipeline/content/busy.mjs](../pipeline/content/busy.mjs)): each request waits about 15, 45 and 90 seconds between tries (jittered from half to one and a half times), and after one busy retry on 3.5 Flash-Lite it goes to 3.1 Flash-Lite for the rest of its tries.
  Both are free-tier models with their own daily quota, so the backup never touches the quota kept for people's grades, and a draft still spends at most its request budget whichever model answers.
  When a request still gets no answer, the try ends with the job waiting ("Google's AI is busy. Retrying at 3:42 PM PT (try 2 of 4).") and the Workflow sleeps 15, 20, then 30 minutes before the next try; after 4 tries the job fails with a plain message.
  A later try gets only what the earlier ones left of the draft's 20 requests, and the run is recorded as `deferred`, not `failed`.
  The night does the same: its Content stage pauses 15, 20, then 30 minutes and drafts again (the pause doesn't count against the stage's time cap, and never runs past the hard stop); a spent daily quota or a rejected key still stops, as before.
- **Attempts and answers:** the job shows Gemini attempts and answered requests apart, from the request log (`run_id` `manual:<job>`): a request Google turns away while busy does no work and is not billed on the free tier, but the budget accountant counts every attempt against the day anyway, to stay on the safe side.
  ("Spent: 0 Gemini requests" on a draft that failed on three 503s was wrong both ways: it made 4 attempts, all turned away, and the job forgot what the try spent when it failed.)
- **Caps:** at most 20 Gemini requests a draft (about 9 when it passes first time), and never more than the "content" job may spend today after the reserve the budget accountant keeps for people's grades, so people's grading is never starved; Tavily 10 a post (the weekly cap is now 50, a quarter of the monthly 200, raised from 40 so drafts on demand fit beside the nights; the month's 200 stays the hard cap); Pexels 2 a post; 1 fresh AI image a post within the day's 40; at most 5 manual drafts (new ones and rewrites together) a Pacific day, counted in the statement that queues one.
- **Never publishes by itself:** a manual draft is stored as a draft whatever `CONTENT_MODE` says, and recorded in `content_runs` as step `manual`, which the night's schedule does not count.
- **The cost panel** ([lib/content/costs.mjs](../lib/content/costs.mjs)), from the existing counters with no metered call: Gemini today (used, left, the reserve kept for people, what a draft may take now), Tavily this month and this week, AI images today and Pexels this month, and drafts today of 5.
- **From the command line:** `wrangler workflows trigger portfolio-rank-draft '{"topic":"..."}'` queues and writes one draft under the same daily cap; only someone with the account's Cloudflare API token can run it.
- **Images:** a slot's library match now also counts the post's own tags, so the writer prefers approved library images that fit the whole post.

## Automation

Owner request of 2026-11-12: the schedule is the owner's to change from `/admin/blog`, without a deploy ([lib/content/automation.mjs](../lib/content/automation.mjs), tables `content_settings` and `content_topics`).

- **The panel** ("Automation" on `/admin/blog`): on or off; the drafting nights (Monday to Saturday; Sunday night picks the week's ideas); drafts a week; "Drafts for my review" (the default) or "Publish automatically", behind a warning; an optional topic queue; and "Next run" and "Last run" lines with the result.
- **Read by the night:** the Content stage's `contentJob` reads the settings at every batch; a change applies from that night's run.
- **The config is the ceiling:** `CONTENT_MODE` "off" turns everything off whatever is saved; "dry-run" allows drafts for review only; only "publish" lets the page choose publishing automatically.
  `CONTENT_DRAFTS_PER_WEEK` (2, at most 4) is the most drafts a week the page may ask for, and one draft a night still holds, so drafts a week never exceed the nights chosen.
  The API refuses a value above the ceiling; a saved value a later config lowered is clamped when read.
- **Fail closed:** when the settings can't be read (a missing table, a row that isn't valid JSON), the night writes nothing and the panel says why.
- **Before the owner saves:** the config's schedule applies (Monday and Wednesday, `CONTENT_DRAFTS_PER_WEEK` drafts, for review while `CONTENT_MODE` allows any).
- **Publishing automatically** keeps every limit: 2 published posts in any 7 days, the 08:00 Pacific slot, and a clean quality scorecard; a draft the scorecard flags is kept for review with the reason (`checks.publishHeld`).
- **The topic queue:** at most 20 topics of at most 200 characters; the next scheduled draft takes the first one as its angle (the same `focus` as Write a draft now), and the week's pick still chooses the data it is written from; a used topic is marked with its post, and a dropped draft marks it dropped.
- **API:** `GET` and `POST /api/admin/content/automation` (`{ op: "save", settings }`, `{ op: "add-topic", topic }`, `{ op: "remove-topic", id }`), admin only, POSTs with this site's Origin and a JSON body.

## Quality tools

- **Reject with notes, and "Rewrite with these notes":** on the review page, Reject keeps the owner's note on the draft; "Rewrite with these notes" rejects the draft with the notes and starts a new draft of the same kind and angle with the notes passed to the writer as `owner_notes` (same caps as Write a draft now; a rejected or dropped draft can be rewritten too).
- **The editor's guidelines** (`/admin/blog/guidelines`, [lib/content/guidelines.mjs](../lib/content/guidelines.mjs), table `content_guidelines`): a list of at most 20 rules of at most 200 characters (2,000 in all) that goes into every writer request as `editor_guidelines`, the night's and the manual ones.
  The page offers the owner's notes from rejected and rewritten drafts to turn into rules.
- **The scorecard** ([pipeline/content/scorecard.mjs](../pipeline/content/scorecard.mjs)), on each review page, plain code: words against 500 to 800, a takeaway in the first 150 words, no dev meta, the reading level (Flesch-Kincaid grade, flagged above 11), real portfolio examples named, sources cited, claims cut, images with alt text and repeated four-word phrases.
- **Compare** (`/admin/blog/compare?a=<id>&b=<id>`): two drafts side by side with their scorecards; the review page links every other draft on the same story.
- **Style guide:** the shape and rules are [docs/content/POST_TEMPLATE.md](content/POST_TEMPLATE.md); the voice is the owner's `VOICE.md` (in the owner's writing skill, outside this repository), which the writer's system instruction ([pipeline/content/writer.mjs](../pipeline/content/writer.mjs)) restates; the editor's guidelines are the owner's own additions, and there is no other style guide.

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
Changed by the owner on 2026-11-12: when 3.5 is busy, a content request falls back to 3.1 Flash-Lite (free tier) rather than failing ("When Google's AI is busy" under "Write a draft now"); grades and votes stay on 3.5 alone.
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
| Fact builders: what the AI grader rewards and penalizes, dark mode, motion and page weight, what people vote for and against, before and after a re-grade, and leaderboard movement (the "3.1 vs 3.5" builder was removed on 2026-11-11: dev meta) | [pipeline/content/facts.mjs](../pipeline/content/facts.mjs) |
| Write a draft now, rewrites, the cost panel | [pipeline/content/manual.mjs](../pipeline/content/manual.mjs), [worker/draft.ts](../worker/draft.ts), [lib/content/jobs.mjs](../lib/content/jobs.mjs), [lib/content/costs.mjs](../lib/content/costs.mjs), [app/api/admin/content/draft/route.ts](../app/api/admin/content/draft/route.ts) |
| The scorecard and the editorial checks, the editor's guidelines, compare | [pipeline/content/scorecard.mjs](../pipeline/content/scorecard.mjs), [lib/content/guidelines.mjs](../lib/content/guidelines.mjs), [app/admin/(tools)/blog/guidelines](<../app/admin/(tools)/blog/guidelines>), [app/admin/(tools)/blog/compare](<../app/admin/(tools)/blog/compare>) |
| Charts drawn from the facts (SVG) | [pipeline/content/charts.mjs](../pipeline/content/charts.mjs) |
| The writer, placeholders and filling, the revision request | [pipeline/content/writer.mjs](../pipeline/content/writer.mjs) |
| Code checks: stray numbers, the naming rule, links, the template | [pipeline/content/checks.mjs](../pipeline/content/checks.mjs) |
| Outside claims through Tavily, the verbatim quote rule | [pipeline/content/claims.mjs](../pipeline/content/claims.mjs) |
| The topic filter: deny list, pick, final review | [pipeline/content/topic.mjs](../pipeline/content/topic.mjs) |
| Images: charts, R2 screenshots, the image library, Pexels, one fresh illustration with one check | [pipeline/content/images.mjs](../pipeline/content/images.mjs) |
| The night stage, the schedule, the caps, the weekly owner summary | [pipeline/content/engine.mjs](../pipeline/content/engine.mjs), wired in [pipeline/night.mjs](../pipeline/night.mjs) and [worker/night.ts](../worker/night.ts) |
| Admin review of drafts (JSON) | `GET /api/admin/content` ([app/api/admin/content/route.ts](../app/api/admin/content/route.ts)) |
| The blog: `/blog`, `/blog/tag/[tag]`, `/blog/[slug]` with its share image, `/blog/rss.xml`, `/blog/media/<post id>/<slot>`, `/about-posts`, sitemap entries; the strict Markdown renderer | [app/blog](../app/blog), [components/blog](../components/blog), [lib/content/blog.mjs](../lib/content/blog.mjs), [app/about-posts/page.tsx](../app/about-posts/page.tsx) |
| Review and publish: the queue, the review page, Publish, Reject and Unpublish | [app/admin/blog](../app/admin/blog), [app/api/admin/content/[id]/route.ts](../app/api/admin/content/[id]/route.ts) |
| Fixture posts for local previews (two real dry-run drafts of 2026-11-10 with their images) | [scripts/seed-blog-fixtures.mjs](../scripts/seed-blog-fixtures.mjs), [tests/fixtures/blog](../tests/fixtures/blog) |
| The image library: queue, night stage, review page, never-pay guard, Pexels counter | [lib/content/library.mjs](../lib/content/library.mjs), [pipeline/content/library-stage.mjs](../pipeline/content/library-stage.mjs), [app/admin/(tools)/images/page.tsx](<../app/admin/(tools)/images/page.tsx>), [lib/content/neurons.mjs](../lib/content/neurons.mjs), [lib/content/pexels-searches.mjs](../lib/content/pexels-searches.mjs) |

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
- Tests: [tests/blog.test.mjs](../tests/blog.test.mjs), [tests/blog-pages.test.mjs](../tests/blog-pages.test.mjs), [tests/content.test.mjs](../tests/content.test.mjs), [tests/admin-content.test.mjs](../tests/admin-content.test.mjs), [tests/image-library.test.mjs](../tests/image-library.test.mjs) and [tests/admin-library.test.mjs](../tests/admin-library.test.mjs).
