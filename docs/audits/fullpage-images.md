# Page images: one visit, tall AVIF, served from R2

Status: built behind `FULLPAGE_PREVIEW_ENABLED` (off), measured on 23 sites on 2026-11-13.
Code: `pipeline/fullpage.mjs`, `pipeline/shot-store.mjs`, `pipeline/capture.mjs`, `pipeline/fullpage-backfill.mjs`, `lib/shot-url.ts`, `lib/shots.ts`.

## Design (owner-approved, 2026-11-13)

- One capture session per site: load, splash gate and dialog (`pipeline/splash.mjs`), the existing settle, motion, dark-mode and fact checks, then one scroll through the whole page (lazy and fade-in content), back to the top, and one tall stitched image.
  The phone view is the same at 390 wide in the same browser context.
- Stored per version, under `<shot_key>/<v>/` in the public images bucket: `desktop.avif` (1440 wide, at most 4,000 px), `phone.avif` (390 wide, at most 6,000 px), `desktop-thumb.avif` (480 wide) and `phone-thumb.avif` (240 wide).
  `<v>` is the capture time in base 36, so every object is immutable.
- The top 1440 x 900 and 390 x 844 are cut from the tall images at capture time.
  The grade reads the desktop crop (`captures/<key>/hero.jpg`), so there is no separate hero screenshot.
- The profile can show the top with a CSS crop of the tall image: a box of `width / topHeight` with `object-fit: cover; object-position: top` (`lib/shot-url.ts` gives `topHeight`).

### Why a tall image is stitched, not one screenshot

A single full-document screenshot left everything below the first screen blank on about one site in five.
Those sites show a section only while it is in view (scroll-linked opacity, reveal animations that play back when scrolled away).
The capture takes one viewport screenshot per screenful from the top, after a short wait for that screen's reveals and images, and joins them.
Fixed bars under half a viewport tall are hidden after the first tile, so a sticky header shows once.

### A grade fix that comes with it

The grade's hero is now the top of the page after the scroll-through, when intro animations have finished.
On one sample site (ashishmadan.netlify.app) today's stored hero shows only a background and a mascot, without the name, the title or the buttons, and that is the image the grade judged.
The new crop shows the whole hero.

## Format

AVIF through sharp (libvips, already in the tree), tuned on lossless stitched pages of six sample sites:

| Setting | Desktop tall | Encode | PSNR | Phone tall | PSNR |
|---|---|---|---|---|---|
| JPEG q75 (today's quality bar) | 390 KB | 45 ms | 35.8 dB | 252 KB | 32.8 dB |
| WebP q75 | 206 KB | 326 ms | 36.9 dB | 151 KB | 34.5 dB |
| AVIF q50, effort 4 (sharp default) | 142 KB | 7,646 ms | 39.3 dB | 110 KB | 36.8 dB |
| **AVIF q40, effort 3, 4:2:0 (chosen)** | **103 KB** | **1,460 ms** | **35.6 dB** | **78 KB** | **32.8 dB** |
| AVIF q40, effort 2, 4:2:0 | 105 KB | 719 ms | 34.6 dB | 79 KB | 31.7 dB |

The chosen setting matches JPEG q75 at about a quarter of its bytes; text side by side at full size is indistinguishable.
Effort 4 cost five times the encode time for 2% fewer bytes.
Thumbnails use quality 50, since their text is scaled down.

No WebP fallback.
AVIF decodes in every current browser: Chrome and Edge since 85 (2020), Firefox since 93 (2021), Safari since 16.4 (2023).
The gap is iOS 16.3 and older, roughly 1 to 2% of visits, which would see no image.
A WebP copy of each file would add about 40% storage for that share.
The preview is an extra on the report card, so the UI should hide it when the image fails to load.

The grade's image stays JPEG: Gemini reads PNG, JPEG, WebP, HEIC and HEIF, not AVIF (docs/ASSUMPTIONS.md).

## Height caps

The owner's caps (4,000 px desktop, 6,000 px phone) bind on most portfolios: of 23 sample pages, 14 are taller than 4,000 px on desktop (9 taller than 6,000), and 13 are taller than 6,000 px on phone (12 taller than 8,000).
Bytes grow about in line with height, so 6,000 and 8,000 would cost roughly 30 to 40% more per site and show the whole page for 5 more of the 23 sites.
The caps stay at 4,000 and 6,000; `cropped` in the meta says when a page goes on below.

## Skipping unchanged captures

Each view stores a visual signature: the image scaled to 16 columns and one row per 90 px, grey, 16 levels a cell (about 0.5 KB).
A new capture counts as unchanged when both views' signatures match (sizes equal, at most 1% of cells off by more than one level) and the page text is the same.
Then nothing is uploaded, not even hero.jpg and mobile.jpg, and the stored version keeps its URL, so every cached copy stays valid.
A text change always makes a new version, even when the pixels barely move.

## Storage

Measured on 23 random listed sites, locally, with today's capture (main) and this one:

| Per site | Average | Largest |
|---|---|---|
| Today: hero.jpg + mobile.jpg | 113 KB | 173 KB |
| desktop.avif | 72 KB | 156 KB |
| phone.avif | 57 KB | 98 KB |
| desktop-thumb.avif | 6 KB | 12 KB |
| phone-thumb.avif | 8 KB | 13 KB |
| **Lean: the four AVIF files** | **143 KB** | **271 KB** |
| While the old frames are still uploaded | 260 KB | 411 KB |

Against R2's free 10 GB (the account's other buckets hold about 3.2 GB today, mostly old page caches):

| Sites | Today | Lean | With the old frames |
|---|---|---|---|
| 2,300 | 0.26 GB | 0.33 GB | 0.60 GB |
| 10,000 | 1.13 GB | 1.43 GB | 2.60 GB |
| 50,000 | 5.65 GB | 7.15 GB | 13.0 GB |

The estimate of about 170 KB a site (1.7 GB per 10,000) holds: the measured figure is 143 KB (1.43 GB per 10,000).
At 50,000 sites the lean set plus today's other buckets is about 10.4 GB, just over the free tier, unless the old page caches expire (the free-tier audit's lifecycle rule) or the old frames are gone.

R2 operations: 4 Class A writes per changed capture (plus 2 while the old frames are on), and a delete, which is free.
At 10,000 sites on the 90-day refresh that is about 20,000 Class A a month; at 50,000 about 100,000; the free tier is 1 million.
Reads come from the edge cache; a miss is one Class B read, against 10 million free.

## Capture time

| Per site | Average | Longest |
|---|---|---|
| Today's capture | 28 s | 66 s |
| This capture | 49 s | 89 s |
| Of which stitching and encoding both views | 16.6 s | 47.5 s |

At concurrency 4 on a GitHub runner a site takes about 12 s of wall time.
The nightly refresh of 150 sites goes from about 17 to about 31 minutes.
GitHub Actions minutes are free (public repository); the limit that matters is the end-of-day run's 120-minute wait for the nightly checks.
At 10,000 sites the 90-day refresh is about 110 sites a night (about 23 minutes); at 50,000 it is about 550 a night (about 2 hours), which would need a second capture job running in parallel or a longer refresh cycle.

### Backfill

`pipeline/fullpage-backfill.mjs` runs in the nightly checks after the capture: at most 100 sites a night, no new site after 40 minutes, about 20 s of wall time a site.
It stores nothing until the images bucket exists (below).
After that, the 2,300 listed sites fill in within about 23 nights, or about 10 while the nightly refresh is still re-capturing 150 sites a night.

## Delivery: straight from R2, no Worker

The tall images and thumbnails are served by R2 on its own domain, with no Worker in between: zero Worker CPU per image.
They live in their own bucket because the SHOTS bucket (`portfolio-rank`) also holds private grade reports (`private/grades/`), library images (`private/library/`) and draft post media (`content/`), and staging shares it.
A custom domain makes a whole bucket readable.

Every object is uploaded with `Cache-Control: public, max-age=31536000, immutable` and a versioned key, so the edge and the browser keep it for a year and a new capture gets a new URL.
`lib/shots.ts fullPagePreview` builds the URLs from `IMAGES_BASE_URL` (empty until the domain exists) and answers null while the flag is off.
hero.jpg and mobile.jpg keep coming from `/shots` through the Worker until they are retired.

### Owner steps (account changes, not done by any agent)

1. Cloudflare dashboard, R2: create the bucket `portfolio-rank-images` (location automatic).
2. That bucket, Settings, Custom Domains: connect `images.portfoliorank.dev`.
   Cloudflare adds the DNS record and the certificate.
   Leave the `r2.dev` public URL off.
3. The `portfoliorank.dev` zone, Caching, Cache Rules: a rule for hostname equals `images.portfoliorank.dev`, "Eligible for cache", Edge TTL "Use cache-control header if present", Browser TTL "Respect origin".
4. R2, Manage API tokens: give the token behind the GitHub secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` Object Read and Write on `portfolio-rank-images` as well (or make a new token for both buckets and update the two secrets).
5. GitHub: add the repository secret `R2_IMAGES_BUCKET` with the value `portfolio-rank-images` (`gh secret set R2_IMAGES_BUCKET`).
   From the next night the capture stores AVIF and the backfill starts.
6. Then an agent can set `IMAGES_BASE_URL` to `https://images.portfoliorank.dev` in `wrangler.jsonc` (production and staging) in a pull request, after checking that one uploaded file answers with `cf-cache-status: HIT` on its second request.

## Retiring hero.jpg and mobile.jpg

The capture still uploads them (cut from the tall images, so no extra visit) while `CAPTURE_LEGACY_FRAMES` is not `"false"`, because these still read them:

- the end-of-day grade on Cloudflare (`worker/night.ts`, from R2), and `pipeline/judge.mjs`, `pipeline/compare.mjs` and `scripts/eval-rubric.mjs`;
- the pages: home, leaderboard, lists, profiles, play and games, polls, the blog, the claim page, the top marquee, the print report and the grade's share image.

To drop them, each reader moves to the thumbnails or a CSS crop of the tall image.
The graders need a JPEG or WebP: either a private grade copy (a WebP crop of about 40 KB under a prefix no domain serves) or decoding the AVIF where the grade runs.
Then set the repository variable `CAPTURE_LEGACY_FRAMES` to `false`; existing hero.jpg and mobile.jpg keep working until each site is captured again.
