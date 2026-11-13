# Can code judge meta tags, structured data and fonts?

An experiment, not for merge.
It asks whether plain code (no AI) can reliably check a portfolio home page for share and search tags, structured data, font use, crawl files, analytics and web basics, and what WebP would save over the JPEG screenshots.

Terms used below:

- JSON-LD: a block of JSON in the page that tells search engines who the page is about (schema.org types such as Person).
- og:image and friends: the Open Graph tags that link previews in Slack, LinkedIn and X read.
- Precision: of the problems the detector reported, the share that were real.
- Recall: of the real problems, the share the detector found.
- SSIM and PSNR: two standard scores of how close a compressed image is to the original.

## Method

- Sample: 100 random listed, graded portfolios from the production database (status `live`, not delisted, not down, with a grade), read only.
- Each home page was fetched once with a plain HTTP request (user agent `PortfolioRank-research/1.0`, 10 s timeout, 4 at a time), plus one request each for its og:image, robots.txt, the sitemap and, only when the page names no icon, `/favicon.ico`.
- Each page was rendered in a local Chromium for fonts, the JavaScript-built head and analytics requests.
  The first render pass missed text that fades in, so the pages were rendered a second time with a scroll-through; that second pass is the one reported.
- Raw HTML and screenshots stayed outside the repo.
  `data/` holds only extracted facts.
- Hand check: 25 of the 100, stratified (15 with structured data, 10 without, 9 with three or more fonts, 4 with a broken og:image, 2 where the first pass found no text).
  For each I read the raw head and JSON-LD, looked at a full-page screenshot, ran an independent font census (Chromium's record of the font file that drew every visible element) and re-requested robots.txt, the sitemap, og:image and favicon by hand.
  Per-site notes are in `data/handcheck.json`.

## How common each thing is (static HTML, 99 pages fetched)

Share and search tags:

- 16% have no meta description, and 4% more have a placeholder one (for example the create-react-app default).
- 56% have no canonical link.
- 33% have no og:title or og:description.
- 43% have no og:image, and 7% more have one that does not load (404).
- 39% have no Twitter card.
- 44% have a complete, working share card.
- Template leftovers: 4 sites point og:url, og:image or canonical at someone else's site (example.com, the template author's demo).
- Only 1 site adds an og:image with JavaScript, so a plain fetch sees what link previews see.

Structured data:

- 39% have JSON-LD (42% after JavaScript runs); none had a JSON parse error; 3% also use microdata.
- Types: Person 39, WebSite 22, Organization 22 (mostly employers), ProfilePage 13.
- Every Person found named the portfolio's owner.
  No "John Doe" or template-author junk turned up in this sample.

Fonts (whole page, families carrying at least 2% of the text):

- 45% use one family, 36% two, 16% three, 3% four or more.
- 22% use only system fonts.
- No site used more than 3 families in body text or a script face for paragraphs, so the owner's "inappropriate" rule fired on 0 of 100.

Crawl files:

- 45% have no robots.txt, and 6% more answer robots.txt with their app's HTML page.
- No site blocks all crawlers.
- 52% have no working sitemap; 44% list one in robots.txt.

Analytics and monitoring:

- 47% run at least one tool: Google Analytics 22, Cloudflare Web Analytics 18, Vercel Analytics 13, Google Tag Manager 7, Vercel Speed Insights 6, PostHog 3, Umami 3, Plausible 1.
- None used Fathom, Hotjar or Microsoft Clarity.

Basics:

- 7% have no favicon (no icon link and no `/favicon.ico`).
- 4% have no `<html lang>`.
- Every page has a viewport tag.
- 2% are not on HTTPS (the listed address never redirects), and 1% loads files over plain HTTP from an HTTPS page.

## How accurate the detector was on the 25 checked by hand

| Check | Result |
| --- | --- |
| Meta tags | 37 of 37 problems it flagged were real; it missed 1 (an SVG og:image that loads but that Facebook, LinkedIn and X do not show). Precision 100%, recall 97%. |
| Structured data, present and types | 25 of 25 right (15 with, 10 without). |
| Structured data, plausible or junk | 15 of 15 plausible verdicts right; there was no junk to catch, so recall on junk is untested. My first rules called 25 of 39 sites junk, all wrongly, before two fixes (see below). |
| Fonts, family count | 21 of 25 exact, 24 of 25 within one (19 of 25 before two naming fixes). |
| Fonts, "more than 3 families anywhere" | 3 found, 0 false alarms, 2 missed: precision 100%, recall 60%. |
| Fonts, owner's "inappropriate" rule | 0 true cases in the 25 and 0 flagged: nothing to measure. |
| robots.txt | 25 of 25 right. |
| Sitemap | 24 of 25: one valid sitemap was missed after a network error on the single request. |
| Analytics | 25 of 25 right (9 sites with tools, 16 without). |
| Basics (favicon, lang, viewport, HTTPS, mixed content) | 25 of 25 after one fix; before it, an http to https redirect counted as mixed content. |

The font fixes, the plausibility fixes and the mixed-content fix were made after looking at these 25 sites, so the "after" numbers flatter the detector a little.

## Failure patterns

- Junk rules that are too eager: a `}}` in nested JSON looked like a template tag, and an employer's URL in `worksFor` looked like a wrong site.
  Fixed by matching `{{ name }}` only and checking URLs on Person, WebSite and ProfilePage nodes only.
- Short names: the listed name "Rishav" did not match "Rishavdeep Singh" until prefix matching was added.
- A site that redirects to another domain (hamzaehsan.com to a github.io page) needs both addresses treated as the site.
- Fade-in pages: text at opacity 0 when measured was skipped, so two sites showed zero fonts.
  Fixed by scrolling through the page and counting faded text.
- Counting by characters undercounts big display headings: a script face used only in a hero heading falls under 2% of characters.
  The next fix would weigh text by its rendered area.
- Fonts named per weight (`Lato-Bold`) and Windows or Mac fonts with no fallback (Verdana, Tahoma) need naming rules, since the Linux measuring machine draws them in a substitute.
- One request with no retry turns a network blip into "missing".
- An og:image that loads is not always usable: SVG is not shown by the big previewers.
- A canonical that points to the owner's other domain is legitimate, so "wrong host" should be a tip, not a fault.

## What could become an automatic check

- Meta tags: reliable.
  The share card already earns 10 points (`shareText` 5, `shareImage` 5 in `lib/check-points.mjs`).
  I would keep those weights and make `shareImage` pass only when the image loads and is PNG, JPEG, WebP or GIF.
  I would add template leftovers (example.com or another site's address in og:url, og:image or canonical, the create-react-app description) to the existing `template` penalty or as a fix-list item.
  Missing canonical and missing Twitter card are tips, not points.
- Structured data: reliable for "present, parses, has a Person or ProfilePage naming the owner".
  Worth 2 to 3 points.
  Junk detection should stay a tip until it has been tested on real junk.
- Fonts: the count is good enough for a tip ("your page uses 5 typefaces"), but not for points.
  The owner's rule never fired in 100 sites, so it carries no signal, and the count misses display faces in big headings.
  0 points for now.
- robots.txt and sitemap: reliable with one retry; 1 to 2 points or a tip.
  Lighthouse SEO already checks that robots.txt is valid.
- Analytics: easy to detect, but not something a visitor sees, so a fact for the profile, not points.
- Basics: reliable.
  Lighthouse SEO and best practices already cover `lang`, viewport and HTTPS, and `domain` covers HTTPS, so only the favicon is new: 1 point or a tip.

## WebP instead of JPEG q75

20 sites, hero (1440 x 900) and mobile (390 x 844), 40 screenshots, each compared with the lossless PNG of the same frame.

- WebP at quality 75 is 44% smaller than JPEG q75 (46% for hero, 39% for mobile), and scored at least as high as the JPEG on both SSIM and PSNR in 38 of 40 shots.
- WebP at quality 80 is 35% smaller and beat the JPEG on both measures in 39 of 40 shots.
- Matching the JPEG exactly on SSIM and PSNR allows WebP around quality 35 and saves 60%, but at that quality dark gradients show visible blocks, so that figure is a ceiling, not a target.
- SSIM alone is too forgiving: it accepted quality 13 on one page, where text edges were visibly smeared.
- Recommendation: WebP at quality 75, about 44% fewer bytes (about 48 KB less per site for the pair, about 110 MB across 2,300 sites).
  The bigger win is faster grids on the site, not storage cost.
- sharp's JPEG q75 came out 1.4% smaller than Chromium's, so the comparison uses sharp's JPEG of the same frame as the baseline.

## Lighthouse data we already store

- `psi:<url>` (mobile) and `psi-desktop:<url>` rows hold the four category scores, the metric display values (LCP, CLS, TBT; FCP and speed index on newer rows) and page weight (bytes and request count).
- `lib/tools/psi.ts` can also store up to 6 failing audits with a plain tip and a savings line (`fixes`), but that landed today in #191 and only 1 of 2,135 mobile rows has it so far; no desktop row has it.
  Rows refresh every 30 days, so `fixes` will fill in as they age out.
- No row keeps item-level details: not the LCP element, not which files block rendering, not which images lack a size, not the largest downloads.
- Tips that can feed the fix list with no new request:
  - from the stored metrics: LCP over 2.5 s, CLS over 0.1, TBT over 200 ms, each with a plain cause and fix;
  - from page weight: over about 3 MB or over about 100 requests;
  - from `fixes`, once rows refresh: render-blocking files, image delivery, unused JavaScript and CSS, font-display, layout shift culprits, missing meta description, missing `lang`, color contrast.
- `lib/tools/improve.ts` today turns only the four scores into fix-list items and does not read `fixes` or the metrics, which is a cheap win.

## Re-running

```sh
# sample.psv: "url|final_url|name" per line, from a read-only query of listed, graded portfolios
node experiments/meta-schema-fonts/fetch.mjs sample.psv RAW
node experiments/meta-schema-fonts/fetch-extra.mjs sample.psv RAW
node experiments/meta-schema-fonts/render.mjs sample.psv RAW 20
node experiments/meta-schema-fonts/analyze.mjs sample.psv RAW OUT
node experiments/meta-schema-fonts/webp.mjs RAW/shots OUT   # needs ffmpeg
```

Keep `RAW` outside the repo: it holds third-party HTML and screenshots.
