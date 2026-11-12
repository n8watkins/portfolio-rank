# AI Gateway rate limit for Workers AI

The account is on Workers Paid.
Past the free 10,000 neurons a day, Workers AI bills instead of stopping.
PortfolioRank's cap is at most 40 AI images per UTC day (about 2,320 neurons, hard ceiling 2,500), with no hourly cap in the app (owner, 2026-11-11: "40 a day only").
Account-wide Workers AI slices: PortfolioRank images 2,500 neurons max, everything else 1,000, the rest buffer.

## How it is enforced

Every `AI.run` goes through `withGateway` in `lib/ai-gateway.mjs`, which passes `{ gateway: { id: "portfoliorank-ai" } }`.
The gateway holds a Cloudflare-side rate limit, so a burst is stopped even if the code's own counters have a bug.
A 429 from the gateway becomes `AiBudgetExhausted`.
That is treated as "budget spent": the call fails, nothing retries, and the pipeline moves to its non-AI fallback.
On `/admin/images`, "Make now" then says "The AI Gateway allows N an hour: raise it in AI Gateway settings".

The code's own limits come first: `MAX_AI_IMAGES_PER_DAY` (40) and `AI_NEURON_CEILING` (2,500), each reserved before the call in one database statement ([lib/content/neurons.mjs](../lib/content/neurons.mjs)).

## The numbers

Flux Schnell at 1024 x 1024 and 4 steps costs about 58 neurons an image.
40 images a day is about 2,320 neurons.
The limit must be a sliding window, because a fixed window lets a burst on each side of a boundary through (up to twice the limit in one window).

| Setting | Rate | Max images a day through the gateway alone | Max neurons a day, all Schnell |
| --- | --- | --- | --- |
| Current (owner, 2026-11-11) | 40 requests per 3,600 seconds, sliding | 960 | 55,680 |
| Before 2026-11-11 | 2 requests per 3,600 seconds, sliding | 48 | 2,784 |

At 40 an hour the gateway is a burst backstop, not the daily cap: the daily cap of 40 images and 2,500 neurons is the code's, and the gateway alone would let far more through in a day than the free 10,000 neurons.
The second backstop is the gateway's Workers AI spend limit ($1 a month), which stops billing if both the code and the rate limit failed.

## Setup (owner, one time)

The Cloudflare API connection used by agents has no write scope for AI Gateway, so create it in the dashboard.
Go to AI, then AI Gateway, then Create Gateway, and name it `portfoliorank-ai`.
Open its Settings and enable Rate-limiting.
Set the rate to 40 requests per 3,600 seconds and the method to Sliding.
Leave caching off.
Gateways are free on every plan (10 per account on the free plan, 20 on paid), and rate limiting has no extra charge.
