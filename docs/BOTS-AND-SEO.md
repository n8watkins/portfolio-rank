# Bots and SEO

How PortfolioRank should treat crawlers and bots as it grows to one public page per graded portfolio (2,106 today, aiming for 50,000) plus the blog, so that people's names and portfolios get found without bots running up the bill.
Written 2026-11-12 from the code on `main` (3f5e7da), production's Workers Logs and zone analytics for the last 7 days, the zone's settings read through the Cloudflare API, and Cloudflare's current docs.
Nothing here changes code or Cloudflare settings: every recommendation that touches the n8builds.dev zone is marked **(owner OK)** and waits for the owner.
Costs follow [COSTS.md](COSTS.md); the plan is Workers Paid ($5, 10M requests and 30M CPU ms a month included), Turso Free, R2 free, and the rule is never pay.

## Short answer

Bots visiting the profile pages matter a little, and only in one place: Worker CPU time.
Turso and R2 stay far inside their free limits even at 50,000 pages, but as built nearly every crawler visit to a profile page misses both 5-minute caches and re-renders the page for about 350 ms of CPU, so a realistic crawl of 50,000 pages adds about 140M CPU ms a month against the 30M included (about $2.50 a month; $10 to $15 in a heavy month).
The fix is cheap and also good SEO: cache public pages for days and purge them when their data changes, welcome the search crawlers, decide deliberately on AI crawlers, and turn away crawlers that send nobody back.

## 1. Does bot traffic matter for us?

### What one profile page view costs today

A profile page is `/p/<encoded portfolio URL>` ([app/p/[slug]/page.tsx](../app/p/[slug]/page.tsx)).
It is ISR with `revalidate = 300`, kept by OpenNext in R2 with a regional Cache API in front ([open-next.config.ts](../open-next.config.ts)), and since 2026-11-12 it is also behind Workers Cache: the default entrypoint sends anonymous `GET`s of `/p/*` to the `CachedPages` entrypoint, which the edge caches for 300 seconds with 1 day of stale-while-revalidate ([worker/edge-cache.ts](../worker/edge-cache.ts)).

Measured in production's Workers Logs, 2026-11-06 to 2026-11-13 (sampled, so counts are relative but the per-request CPU is real):

| Path a request takes | Worker CPU | Turso rows read | R2 | Billed Worker requests |
| --- | --- | --- | --- | --- |
| Edge hit (Workers Cache) | 0 ms | 0 | 0 | 2 (see note) |
| Edge miss, ISR copy still fresh (under 5 minutes old) | about 30 ms (median of `/p/` 200s was 32 ms) | 0 | 1 Class B read (often absorbed by the regional cache) | 2 |
| Edge miss, ISR copy stale (the usual case for a crawler) | about 300 to 400 ms (`CachedPages` misses: median 197 to 329 ms; Amazonbot's averaged 392 ms) | about 8 | 1 Class B read, 1 Class A write, 1 Durable Object queue request | 2 |
| The page's screenshot (`/shots/<key>/hero.jpg?v=`) | a few ms on a miss | 0 | 1 Class B read on a miss; cached a year at the edge after that | 1 |
| The browser's `/api/inspect` and `/api/psi` calls (DetailDiagnostics, Socials) | 10 to 50 ms each | about 4 each | 0 | 1 each |

Notes:

- The about 8 rows are the per-isolate schema check, two `portfolios` lookups for the screenshot, `ratings`, `star_counts`, the `likes` count (indexed), the rubric and `portfolio_owner`; all are primary-key or indexed reads.
- Cloudflare's Workers Cache pricing says that with caching on, `ctx.exports` calls between entrypoints are billed as requests, so a page through `CachedPages` should count twice; this should be confirmed against the dashboard's request count (follow-up F3).
- Well-behaved crawlers never make the `/api/*` calls: robots.txt disallows `/api/`, so Google's renderer does not fetch them.
  Headless scrapers that run JavaScript do, and each such call costs a Worker request and a few Turso rows.
- A crawler almost always takes the third row: it visits a long-tail page once every few days or weeks, so both the 5-minute ISR copy and the 5-minute edge copy have expired, and every deploy empties the edge cache (the Worker version is part of the Workers Cache key).

### What crawls look like today

Over the last 7 days the Worker served a few thousand requests a day (zone analytics: 2,500 to 4,500 on busy days), and no Googlebot or Bingbot requests appeared at all: the site is not being crawled by the search engines yet.
What did crawl:

- **MJ12bot** (Majestic, an SEO backlink index): about 490 requests in 7 days, 268 of them 404s on `/p/` and 199 redirects (see the URL bug in section 2).
- **Amazonbot**: about 200 requests in 7 days, mostly profile page renders at about 390 ms of CPU each.
- **SemrushBot** and **ClaudeBot**: a handful each.
- **A `node` client** calling `/api/inspect` about 2,800 times in 24 hours, 1,185 of which the zone's flood rule blocked.
  It looks like PortfolioRank's own tooling (a backfill or check script) running faster than 100 requests in 10 s from one IP; it is not a crawler, but it shows the flood rule does fire (follow-up F4).
- Scanner probes for `/.env`, `/.git/config`, `/.claude.json` and similar, blocked by the custom rule as intended.

Scaled to 50,000 pages, MJ12bot alone would be about 50,000 requests a month and Amazonbot about 20,000.

### Model: 50,000 profile pages crawled

Crawl volume assumptions for a site of this size and authority, as page fetches of `/p/*` a month:

| Crawler group | Realistic | Heavy month |
| --- | ---: | ---: |
| Google (Googlebot smartphone and desktop) | 60,000 | 150,000 |
| Bing (also feeds DuckDuckGo, Yahoo, Copilot) | 40,000 | 100,000 |
| AI search and assistants (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot, Claude-User, Applebot) | 50,000 | 150,000 |
| AI training (GPTBot, ClaudeBot, Meta-ExternalAgent, Amazonbot, CCBot, Bytespider) | 150,000 | 1,000,000 |
| SEO tools (MJ12bot, AhrefsBot, SemrushBot, DataForSEO, DotBot) | 100,000 | 300,000 |
| **Total** | **400,000** | **1,700,000** |

The heavy month is one aggressive training crawler re-reading the whole site daily, which Bytespider, Meta and Amazon have all been reported doing.
Today's baseline is about 0.55M CPU ms a day, so about 16.5M a month before any crawling.

| A month at 50,000 pages | As built, realistic | As built, heavy | With the fixes in section 3, realistic |
| --- | ---: | ---: | ---: |
| Page fetches reaching the site | 400k | 1.7M | 300k (SEO tools turned away) |
| Edge hits | about 0 | about 0 | about 150k (50%) |
| ISR fresh hits (30 ms) | about 0 | about 0 | about 110k |
| Re-renders (350 ms) | about 400k | about 1.7M | about 40k (pages whose data changed, plus weekly expiry) |
| Crawler CPU | 140M ms | 595M ms | about 17M ms |
| Total CPU with today's 16.5M | 156M (over 30M by 126M: **$2.52**) | 612M (over by 582M: **$11.64**) | about 34M (about $0.08; under 30M once render CPU is trimmed, F7) |
| Worker requests (2 per page) | 0.8M of 10M | 3.4M of 10M | 0.6M of 10M |
| Turso rows read | about 3.2M (under 1% of 500M) | about 14M (3%) | about 0.3M |
| R2 Class A writes (ISR) | about 400k of 1M free | about 1.7M: over by 0.7M (**about $3.15**) | about 40k |
| Durable Object queue requests | 400k of 1M included | 1.7M: over by 0.7M (about $0.11) | about 40k |
| R2 Class B reads | under 1M of 10M | about 2M of 10M | under 0.5M |

So: Turso is never the problem for crawls (rows per page are few and indexed), R2 reads are not either, and the request allowance has room.
CPU is the line, and in a heavy month R2 writes from ISR regeneration join it.
The fixes turn a crawl from "render the page" into "serve a stored copy", which is also what makes pages fast for Google's crawl budget.

One more scale point that is not about bots: profile data comes from `data/feed.json` bundled into the Worker (235 KB for 2,106 sites, parsed by every new isolate and searched linearly on every render, and read again by `worker/assets.ts`).
At 50,000 sites that file would be about 5.5 MB, which slows every cold start and pushes the Worker bundle toward its size limit; profiles should come from Turso (one primary-key read) before the roster grows (F8).

## 2. Current state

### robots.txt

Served by [app/robots.ts](../app/robots.ts), edge-cached for an hour:

```txt
User-Agent: *
Allow: /
Disallow: /api/
Disallow: /admin/

Sitemap: https://portfoliorank.n8builds.dev/sitemap.xml
```

- No crawler-specific rules and no Content Signals line.
- Staging answers `Disallow: /` and sends `X-Robots-Tag: noindex` on everything ([worker/staging.ts](../worker/staging.ts)); good.
- The zone's managed robots.txt is off (`is_robots_txt_managed: false`), so the file above is what crawlers see.

### Sitemaps

- One file, [app/sitemap.ts](../app/sitemap.ts), rebuilt daily (ISR 86,400 s) and edge-cached for an hour: 2,013 URLs today.
- Profiles come from `data/feed.json` minus hidden sites, with `changeFrequency` and `priority` but no `lastmod`; no URL in the file has a `lastmod` except blog posts (their `publishAt`).
- Google and Bing allow 50,000 URLs or 50 MB per sitemap file, so 50,000 profiles plus everything else will not fit in one file.
- Blog posts and tag pages are listed; no post is published yet.

### Profile page URLs

- The URL is the whole portfolio URL, percent-encoded: `/p/https%3A%2F%2Faadarshrai.vercel.app`.
- Any client that decodes it breaks it: `/p/https://aadarshrai.vercel.app` gets a 308 to `/p/https:/aadarshrai.vercel.app` (one slash), which is a 404.
  Checked live on 2026-11-12; MJ12bot hit exactly this 268 times in 7 days, and every one of those 404s rendered the not-found page through Next.js.
- The URL carries no words a person would search for besides the domain.

### Caching headers

| Page | What a response says | Edge (Workers Cache) | ISR |
| --- | --- | --- | --- |
| `/p/*` | `cache-control: s-maxage=2, stale-while-revalidate=2592000`, then `cf-cache-status: MISS` or `HIT` | 300 s, stale 1 day | 300 s |
| `/`, `/top`, `/top/*`, `/browse`, `/play`, `/polls` | same | 300 s, stale 1 day | 300 s |
| `/how`, `/grading`, `/sitemap.xml`, `/robots.txt` | same | 3,600 s | varies |
| `/blog`, `/blog/<slug>`, `/blog/tag/<tag>`, `/blog/rss.xml` | `s-maxage=2, stale-while-revalidate=...`, no `cf-cache-status` | **not cached at the edge** | 300 s |
| `/blog/media/<id>/<slot>` | `public, max-age=86400` | Cache API, but the post row is read from Turso before the cache is checked | n/a |
| `/shots/*` (screenshots) | `public, max-age=31536000, immutable` when versioned | Cache API, a year | n/a |

- The browser-facing `Cache-Control` is Next.js's `s-maxage=2`; the edge reads `Cloudflare-CDN-Cache-Control`, which the Worker sets and Cloudflare strips.
- The edge cache key includes the query string, so `/p/x?utm_source=y` and any random `?a=1` bypass it.
- Edge caching is skipped for anyone with a PortfolioRank cookie, which is right for people and irrelevant for crawlers (they carry none).
- Every deploy starts the edge cache empty; on a day with several deploys a crawler gets almost no hits.
- Purging: nothing purges today; pages simply expire after 5 minutes.

### The zone's bot settings (read 2026-11-12)

Zone n8builds.dev is on the Free plan.

| Setting | Value |
| --- | --- |
| Bot Fight Mode | off |
| JavaScript detections | off |
| AI Crawl Control / AI bot policies (Search, Agent, Training) | all "disabled" (nothing blocked) |
| Bot Preference Sync (managed robots.txt) | off |
| Security level | medium; browser integrity check on |
| Custom rule "Block scanner probes" | blocks `/.env`, `/.git`, `/wp-`, `.php`, `.yml`, `.sql` and similar, plus a few scanner user agents |
| Custom rule "Challenge nameless clients" | managed challenge for an empty user agent, except `/api/` and `/healthz` |
| Rate limit "Slow down floods" | block for 10 s when one IP in one data center sends over 100 requests in 10 s, except `/_next/` and `/healthz` |
| Cloudflare Web Analytics | on (the zone injects the beacon) |
| Crawler Hints (IndexNow) | not readable through the API; check in Caching > Configuration |

Could the flood rule hit Googlebot?
It counts per IP per data center, 100 requests in 10 s, across every hostname on the zone.
Googlebot normally stays far below 10 requests a second per IP, but it fetches a page's JavaScript and CSS too (those are excluded under `/_next/`), and it does ramp up on a site with 50,000 fresh URLs that answers fast.
A block answers 429, which Google reads as "slow down" and which lowers its crawl rate for days.
The risk is small but real, and the rule can exclude verified bots: on the Free plan, rate-limit expressions may use the Verified Bot field (`cf.client.bot`).

## 3. Strategy

### Principles

- Profile pages and blog posts exist to be found: every search crawler that sends people back is welcome, and their visits should be cheap.
- A crawler should get a stored copy, not a render.
- Decide per crawler group by what it gives back, and enforce at the edge, not in the Worker.
- Prefer the free Cloudflare features (AI Crawl Control, managed robots.txt, Verified Bot field) over code.

### Welcome verified search crawlers

- Keep robots.txt open for everything public; keep `/api/` and `/admin/` disallowed.
- Exclude verified bots from the flood rule **(owner OK)**: change its expression to
  `not starts_with(http.request.uri.path, "/_next/") and not starts_with(http.request.uri.path, "/healthz") and not cf.client.bot`.
  Verified bots are Cloudflare's checked list (Googlebot, Bingbot, Applebot, the AI search bots that verify, and similar), so a spoofed user agent stays rate-limited.
- Keep Bot Fight Mode **off**: on the Free plan it cannot be skipped by any rule, it challenges our own scripts, OpenPing and the smoke tests, and it adds nothing the rules above do not.
- Turn on Crawler Hints **(owner OK)**: Cloudflare then tells IndexNow engines (Bing, Yandex, Seznam) when a cached page changes, so they re-crawl what changed instead of everything.
- Register the site in Google Search Console and Bing Webmaster Tools **(owner OK: a DNS TXT record on the zone)** and submit the sitemap index.

### AI crawlers: the options

Cloudflare groups AI traffic into three behaviors, each of which can be allowed, blocked or blocked only on pages with ads, on every plan (Security settings > Bot traffic > AI Crawler and Agent access policies), and AI Crawl Control can block individual crawlers.

| Option | What we get | What it costs |
| --- | --- | --- |
| Allow everything (today) | Profiles and posts can appear in ChatGPT, Claude, Perplexity and Gemini answers and in future models' knowledge | Training crawlers are the biggest and least predictable load (up to 1M fetches in a heavy month); people listed here never agreed to have their profile used for model training |
| Allow Search and Agent, disallow Training (recommended) | Still cited in AI answers (search indexes and user-triggered fetches), which is where people increasingly look up names | Models do not learn about listed people from us; a small loss of "ambient" visibility |
| Block all AI crawlers | Lowest load | Invisible in AI answers, which works against the site's purpose |

Recommendation **(owner OK)**: Search allow, Agent allow, Training disallow, with Bot Preference Sync on.
Cloudflare then prepends managed directives and the Content Signals line (`search=yes, ai-train=no`) to our robots.txt and blocks the training-only crawlers at the edge; mixed-use crawlers are left alone.
Google-Extended is a robots.txt token, not a crawler: adding `User-agent: Google-Extended` / `Disallow: /` keeps Gemini training off our pages without touching Google Search, and matches the same choice (code, in `app/robots.ts`, after checking what the managed file already adds).
Why Training off: the pages are about real people, the training crawlers are the load risk, and the visibility that matters (being named in an answer with a link) comes from the Search and Agent groups.
Revisit in 6 months with AI Crawl Control's metrics: if referrals from AI answers are meaningful and training crawlers are polite, relax it.

### Turn away crawlers that send nobody back

- SEO-tool crawlers (MJ12bot, AhrefsBot, SemrushBot, DataForSEO, DotBot, BLEXBot, PetalBot) are the second-largest load and send no visitors.
  Disallow them by name in `app/robots.ts` (code); they all claim to honor it.
- Enforce with one custom rule for the ones that ignore it **(owner OK)**: managed challenge or block when `http.user_agent` contains any of those names and `not cf.client.bot`.
  The Free plan allows 5 custom rules and two are used.
- Headless scrapers running JavaScript are what trigger `/api/inspect` and `/api/psi`; those are already cached in Turso for 30 days and limited to roster URLs, so the cost per call is a few rows.
  If Workers Logs shows one client over 1,000 `/api/*` calls a day, block its user agent with the custom rule above.
  The Free plan allows a single rate-limit rule, which "Slow down floods" already uses, so a separate, lower threshold for `/api/` would mean narrowing that rule to `/api/` and losing the site-wide one; not worth it at today's numbers.

### Edge-cache public pages for days and purge on change (code)

This is the change that removes the cost line.

1. **Profiles: ISR for days, not minutes.**
   Set `revalidate` on `/p/*` to 7 days and revalidate on demand when a profile's data changes: a new grade, a rank or tier change from the nightly recompute, a claim, a hidden grade, a removal, a new screenshot.
   OpenNext needs a tag cache for `revalidateTag` (D1 or the Durable Object tag cache, both inside the free allowances at this size).
   Rank and ELO change nightly for many sites; showing "rank as of <date>" on the page makes a day-old number honest.
2. **Edge: a day, stale for a week, kept across deploys.**
   Raise the edge TTL for `/p/*` and the blog to 1 day with 7 days of stale-while-revalidate, turn on `cache.cross_version_cache` so a deploy no longer empties the cache, and tag each response (`Cache-Tag: p:<id>`, `blog`, `post:<slug>`).
   Purge from inside `CachedPages` (purges are scoped to the entrypoint that stored the response) with `ctx.cache.purge({ tags })` when the on-demand revalidation runs, and with `purgeEverything` after a deploy that changes page markup.
   Workers Cache purges always use the Free-tier purge rate limits, so the nightly job should purge in batches of tags, not one call per site.
3. **Add the blog to the edge list**: `/blog`, `/blog/<slug>`, `/blog/tag/<tag>`, `/blog/rss.xml`, purged when a post is published or edited.
4. **Normalize the cache key**: for cacheable paths, drop the query string (or keep an allowlist) in the default entrypoint before calling `CachedPages`, so `?utm_source=` and random parameters cannot force renders.
5. **Blog media**: check the Cache API before reading the post row from Turso.
6. **404s are cheap**: answer `/p/` URLs that are not on the roster from the edge (a cached 404 for a day) instead of rendering the not-found page each time.

### Profile URLs and canonicals (code)

- Move profiles to readable slugs: `/p/<host><path>` with the scheme and `www.` dropped (`/p/aadarshrai.vercel.app`, `/p/vasudev7891.github.io/Portfolio`), or a stored slug from the person's name plus a short id if names are unique enough.
  Either removes the encoded `https%3A%2F%2F` that clients break.
- 301 every old `/p/https%3A...` URL, and the broken `/p/https:/...` form, to the new one, so links and Google's index carry over.
- Keep one absolute canonical per profile, built from the same function as the sitemap and share links.

### Sitemap index split by type, with lastmod (code)

- `/sitemap.xml` becomes an index pointing to `sitemap/pages.xml` (home, top, browse, how and so on), `sitemap/blog.xml` (posts and the index), and `sitemap/profiles-<n>.xml` in chunks of 10,000.
  Next.js supports this with `generateSitemaps`.
- `lastmod` on every profile: the latest of its grade time, screenshot time and last rank change; on every post its edit time.
  Google uses `lastmod` when it is consistently accurate and ignores `changefreq` and `priority`, so drop those two.
- Build the profile sitemaps from Turso (indexed `url, updated_at` reads, about 50,000 rows a day), not `feed.json`.
- List only pages meant to rank: no hidden sites, no noindex pages, no tag pages with fewer than 3 posts.

### noindex for thin and hidden pages (code)

- A profile with no grade and no tagline today renders a name, a domain and a screenshot: thin, near-duplicate content across hundreds of pages.
  Make it `noindex, follow` until it has a grade, and leave it out of the sitemap.
- A site the health check hides (down, dead, parked) still answers 200 and is indexable: make it `noindex` while hidden (it is already out of the sitemap).
- A removed profile is a 404 today; a 410 tells crawlers faster that it is gone for good.
- Public lists (`/list/<slug>`) are user-made: `noindex` until a list has, say, 5 portfolios and a title.
- Already right: grade reports, claims, `/me`, `/profile`, `/votes`, `/settings`, the admin and staging all say noindex.

### Crawl-budget hygiene

- No infinite URL spaces: `/browse` sorting and filtering should live in client state or in a small fixed set of crawlable pages, never in arbitrary query combinations that are linked from pages.
- Any page that takes query parameters for display should canonicalize to its parameter-free URL.
- Keep the 404 for unknown `/p/` paths fast and cached (above).
- `/api/` stays disallowed, so renderers never call the diagnostics endpoints.

## 4. SEO checklist

Checked against `main` on 2026-11-12.
Status is yes, partly or no.

### Profile pages (`/p/*`)

| Item | Status | Today | To do |
| --- | --- | --- | --- |
| Unique `<title>` with the person's name | partly | `Aadarsh Rai - PortfolioRank` | `Aadarsh Rai, AI Engineer: developer portfolio review and rank - PortfolioRank`, trimmed to about 60 characters |
| Meta description | partly | `AI Engineer · aadarshrai.vercel.app`; 869 of 2,106 have no tagline and get `Developer portfolio · <domain>` | One sentence from the data: rank, tier, the strongest axis and one note from the review, about 150 characters |
| Absolute canonical | yes | from `SITE_URL` | follow the new slug |
| Readable URL | no | encoded full URL; decoding it gives a 404 | readable slug, 301s |
| Open Graph and Twitter card | yes | screenshot as the image | add `og:type` `profile` and the image size |
| JSON-LD | no | none | `ProfilePage` with `mainEntity` `Person` (`name`, `jobTitle` from the tagline, `url` the portfolio, `sameAs` GitHub, LinkedIn and X from the inspect cache, `image` the screenshot), `dateModified`; plus `BreadcrumbList` (Home > Browse > Name) |
| One `<h1>` with the name | yes | | |
| Unique, server-rendered text | partly | the AI review's axis notes are server-rendered; socials and diagnostics load in the browser from `/api/*`, which crawlers do not fetch | render a short summary and the social links on the server from the cached inspect result |
| Internal links to other profiles | no | a profile links to no other profile; `/top` links 100, `/` and `/browse` about 17 each, so about 1,900 profiles are reachable only from the sitemap | "Nearby in the ranking" (5 above and below), "Similar portfolios" (already computed for grade reports), crawlable paginated lists (`/browse/page/2` or `/top?page=2` with plain links) and tier or stack hub pages |
| Image alt and size | partly | `alt="Screenshot of <domain>"`, `fetchPriority="high"`, fixed CSS height, no `width`/`height` attributes | `alt="Screenshot of <Name>'s portfolio at <domain>"`, set `width`/`height`, a `srcset` with a smaller variant for phones |
| noindex for thin and hidden | no | every profile is indexable | as in section 3 |
| Fast response for crawlers | partly | edge hit or a 30 ms ISR hit when warm; 300 to 400 ms CPU and about 1.4 s wall on a cold render | long-lived caching (section 3) |
| hreflang | not needed | English only, `<html lang="en">` | none |

### Blog posts (`/blog/<slug>`)

| Item | Status | Today | To do |
| --- | --- | --- | --- |
| Title and description | yes | post title and subtitle | keep titles under about 60 characters in the editor's guidelines |
| Canonical | yes | relative, resolved by `metadataBase` | none |
| Open Graph `article` with `publishedTime` and tags, generated share image | yes | | add `modifiedTime` |
| JSON-LD `BlogPosting` | partly | headline, dates, image, keywords, publisher, citations | `author` as a `Person` (the owner, with `url` and `sameAs`) rather than the Organization, `dateModified` from the real edit time (today it repeats `publishAt`), `BreadcrumbList` |
| RSS | yes | `/blog/rss.xml` | |
| In the sitemap with `lastmod` | yes | `publishAt` | use the edit time; move to `sitemap/blog.xml` |
| Internal links | partly | related portfolios; #131 adds links to our profile pages and "More articles" | link every portfolio mentioned to its profile page |
| Edge cached | no | ISR only | add to the edge list |
| Tag pages | partly | in the sitemap at priority 0.3 | `noindex` and out of the sitemap until a tag has 3 posts |

### Site-wide

| Item | Status | Notes |
| --- | --- | --- |
| robots.txt and sitemap reference | yes | becomes the sitemap index |
| `Organization` and `WebSite` JSON-LD on the home page | no | name, logo, `sameAs` (GitHub repository), and a `SearchAction` only if search gets a crawlable URL |
| Core Web Vitals | unknown | measure with Search Console's field data once indexed; locally, the home page and a profile with the `web-perf` skill (LCP is the screenshot: keep it cached and sized) |
| Fonts | yes | Inter through `next/font`, metric-matched fallback |
| Security headers do not block crawlers | yes | CSP and HSTS are fine for crawlers |
| HTTPS, one host | yes | `portfoliorank.n8builds.dev` only; staging noindexed and disallowed |

## 5. Monitoring

All free; nothing to build until a weekly check shows a repeated need.

### Where to look

- **Workers Logs** (dashboard, or the `query_worker_observability` tool): group by `$workers.event.request.headers.user-agent`, `$workers.entrypoint` and `$workers.event.response.status`, sum `$workers.cpuTimeMs`.
  This is the only place that shows CPU per crawler.
  Retention is 7 days, so the weekly check must run weekly.
- **Zone analytics through GraphQL** (`httpRequestsAdaptiveGroups` for `clientRequestHTTPHost: "portfoliorank.n8builds.dev"`): counts by `userAgent`, `cacheStatus`, `securityAction` and `securitySource`.
  The Free plan does not expose bot scores or ASN names there; user agent plus Verified Bot is what we get.
- **Security > Events**: what the custom rules and the flood rule blocked, and which user agents tripped them.
- **AI Crawl Control** > Metrics and Robots.txt: requests per AI crawler, status codes, and robots.txt violations by name.
- **Cloudflare Web Analytics**: real visitors only (it is a browser beacon, so crawlers do not appear); use it for "did crawls turn into visits".
- **Google Search Console and Bing Webmaster Tools** (once verified): crawl stats (requests a day, average response time, host status), pages indexed versus "crawled, currently not indexed", queries that show profile pages.
- **Billing**: Workers & Pages > Plans for month-to-date requests and CPU ms; R2 > Metrics for Class A and B; Turso's usage page (COSTS.md section C).

### The weekly check (10 minutes, Mondays)

1. Workers CPU month-to-date, and the top 10 user agents by CPU over the last 7 days.
2. Cache status mix for `/p/*` and `/blog/*` (hit, miss, stale) and the 404 share on `/p/*`.
3. Security Events: any verified bot or our own tooling blocked.
4. AI Crawl Control: new crawlers, robots.txt violations.
5. Search Console: indexed profile count, crawl response time, new errors.

### Thresholds that trigger action

| Signal | Threshold | Action |
| --- | --- | --- |
| Worker CPU month-to-date | over 50% of 30M ms before the 15th, or over 1M ms a day for 3 days | find the top user agents by CPU; cache longer or turn the top non-search crawler away |
| One non-search user agent | over 20% of Worker requests or over 10,000 `/p/` fetches a day | disallow it in robots.txt; add it to the custom rule if it ignores robots.txt |
| Edge hit ratio on `/p/` (after the caching fixes) | under 50% for a week | check for query-string variety, purges that are too broad, or deploy churn |
| 404s on `/p/` | over 5% of `/p/` requests | find the broken link source (the URL bug, an old sitemap) and redirect |
| Verified bots blocked or challenged | any | fix the rule that caught them |
| R2 Class A writes | over 500,000 in a month | ISR is regenerating too often; lengthen `revalidate` |
| Turso rows read | over 50% of 500M (COSTS.md) | as in COSTS.md section C |
| Search Console average response time | over 600 ms | caching is not reaching crawlers |
| Search Console "crawled, currently not indexed" for profiles | growing past 30% of profiles | the pages are too thin: richer descriptions, JSON-LD, internal links, noindex the thinnest |

## Follow-up list

Owner decisions (zone settings; nothing is changed until the owner says so):

- O1. Flood rule: add `and not cf.client.bot`.
- O2. AI Crawler and Agent access policies: Search allow, Agent allow, Training disallow, Bot Preference Sync on.
- O3. A custom rule (third of five) that challenges or blocks SEO-tool crawlers by user agent when not verified.
- O4. Crawler Hints on.
- O5. Google Search Console and Bing Webmaster Tools verification (a DNS TXT record), then submit the sitemap index.
- O6. Keep Bot Fight Mode off (no change; recorded so it is a decision, not an accident).

Code (each its own PR):

- F1. Profiles: readable slugs, 301s from both old forms, canonical from one function.
- F2. Long-lived caching: `/p/*` ISR 7 days with on-demand revalidation and a tag cache; edge TTL 1 day with 7 days stale, `cross_version_cache`, `Cache-Tag` and purges from `CachedPages`; blog on the edge list; query strings dropped from cache keys; cached 404s for unknown `/p/` paths; blog media checks the cache before Turso.
- F3. Confirm how Workers Cache bills `ctx.exports` calls (compare the dashboard's request count with logged page views) and update COSTS.md.
- F4. Find the `node` client that made about 2,800 `/api/inspect` calls in 24 hours (1,185 blocked by the flood rule) and pace it or point it at Turso directly.
- F5. Sitemap index split by type, `lastmod` everywhere, profiles from Turso, no `changefreq`/`priority`, only indexable pages.
- F6. Profile SEO: data-driven title and description, `ProfilePage`/`Person` and `BreadcrumbList` JSON-LD, server-rendered socials and summary, nearby and similar portfolios, crawlable paginated browse, noindex for ungraded, hidden and tiny lists, 410 for removed.
- F7. Measure and trim the profile render's CPU (target under 100 ms on a stale ISR render); the bundled `feed.json` parse and lookup is the first suspect.
- F8. Read the roster from Turso instead of bundling `data/feed.json` before it passes about 10,000 sites.
- F9. Blog: `Person` author, real `dateModified`, breadcrumbs, `modifiedTime`, tag pages noindex under 3 posts.
- F10. robots.txt: disallow SEO-tool crawlers by name and `Google-Extended`, after O2 so the managed block and ours do not overlap.
- F11. Home page `Organization` and `WebSite` JSON-LD.

## Sources

- Measurements: production Workers Logs (2026-11-06 to 2026-11-13), zone analytics GraphQL (24 hours to 2026-11-13), zone settings and rulesets read through the Cloudflare API on 2026-11-12, `curl` of production pages, Turso usage (`turso plan show`: 6.5M of 500M rows read this month across all 13 databases).
- [Workers Cache](https://developers.cloudflare.com/workers/cache/) (pricing, per-version keys, `cross_version_cache`) and [Purge](https://developers.cloudflare.com/workers/cache/purge/).
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- [Rate limiting rules availability](https://developers.cloudflare.com/waf/rate-limiting-rules/) (Free plan: Path and Verified Bot fields).
- [Bot Fight Mode cannot be skipped](https://developers.cloudflare.com/waf/feature-interoperability/).
- [Managed robots.txt and Content Signals](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/), [AI Crawl Control](https://developers.cloudflare.com/ai-crawl-control/features/manage-ai-crawlers/), [AI traffic policies on all plans](https://developers.cloudflare.com/changelog/post/2026-07-01-ai-traffic-options/).
- [Google: sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) (50,000 URLs or 50 MB per file, `lastmod`), [ProfilePage structured data](https://developers.google.com/search/docs/appearance/structured-data/profile-page), [Google-Extended](https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers), [HTTP status codes and crawling](https://developers.google.com/search/docs/crawling-indexing/http-network-errors) (429 slows crawling).
