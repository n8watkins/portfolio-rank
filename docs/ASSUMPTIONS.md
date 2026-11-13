# Assumptions

What PortfolioRank's plan takes for granted about Gemini, Cloudflare, Turso and Google Play, checked against the official docs.
Every fact names its source and the date it was read.
Where the docs are silent, the entry says "not documented" and proposes a small test instead of a guess.
Numbers and money live in [COSTS.md](COSTS.md); what the judge model can take lives in [MODEL-LIMITS.md](MODEL-LIMITS.md); standing decisions live in [DECISIONS.md](DECISIONS.md).

All sources were read on 2026-11-10 unless an entry says otherwise.
Several `ai.google.dev/gemini-api/docs/...` links now redirect (301) to `aistudio.google.com/docs/...`; the links below are the pages actually read.

Status per entry:

- **verified**: an official page says so.
- **contradicted**: an official page says something else; the plan changes.
- **not documented**: no official page says; a test is proposed.

## Summary: what changes the plan

1. **Public grading needs the paid tier before launch, not only when volume grows** (contradicted).
   The Gemini API terms allow only Paid Services when an API client is made available to users in the EEA, Switzerland or the UK, and tell free-tier users not to submit personal information.
   A public "grade my portfolio" button reaches those users and sends page text with names and contact details.
   Decided (owner, 2026-11-10): stay on the free tier everywhere, block no region, and accept the risk for now; contact details are stripped from page text before it reaches Gemini, and where a visitor starts AI work they get a clear free-tier notice and a bring-your-own-key option (DECISIONS.md, "Free tier everywhere").
   Revisit at the public launch or when traffic grows; paid billing removes both issues.
2. **Our daily ledger counted UTC days; Google's daily quota resets at midnight Pacific** (contradicted, resolved).
   Every Gemini "today" now uses one Pacific quota-day helper, `pipeline/quota-day.mjs`, tested across both DST changes (#69, #72).
3. **`maxOutputTokens` includes thinking tokens** (verified, not handled).
   A response that hits the cap ends with `MAX_TOKENS` and possibly truncated JSON, and the thinking tokens are still billed.
   Resolved (#72): `finishReason` is logged for every response, an answer that did not finish with `STOP` is a failed answer that is never stored, and the caps leave room for thinking (A7).
4. **3.1 Flash-Lite shuts down no earlier than 2027-05-07** (verified).
   Every labelled 3.1 experiment (the 3.1-vs-3.5 comparison, trend analysis) has to finish before then.
5. **Failed requests (400 and 500) count against quota but are not charged** (verified).
   Our limiter already counts retries against the rate; the daily budget must count them too, which it does through `gemini_requests`.
6. **Per-model free-tier and Tier 1 rate limits are not in the public docs** (not documented).
   The 500-a-day figure in DECISIONS.md is the owner's reading of AI Studio and stays an assumption until the owner re-reads it there (test G1).
7. **Turso's Free plan blocks every query when any monthly limit is exceeded, and keeps only 1 day of point-in-time restore** (verified).
   The owner decided to stay on Turso for now; COSTS.md section C shows our projected use against the Free limits and the roll-ups that keep it far below them, and section E keeps the D1 comparison for when it is revisited.
   The nightly backup held only `votes`, `ratings` and part of `portfolios`; since #72 it holds every table but the transient `cache` and `matchups`, with a tested restore script (section G).
8. **GitHub's terms restrict what GitHub-hosted runners may be used for** (verified, a risk for on-demand grading).
   Actions may not be used "as part of a serverless application" where the burden outweighs the benefit, nor, on GitHub-hosted runners, for activity unrelated to the software project; capturing a stranger's site because they pressed "grade my portfolio" is the kind of use this clause is about (section F).
9. **Image tokens can be cut 4x with `media_resolution` LOW** (verified that the setting exists, not that grades stay as good).
   This matters most for batched comparisons; see MODEL-LIMITS.md and test G6.
10. **The first Turso limit we would hit is reads from two per-page-view full scans, not log growth** (estimated from the code).
   `/top` counted every row of `votes` on each render and `/api/leaderboard` read a whole board view on each request; COSTS.md section C has the numbers.
   Fixed (#72): vote counters kept by triggers, a paged and edge-cached board, and nightly roll-ups and retention for the log tables.

## A. Gemini

### A1. Rate limits per model (free and Tier 1)

- Assumption: 3.5 Flash-Lite and 3.1 Flash-Lite each allow 500 requests a day on the free tier (DECISIONS.md, "Quotas").
- Verified: limits are measured as requests per minute (RPM), input tokens per minute (TPM) and requests per day (RPD), and exceeding any one gives a rate-limit error ([rate limits](https://aistudio.google.com/docs/rate-limits)).
- Verified: tiers are Free (active project or free trial), Tier 1 (linked billing account, $250 billing cap), Tier 2 ($100 paid and 3 days, $2,000 cap), Tier 3 ($1,000 paid and 30 days, $20,000 to $100,000+ cap) ([rate limits](https://aistudio.google.com/docs/rate-limits), [billing](https://aistudio.google.com/docs/billing)).
- Verified: the only public per-model numbers for these two models are Batch API enqueued tokens on Tier 1: 10,000,000 each ([rate limits](https://aistudio.google.com/docs/rate-limits)).
- Not documented: RPM, TPM and RPD for either model on Free or Tier 1; the public page points to AI Studio's own rate-limit page for current values.
- Test G1: the owner opens AI Studio's rate-limit page for the project that holds the key (signed in) and copies RPM, TPM and RPD for both models on the current tier into DECISIONS.md with the date.
  Cost: 0 requests.
  Proves: the real numbers for our project, including TPM, which caps batched comparisons (MODEL-LIMITS.md).
- Decision: keep `GEMINI_DAILY_QUOTA` as a repository variable (it already is) and record the AI Studio reading with its date; do not hard-code limits from blogs.

### A2. Per project or per key

- Assumption: limits apply per Google Cloud project, so a second key in the same project adds nothing.
- Verified: "Rate limits are applied per project, not per API key." ([rate limits](https://aistudio.google.com/docs/rate-limits)).
- Decision: unchanged: one key per project; a second project for more free quota is not pursued (see A9 on terms and data).

### A3. When the daily quota resets

- Assumption: midnight Pacific.
- Verified: "Requests per day (RPD) quotas reset at midnight Pacific time." ([rate limits](https://aistudio.google.com/docs/rate-limits)).
- Was contradicted in our code: `dailyTotals` in `pipeline/gemini-log.mjs` and `comparisonsToday` in `lib/ranking/store.mjs` took "today" as the UTC date.
  Midnight Pacific is 08:00 UTC in winter and 07:00 UTC in summer, so work at 23:00 UTC and at 01:00 UTC landed on two of our days but one of Google's.
- Resolved: #69 moved the ledger and the budgets to the Pacific day; #72 made `pipeline/quota-day.mjs` the one helper every Gemini "today" uses (the ledger, the accountant, the ranking store, the comparison seed, owner alerts), with tests for every hour of 2026 and 2027 and both DST days.

### A4. Whether failed or retried requests count

- Verified: for requests that fail with a 400 or 500 error "you won't be charged for the tokens used. However, the request will still count against your quota." ([billing](https://aistudio.google.com/docs/billing)).
- Not documented: whether a 429 itself counts against RPD, and whether safety-blocked responses are billed.
- Test G2: for one day, compare the count of rows in `gemini_requests` per model (split by status) with the request count AI Studio's usage page shows for the same Pacific day.
  Cost: 0 extra requests (uses traffic we already make).
  Proves: whether 429s and 5xx count in Google's RPD tally, which sets how much buffer the "50 for retries" share needs.
- Decision: the budget counts every HTTP attempt, retries included (already true in `gemini_requests`); the 50-request retry buffer stays.

### A5. How a 429 says which limit was hit

- Verified: the error reference lists three 429 codes: `rate_limit_exceeded` ("exceeded the per-minute or per-second request or token limit"), `quota_exceeded` ("exceeded your daily quota") and `too_many_requests` ([API errors](https://aistudio.google.com/docs/api-errors)).
- Not documented: the `google.rpc.QuotaFailure` details (`quotaId`, `quotaMetric`) and `RetryInfo.retryDelay` that `generateContent` 429 bodies carry; the troubleshooting page only says to retry 429 with backoff ([troubleshooting](https://aistudio.google.com/docs/troubleshooting)).
  `isDailyQuota` in `pipeline/gemini.mjs` matches `PerDay`, "per day" or "daily", which covers both the documented message and the undocumented quota id.
- Test G3: store the first 300 characters of every 429 body.
  Cost: 0 extra requests.
  Proves: the exact body Google sends for each limit, so the classifier can match a field instead of a regex.
  Status: running since #72: every error body (429, 5xx, other 4xx) goes to `gemini_requests.detail`, one line, key-like strings removed; `reason` keeps the short label.
  Next: after the first 429s, read `SELECT at, reason, detail FROM gemini_requests WHERE status = 429` and switch `isDailyQuota` to the quota id if the bodies carry it.

### A6. Image input

- Verified: inline images count toward a total request size of 20 MB, prompts and system instructions included ([image understanding](https://aistudio.google.com/docs/image-understanding?generate-content=true)).
- Contradicted elsewhere in the same docs: the input methods page lists inline data at "100 MB per request or payload" (50 MB for PDFs), the Files API at 2 GB per file and 20 GB per project with 48-hour storage, and external URLs at 15 MB per file ([file input methods](https://aistudio.google.com/docs/file-input-methods)).
  We plan to the stricter 20 MB.
- Verified: up to 3,600 image files per request; PNG, JPEG, WEBP, HEIC and HEIF ([image understanding](https://aistudio.google.com/docs/image-understanding?generate-content=true)).
- Verified: on Gemini 3 models an image costs a fixed number of tokens set by `media_resolution`: low 280, medium 560, high 1,120, ultra high 2,240 (per part only), and the default (unspecified) 1,120 ([media resolution](https://aistudio.google.com/docs/media-resolution?generate-content=true)).
  The 258-tokens-per-768-px-tile rule on the image page describes earlier models.
- Verified: the request-wide setting is `generation_config.media_resolution`, a per-part override is `media_resolution: {level: ...}` next to `inline_data`, labelled experimental, on `v1beta`; the page recommends high for most image analysis ([media resolution](https://aistudio.google.com/docs/media-resolution?generate-content=true)).
- Not documented: how a 1440 x 900 screenshot is scaled into 1,120 (or 280) tokens, and whether text in it stays legible at low.
- Test G4: one `countTokens` call per resolution with one hero and no text (`models/gemini-3.5-flash-lite:countTokens`).
  Cost: 4 countTokens calls, no generateContent.
  Proves: the per-image token count our requests really pay, independent of the docs.
  A zero-call version: read `input_tokens` of past rubric requests in `gemini_requests` and subtract the text estimate.
- Test G6: inside the tiered batch experiment (MODEL-LIMITS.md), run one tier on the same sets at the default resolution and at low.
  Cost: about 60 extra requests.
  Proves: whether a 4x cheaper image changes the judge's orders more than the noise between two runs at the default.
- Decision: keep inline base64 JPEG (no Files API: the 48-hour storage and an extra upload call buy nothing at our image sizes); try LOW for batched comparisons in the batch experiment (G6), not for grades.

### A7. Output, thinking and billing of thinking

- Verified: both models take up to 1,048,576 input tokens and return up to 65,536 output tokens, text output only ([3.5 Flash-Lite](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite), [3.1 Flash-Lite](https://aistudio.google.com/docs/models/gemini-3.1-flash-lite)).
- Verified: 3.5 and 3.1 Flash-Lite support thinking levels `minimal`, `low`, `medium` and `high`, default `minimal`; `minimal` "does not guarantee that thinking is off" and Flash-Lite has no full thinking-off ([thinking](https://aistudio.google.com/docs/thinking?generate-content=true)).
- Verified: thinking tokens are billed as output ("response pricing is the sum of output tokens and thinking tokens"), reported in `thoughtsTokenCount` ([thinking](https://aistudio.google.com/docs/thinking?generate-content=true)); the pricing page lists output prices "including thinking tokens" ([pricing](https://aistudio.google.com/docs/pricing)).
- Verified, and not handled in our code: `maxOutputTokens` "sets the maximum number of tokens a response can generate, including thought tokens"; hitting it ends with `MAX_TOKENS`, possibly with truncated or empty output, and the doc recommends a lower thinking level rather than a small cap ([thinking](https://aistudio.google.com/docs/thinking?generate-content=true)).
  Our caps were 600 (rubric) and 400 (comparisons) with thinking at `minimal`.
- Test G5: add `finishReason` to the request log and count `MAX_TOKENS` per job for a week.
  Cost: 0 extra requests.
  Proves: whether the caps ever cut an answer; if they do, raise the cap rather than retry.
  Status: running since #72 (`gemini_requests.finish_reason`; run summaries show a "Cut off" column).
  Next: after a week, `SELECT job, finish_reason, COUNT(*) FROM gemini_requests WHERE status = 200 GROUP BY job, finish_reason`.
- Decision (#72): keep `minimal`; raise the caps to 2,048 (rubric) and 1,024 (comparisons) so thinking has room, since only tokens produced are billed; an answer that did not finish with `STOP` is a failed answer, never stored and not retried.

### A8. Prices

- Verified, per 1M tokens on the standard paid tier ([pricing](https://aistudio.google.com/docs/pricing)):
  3.5 Flash-Lite $0.30 input (text, image, video, audio) and $2.50 output; 3.1 Flash-Lite $0.25 input (text, image, video) and $1.50 output.
  Batch and Flex are half price (3.5: $0.15 and $1.25); Batch and Flex are not on the free tier.
  Note that Flex on the paid tier is marked "used to improve our products: Yes"; Batch is "No".
- Decision: cost tables in COSTS.md use these numbers; queued "grade my portfolio" reports and nightly comparisons are candidates for Batch, never Flex (Flex prompts are used for training).

### A9. Free-tier data use and where we may serve

- Verified, Unpaid Services: Google uses prompts and responses to improve its products, human reviewers may read them, and "Do not submit sensitive, confidential, or personal information to the Unpaid Services." ([terms](https://aistudio.google.com/docs/terms), effective 2026-03-23).
- Verified, Paid Services: prompts and responses are not used to improve products; they are logged for a limited, unstated period for abuse detection ([terms](https://aistudio.google.com/docs/terms)).
- Verified: "You must be 18 years of age or older to use the APIs", and for the EEA, Switzerland and the UK only Paid Services may be used when making API clients available to users ([terms](https://aistudio.google.com/docs/terms)).
- Recommended here: the public grader, the queue and any feature a visitor triggers run on a billed project from the day they are public.
- Decided (owner, 2026-11-10): not now. PortfolioRank stays on the free tier for everyone and blocks no region, accepting the terms risk; email addresses and phone numbers are removed from page text before it reaches Gemini (`pipeline/redact.mjs`), and where a visitor starts AI work they see a clear free-tier notice ("don't submit private details") and can use their own Gemini key (DECISIONS.md, "Free tier everywhere" and "Public by design").
  Revisit at the public launch or when traffic grows.

### A10. Stable status and deprecation

- Verified: `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite` are both listed as Stable ([models](https://aistudio.google.com/docs/models)); 3.5 released 2026-07-21 with no shutdown date; 3.1 released 2026-05-07 with shutdown 2027-05-07 and 3.5 as the replacement ([deprecations](https://aistudio.google.com/docs/deprecations)).
- Verified: shutdown dates "indicate the earliest possible dates on which a model might be retired"; no fixed notice period is stated for stable models; preview models are deprecated with at least 2 weeks notice ([deprecations](https://aistudio.google.com/docs/deprecations), [models](https://aistudio.google.com/docs/models)).
- Verified, unrelated but worth knowing: `gemini-2.5-flash` requests route to `gemini-3.5-flash-lite` automatically from 2026-12-01 ([models](https://aistudio.google.com/docs/models)), which may add load on the model we depend on.
- Decision: the planned model watch (DECISIONS.md) reads the deprecations page as well as the model list; the 3.1-vs-3.5 comparison and any 3.1 trend analysis finish before 2027-04.

## B. Cloudflare (Workers Paid, already on it)

### B1. Workers, Cron Triggers and Workflows

- Verified ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)): $5 a month; 10M requests and 30M CPU ms included, then $0.30 per million requests and $0.02 per million CPU ms; no charge for duration or egress.
  Cron Triggers have no separate price and are billed as requests and CPU.
  Workers Logs: 20M events included, then $0.60 per million, 7-day retention; moves to Observability pricing on 2026-12-01.
- Verified ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)): 10,000 subrequests per invocation by default, CPU 30 s default and 5 min max per HTTP request, Cron Triggers 30 s CPU for intervals under an hour and 15 min for an hour or more, 128 MB memory per isolate, 6 simultaneous outgoing connections.
- Verified ([Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)): billed on requests (one per new instance), CPU, steps and storage; 10M requests, 30M CPU ms, 1 GB-month storage and 500,000 steps included, then $0.80 per 100,000 steps and $0.20 per GB-month; sleeping instances use no CPU but their state counts as storage; retries and rollbacks are not counted as steps; step and storage billing starts 2026-08-10 or later as announced.
- Verified ([Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)): 10,000 steps per workflow by default (up to 25,000), 30 s CPU per step by default (up to 5 min), unlimited wall clock per step, `step.sleep` up to 365 days, 1 MiB persisted state per step and 1 GB per instance, 50,000 concurrent instances per account, state kept 7 days by default (up to 30).
- Decision: a grade is one Workflow instance with steps for capture, checks, Gemini and storage; screenshots go to R2 and only their keys pass between steps, so no step result nears 1 MiB and storage stays negligible.

### B2. Queues

- Verified: 1M operations a month included, then $0.40 per million; a message typically costs 3 operations; retention 4 days by default, up to 14 ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- Decision: free at every scenario in COSTS.md; Workflows alone may cover the grade queue, so Queues is optional.

### B3. Browser Rendering

- Verified ([pricing](https://developers.cloudflare.com/browser-rendering/pricing/), page dated 2026-04-21): Workers Paid includes 10 browser hours a month, then $0.09 an hour, and 10 concurrent browsers averaged monthly (the monthly average of each day's peak), then $2.00 per browser; REST "Quick Actions" such as `/screenshot` bill browser hours only and report `X-Browser-Ms-Used`; daily time is totalled in seconds and rounded to the nearest hour per cycle; a Quick Action that fails with a `waitForTimeout` error is not charged.
- Verified ([limits](https://developers.cloudflare.com/browser-rendering/limits/)): Workers Paid allows 200 concurrent browsers per account, 3 new browsers per second, 30 Quick Actions per second, a 60 s idle timeout extendable to 20 min with `keep_alive`.
- Not documented: browser time per capture for our pages (the settle polls in `pipeline/capture.mjs` wait for motion to stop).
- Test C1: capture 20 listed sites (desktop hero, full page, mobile) through Browser Rendering and read `X-Browser-Ms-Used` or the session duration.
  Cost: about 10 browser minutes of the 10 included hours.
  Proves: seconds per capture; COSTS.md assumes 30 s.
- Decision (owner, 2026-11-10): Browser Rendering is parked; all browser work (captures, health checks) stays on GitHub Actions, which is free for this public repository (section F).
  Browser Rendering is the upgrade path if Actions becomes too slow or the terms risk in section F materialises; test C1 runs only then.

### B4. Workers AI images

- Verified ([Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)): 10,000 neurons a day free on both plans, then $0.011 per 1,000 neurons on Paid; limits reset at 00:00 UTC.
  `@cf/black-forest-labs/flux-1-schnell` costs 4.80 neurons per 512 x 512 tile and 9.60 neurons per step.
- Verified ([flux-1-schnell](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/)): `steps` defaults to 4, maximum 8; output is a base64 image.
- Not documented: the output size, and whether the tile and step charges add up.
- Estimate, if they add: a 1024 x 1024 image is 4 tiles x 4.80 + 4 steps x 9.60 = 57.6 neurons, so about 170 free images a day; at 512 x 512, about 1,000.
- Test C2: generate one image with default settings and read its dimensions and the neurons the dashboard shows for it.
  Cost: under 100 neurons, inside the free allowance.
  Proves: images a day on the free allowance; the content plan needs about 3 a day.
- Decision: unchanged (Workers AI illustrations on the free allowance only).

### B5. R2

- Verified ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)): Standard storage $0.015 per GB-month with 10 GB-month free; Class A (writes, lists) 1M free then $4.50 per million; Class B (reads) 10M free then $0.36 per million; deletes free; no egress charge, r2.dev included.
- Not documented: whether reads through a custom domain or a Worker that hits the Cache API first count as Class B.
- Test C3: for one day, compare R2's Class B count in the dashboard with the Worker's screenshot request count.
  Cost: none.
  Proves: the edge cache hit rate, which decides whether Class B ever leaves the free 10M.
- Measured locally (not a doc): screenshots average 68 KB (hero, p95 130 KB), 228 KB (full page) and 30 KB (mobile), so about 330 KB a site, 0.7 GB for 2,100 sites.

### B6. D1 and KV

- Verified ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)): D1 on Workers Paid includes 25 billion rows read, 50 million rows written and 5 GB a month, then $0.001 per million reads, $1.00 per million writes and $0.75 per GB-month; no egress or compute charge; read replicas cost nothing extra.
  Rows read count every scanned row; an index on a written column adds a written row.
- Verified: KV includes 10M reads, 1M writes, 1M deletes, 1M lists and 1 GB, then $0.50 per million reads and $5.00 per million writes ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- See section E for the Turso or D1 comparison.

### B7. Web Analytics

- Verified: "Available on all plans"; unlimited sites when proxied through Cloudflare, 10 when not ([Web Analytics](https://developers.cloudflare.com/web-analytics/), [limits](https://developers.cloudflare.com/web-analytics/limits/)).
- Not documented on those pages: a price, data retention, sampling and custom events.
- Decision: use Web Analytics for page views (it is already on the account at no charge on the bill) and store only daily roll-ups of our own product events (section C).

### B8. Cloudflare API rate limit (matters for D1 from GitHub Actions)

- Verified: 1,200 requests per five minutes per user across dashboard, keys and tokens; exceeding it blocks all API calls for five minutes with 429 ([API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)).

## C. Turso

- Assumption in PLAN.md: "free 9GB/1B reads".
- Contradicted: the Free plan is 5 GB, 500 million rows read and 10 million rows written a month, 100 databases, 3 GB syncs and 1 day of point-in-time restore; Developer ($4.99 a month) is 9 GB, 2.5 billion reads, 25 million writes and 10 days of restore ([pricing](https://turso.tech/pricing)).
- Verified: on the Free plan (or a paid plan with overages off), exceeding any one monthly limit blocks the databases and every query fails with `BLOCKED` ([usage and billing](https://docs.turso.tech/help/usage-and-billing), [pricing](https://turso.tech/pricing)).
- Verified: a row read is a row scanned (aggregates, unindexed filters, joins and `ALTER TABLE` scan every row), a row written includes inserts and updates and is counted even in an uncommitted transaction, and `VACUUM` is disabled ([usage and billing](https://docs.turso.tech/help/usage-and-billing)).
- Not verified: which Turso plan the production database is on; the backup workflow calls it "the free-tier DB".
- Test T1: the owner reads the plan and this month's usage in the Turso dashboard.
  Cost: none.
  Proves: the starting point for COSTS.md section C.
- Seen, not verified: every turso.tech page carries a banner saying Turso is joining Supabase; no terms or timeline were found on official pages.
- Decision: log tables get roll-ups and retention (COSTS.md section C) whichever database we use, and raw analytics events are never stored row by row.

## D. Google Play (Trusted Web Activity)

- Verified: a one-time US$25 registration fee; government ID and a card in the legal name may be asked for; personal accounts must verify access to an Android device with the Play Console app before publishing ([Play Console sign-up](https://support.google.com/googleplay/android-developer/answer/6112435)).
- Verified: personal developer accounts created after 2023-11-13 must run a closed test with at least 12 testers opted in for the preceding 14 consecutive days before applying for production; review usually takes 7 days or less ([testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465)).
  The plan therefore needs about 3 weeks and 12 real testers between the first upload and the store listing.
- Verified: a TWA needs `/.well-known/assetlinks.json` with relation `delegate_permission/common.handle_all_urls` for namespace `android_app` and the SHA-256 fingerprint of the signing key; with Play App Signing the Play key differs from the upload key, so list both; when verification fails the app opens as a Custom Tab with the URL bar ([TWA for web devs](https://developer.chrome.com/docs/android/trusted-web-activity/android-for-web-devs)).
- Verified: every published app completes the Data safety form, even one that collects nothing, and needs a privacy policy link; data from a WebView counts as collected when the app controls the content in it ([Data safety](https://support.google.com/googleplay/android-developer/answer/10787469)).
- Verified: an app that lets users create an account must offer an in-app path to delete the account and its data and a web link for deletion requests listed in the Data safety form; data may be kept for security, fraud prevention or legal reasons if the privacy policy says so ([account deletion](https://support.google.com/googleplay/android-developer/answer/13327111)).
  Sign-in with GitHub creates a PortfolioRank account, so this applies: a delete-account action in settings and a public deletion page.
- Verified: Play's spam policy forbids apps whose primary purpose is a webview of a website without the owner's permission or driving affiliate traffic ([spam policy](https://support.google.com/googleplay/android-developer/answer/9899034)); our own site is allowed.
- Not verified: the Minimum Functionality rules (in Play's "Functionality, Content, and User Experience" policy) for thin web wrappers, and any Chrome-enforced TWA quality checks.
- Test P1: build with Bubblewrap, install on a device, confirm no URL bar (asset links), then go through the pre-launch report of a closed-test upload.
  Cost: the $25 fee (needed anyway) and an hour.
  Proves: asset links, policy warnings and pre-launch crashes before the 14-day clock starts.
- Decision: before the Play work starts, the site needs account deletion in settings, a public deletion page, and a privacy policy that covers app data; the 12-tester, 14-day test goes on the roadmap as a calendar item.

## E. Turso or Cloudflare D1 (reference)

Decision (owner, 2026-11-10): PortfolioRank stays on Turso for now.
Revisit if Turso's free limits get close (COSTS.md section C shows when); by then paying for a database may be the answer anyway, on Turso or D1.
This section keeps the comparison so that decision can be made quickly.

| | Turso Free (assumed today) | Turso Developer | D1 on Workers Paid |
| --- | --- | --- | --- |
| Monthly price | $0 | $4.99 | $0 extra (inside the $5 we pay) |
| Rows read a month | 500M, then blocked | 2.5B, then $1 per billion | 25B, then $0.001 per million |
| Rows written a month | 10M, then blocked | 25M, then $1 per million | 50M, then $1.00 per million |
| Storage | 5 GB | 9 GB | 5 GB included, 10 GB per database max |
| Restore window | 1 day | 10 days | 30 days, always on, free |
| Over the limit | every query fails (`BLOCKED`) | billed | billed |

Sources: [Turso pricing](https://turso.tech/pricing), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

What else the D1 docs say:

- Restore: `wrangler d1 time-travel restore DB --timestamp=...` or `--bookmark=...` overwrites the database in place, cancels queries in flight, returns a bookmark that undoes it, cannot restore into a new database, and allows 10 restores per 10 minutes ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).
- Per-query limits: 30 s per query, 100 KB per statement, 100 bound parameters per query, 2 MB per row, 100 columns per table, 1,000 queries per Worker invocation (a `batch()` counts as one), 6 connections per invocation ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)); results over 50 MB fail from 2026-11-04, imports and exports excepted ([changelog](https://developers.cloudflare.com/changelog/post/2026-10-30-query-result-size-limit/)).
- Transactions: in a Worker, `batch()` runs its statements as one SQL transaction and rolls back on failure; interactive transactions across awaits are not documented ([D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)).
- Import: dump to SQL, remove `BEGIN TRANSACTION`/`COMMIT`, then `wrangler d1 execute DB --remote --file=db.sql` (5 GiB per file); a running export blocks other requests ([import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)).
- From GitHub Actions, where the pipeline stays: only through `POST /accounts/{account_id}/d1/database/{database_id}/query`, which takes `{sql, params}` or `{batch: [...]}` and reports `rows_read` and `rows_written` per result ([D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)).
  Cloudflare calls the REST API "best suited for administrative use as the global Cloudflare API rate limit applies" ([D1 proxy tutorial](https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/)): 1,200 requests per 5 minutes per user, shared with deploys, and exceeding it blocks every API call for 5 minutes ([API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)).
  Whether a REST batch is atomic, its size limit and its latency from a runner are not documented.

What a move would take, if it is revisited:

1. One small adapter (`execute`, `batch`) under the app, the pipeline and the scripts.
2. The six interactive transactions (`app/api/claim`, `app/api/rank` twice, `app/api/rank/undo`, `app/api/lists`, `app/api/lists/[id]/items`) rewritten as single batches with their guards in SQL.
3. Pipeline writes collected and sent in batches (today it makes one round trip per comparison, vote and log row), or a small authenticated Worker endpoint that uses the binding, so the account-wide API limit is never at risk.
4. Local development and end-to-end tests on Wrangler's local D1 instead of a libSQL file.
5. A cutover with writes paused for minutes (the data is about 0.3 MB gzipped), row counts compared per table, Turso kept read-only for 30 days.

The cheaper step on Turso, if limits get close first, is the Developer plan ($4.99), which also lengthens point-in-time restore from 1 day to 10.

## F. GitHub Actions for browser work

Decision (owner, 2026-11-10): captures and every other browser job stay on GitHub Actions; Browser Rendering is a later upgrade option (B3).

- Verified: standard GitHub-hosted runners are free in public repositories and do not use included minutes; larger runners are billed even for public repositories ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
  The repository is public (checked with `gh repo view`, 2026-11-10).
- Verified ([Actions limits](https://docs.github.com/en/actions/reference/limits)): GitHub Free allows 20 concurrent jobs on standard runners (5 macOS); a job runs up to 6 hours; a workflow run up to 35 days; at most 500 workflow runs are queued per 10 seconds and 1,500 trigger events per 10 seconds per repository; `GITHUB_TOKEN` gets 1,000 API requests per hour per repository and a personal access token 5,000.
  No separate limit is documented for `workflow_dispatch` or `repository_dispatch`.
- Verified: standard runners with labels such as `ubuntu-latest` are kept warm ([larger runners reference](https://docs.github.com/en/actions/reference/runners/larger-runners)); no typical or maximum queue time for hosted runners is documented (the 24-hour queue limit is for self-hosted runners).
- Measured on this repository (2026-11-10, 72 jobs from the last 60 runs, job `created_at` to `started_at`): median 2 s, 90th percentile 3 s, maximum 4 s.
  Setup before the first capture adds about 35 to 50 s: `setup-node` 5 to 10 s, `npm ci` 12 to 18 s, `playwright install --with-deps chromium` 17 s (step timings of a recent `judge-vote` and CI run).
  So an on-demand capture starts about 40 to 60 s after dispatch on a normal day.
- Verified worst case: in GitHub's July 2026 availability report, about 8% of hosted-runner workflow runs were delayed more than 5 minutes and about 2% failed to start during the 2026-07-09 incident ([availability report](https://github.blog/news-insights/company-news/github-availability-report-july-2026/)).
  Plan for "minutes, occasionally never": the grade page shows progress and the queue retries a dispatch that has not started within 10 minutes.
- Concurrency: jobs in one `concurrency` group run one at a time and the next waits as pending ([concurrency](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs)); the nightly jobs and on-demand captures together must stay under 20 concurrent jobs.
- Verified, a terms risk: GitHub's Actions terms say Actions should not be used "as part of a serverless application" where the burden on GitHub outweighs the benefit to users, nor, on GitHub-hosted runners, for "any other activity unrelated to the production, testing, deployment, or publication of the software project"; misuse can end in disabled repositories or a suspended account ([additional product terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)).
  Nightly captures of the project's own list are arguably part of producing the project's data; a capture dispatched for each visitor's "grade my portfolio" is closer to a serverless backend.
- Decision (recommended to the owner): keep scheduled, batched browser work on Actions; for the public grader, batch on-demand requests into a few dispatches an hour rather than one per visitor, and keep Browser Rendering ready as the switch if volume grows or GitHub objects (at the modest scenario it would cost $0, see COSTS.md).

## G. Restore test for the nightly backup

Assumption: the nightly R2 snapshot (`.github/workflows/backup.yml`, `scripts/backup-db.mjs`) can rebuild the database if Turso loses it.
Turso Free keeps only 1 day of point-in-time restore (section C), so this snapshot is the real backup.

What the snapshot holds (format 2, `scripts/lib/snapshot.mjs`, since #72): every row and column of every table except `cache` (PageSpeed and inspect results, refetched on demand) and `matchups` (minutes of draw state), plus the schema as SQLite stored it (tables, indexes, triggers).
That includes `comparisons`, `likes`, `lists` and `list_items`, all of `portfolios` (`page_text`, `facts`, `meta`), `rubric_history`, `gemini_requests` and `gemini_daily`, the ranking tables, `night_runs`, `night_item_failures`, `people_requests`, `owner_alerts`, the vote counters and `schema_meta`; a table added later is included automatically.
Before #72 it held only `votes`, `ratings` and eight columns of `portfolios`; such a format 1 snapshot still restores.
Each snapshot expires 35 days after it is written: the bucket's lifecycle rule `expire-backups-35d` on the `backups/` prefix, which is what the privacy page (`/privacy`) promises, so a deletion is complete within 35 days.
Check it with `npx wrangler r2 bucket lifecycle list portfolio-rank-backups`.

Procedure (the owner runs it; it needs Turso and R2 credentials and touches only a scratch database):

1. Create a scratch database and a token for it: `turso db create pr-restore-test` and `turso db tokens create pr-restore-test`.
   Keep both in `pass` (for example `portfolio-rank/RESTORE_DATABASE_URL` and `portfolio-rank/RESTORE_AUTH_TOKEN`), never in a file or the chat.
2. Download last night's snapshot from the private bucket: `npx wrangler r2 object get portfolio-rank-backups/backups/portfoliorank-YYYY-MM-DD.json.gz --remote --file=/tmp/pr-restore.json.gz`.
   The log line of that night's backup run gives the expected counts (`votes:N ratings:N portfolios:N comparisons:N ...`, one per table).
3. Restore into the scratch database: `pass-env run -- node scripts/restore-db.mjs /tmp/pr-restore.json.gz`, with the restore credentials as `RESTORE_DATABASE_URL` and `RESTORE_AUTH_TOKEN`.
   The script reads only those two, refuses to run when `RESTORE_DATABASE_URL` equals `TURSO_DATABASE_URL` or the target has any table, creates the snapshot's tables, loads every row in batches of 200, then the indexes and triggers (so the vote counters come back as saved), runs the migration for anything newer, and prints each table's count against the snapshot, exiting non-zero on any mismatch.
4. Compare with the backup log line from step 2: every table's count matches.
5. Spot-check against production: `SELECT COUNT(*) FROM portfolios WHERE ai_rubric IS NOT NULL` and `SELECT n FROM vote_totals WHERE k = 'all'` match; ten random `votes` and `comparisons` rows match by `id`.
6. Point a local dev server at the scratch database (`pass-env run` with the restore credentials as `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`) and open `/top` and one `/p/[slug]` page: the board and a grade card render.
7. Delete the scratch database: `turso db destroy pr-restore-test`, and remove the two `pass` entries.

Cost: one scratch database on the Free plan (100 allowed) and a few thousand rows written, well under 1% of the monthly 10 million.
Proves: the snapshot restores every table and the site runs on it.
The same round trip runs on throwaway files in CI (`tests/backup-restore.test.mjs`); this drill proves it on the real data and credentials.
Repeat after any change to the backup script, and at least every quarter.
