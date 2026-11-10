# Model limits

A one-page reference for what the judge model, `gemini-3.5-flash-lite`, can take and what a request costs.
Sources were read on 2026-11-10; the reasoning and the open questions are in [ASSUMPTIONS.md](ASSUMPTIONS.md) section A.

## The model

| | 3.5 Flash-Lite (judge) | 3.1 Flash-Lite (experiments only) | Source |
| --- | --- | --- | --- |
| Status | Stable, released 2026-07-21, no shutdown date | Stable, released 2026-05-07, shutdown 2027-05-07 | [models](https://aistudio.google.com/docs/models), [deprecations](https://aistudio.google.com/docs/deprecations) |
| Input limit | 1,048,576 tokens | 1,048,576 tokens | [3.5](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite), [3.1](https://aistudio.google.com/docs/models/gemini-3.1-flash-lite) |
| Output limit | 65,536 tokens (thinking included) | 65,536 tokens | same |
| Thinking levels | minimal (default), low, medium, high; never fully off | same | [thinking](https://aistudio.google.com/docs/thinking?generate-content=true) |
| Paid input, per 1M tokens | $0.30 | $0.25 | [pricing](https://aistudio.google.com/docs/pricing) |
| Paid output, per 1M tokens (thinking included) | $2.50 | $1.50 | same |
| Batch API | half price | half price | same |
| Free tier RPM, TPM, RPD | not public; read in AI Studio (test G1) | same | [rate limits](https://aistudio.google.com/docs/rate-limits) |

Daily quotas are per project and reset at midnight Pacific.

## How we send images today

- Every image is an `inline_data` part with base64 data: `image/jpeg` for screenshots (`pipeline/judge.mjs` `imagePart` and the R2 fetch, `pipeline/compare.mjs` `hero`), `image/png` only for an old local `.png` capture.
- The image is `hero.jpg`: the top of the page in a 1440 x 900 viewport, JPEG quality 75 (`pipeline/capture.mjs`).
  Over 1,696 local captures it is 68 KB at the median, 130 KB at the 95th percentile and 231 KB at most, so 91 KB, 173 KB and 308 KB as base64.
  A file over 5 MB is skipped.
- A grade (`pipeline/rubric.mjs`) sends one hero, the facts and up to 4,000 characters of page text; thinking `minimal`, `maxOutputTokens` 2,048 (600 until #PRNUM), temperature 0.2.
- A one-on-one comparison (`pipeline/compare-prompts.mjs`) sends two heroes with 1,200 characters of page text each; a batched comparison sends N heroes with 600 characters each; both use thinking `minimal` and `maxOutputTokens` 1,024 (400 until #PRNUM).
- Email addresses and phone numbers in page text and names are replaced by `[email]` and `[phone]` before the prompt is built (`pipeline/redact.mjs`).
- Every response's `finishReason` is logged; an answer that did not finish with `STOP` (such as `MAX_TOKENS`) is a failed answer, never stored and not retried (`pipeline/gemini.mjs`).
- No `media_resolution` is set, so every image costs the default 1,120 tokens on Gemini 3.

## Hard limits on one request

| Limit | Value | What it allows at our image size | Source |
| --- | --- | --- | --- |
| Total inline request size | 20 MB (another page says 100 MB; we plan to 20) | about 115 heroes at the 95th percentile, 65 at the largest | [image understanding](https://aistudio.google.com/docs/image-understanding?generate-content=true), [input methods](https://aistudio.google.com/docs/file-input-methods) |
| Images per request | 3,600 | not binding | [image understanding](https://aistudio.google.com/docs/image-understanding?generate-content=true) |
| Input tokens | 1,048,576 | about 800 sites at the default resolution | model pages |
| Tokens per image | low 280, medium 560, high and default 1,120, ultra high 2,240 | fixed per image, whatever its pixel size | [media resolution](https://aistudio.google.com/docs/media-resolution?generate-content=true) |
| Output tokens | our cap 1,024 for comparisons and 2,048 for grades, which includes thinking | a 10-site order is about 40 tokens plus a short reason | [thinking](https://aistudio.google.com/docs/thinking?generate-content=true) |
| Labels | A to Z in `labelOf` | 26 sites | `pipeline/compare-prompts.mjs` |
| Tokens per minute | not public (test G1) | the real cap on large batches at our pace of 8 requests a minute | [rate limits](https://aistudio.google.com/docs/rate-limits) |

None of the documented limits stops a 10-site batch; the practical limits are tokens per minute, the judge's attention and position bias, and the answer cap.

## Tokens and cost per comparison

Estimates: an image is 1,120 tokens at the default resolution (280 at low); text is about 4 characters a token; each site adds about 40 tokens of label and wrapper; the system instruction and framing add about 160.
Output is about 50 tokens for a pair and 40 + 6 per site for a batch, with `minimal` thinking assumed near zero (log `thoughtsTokenCount` to check).
Costs are at the paid standard rate of 3.5 Flash-Lite; the Batch API halves them.

| Sites per request | Input tokens (default) | Input tokens (low) | Pairs implied by the order | Input tokens per implied pair | Paid cost per request | Request size at p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 (one-on-one) | 3,080 | 1,400 | 1 | 3,080 | $0.0011 | 0.4 MB |
| 3 | 4,090 | 1,570 | 3 | 1,360 | $0.0014 | 0.5 MB |
| 5 (today's `BATCH_SIZE`) | 6,710 | 2,510 | 10 | 670 | $0.0022 | 0.9 MB |
| 6 | 8,020 | 2,980 | 15 | 535 | $0.0026 | 1.1 MB |
| 9 | 11,950 | 4,390 | 36 | 330 | $0.0038 | 1.6 MB |
| 10 | 13,260 | 4,860 | 45 | 295 | $0.0042 | 1.8 MB |

A grade on rubric v2 is about 3,000 input tokens (one image, about 1,000 of page text, facts and instructions) and about 200 output tokens: about $0.0014 at paid rates.

"Pairs implied" counts every pair an order ranks; they are not independent judgements, so a 10-site order is worth less than 45 one-on-one answers.
That gap is what the batch experiment measures.

## Implications for a tiered batch experiment

- Request count is not the constraint: one request per batch at any tier, so a tier costs the same number of requests as one-on-one for many more implied pairs.
- Tokens are: a 10-site request is 4.3 times the input of a pair; at 8 requests a minute, 10-site batches use about 106,000 input tokens a minute at the default resolution and 39,000 at low.
  Read the project's TPM in AI Studio (test G1) before running the 9 and 10 tiers at full pace.
- Media resolution is a second axis: low cuts a 10-site batch from 13,260 to 4,860 tokens, but whether the judge still reads small text in a 1440 x 900 hero at 280 tokens is unknown.
  Run a small tier at default and at low on the same sets before choosing.
- Measure for each tier (3, 6, 9, 10 against one-on-one): agreement of implied pairs with the one-on-one majority, Kendall's tau between orders of the same set shown in two different orders (consistency), the rank a site gets by its slot (position bias), schema failures, and `finishReason` `MAX_TOKENS` (test G5).
- A sizing that fits today's experiment budget: 30 sets of 10 sites; each tier ranks the same sites (the 3- and 6-site tiers on subsets) twice in different orders, about 60 requests per tier and 240 for four tiers; the one-on-one baseline asks all 45 pairs for 10 of the sets (450 requests) plus 100 repeats as the noise floor, about 800 requests in all, two days of the 3.5 budget for experiments.
- Keep each tier's prompt and schema versioned (`PROMPT_VERSION_BATCHED`) and store the order shown, so every result can be recomputed (DECISIONS.md, "Open method").
