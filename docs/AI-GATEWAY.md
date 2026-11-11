# AI Gateway rate limit for Workers AI

The account is on Workers Paid.
Past the free 10,000 neurons a day, Workers AI bills instead of stopping.
PortfolioRank's slice is 5,000 neurons a day for images (account-wide plan: PortfolioRank images 5,000, everything else 1,000, buffer 4,000).

## How it is enforced

Every `AI.run` goes through `withGateway` in `lib/ai-gateway.mjs`, which passes `{ gateway: { id: "portfoliorank-ai" } }`.
The gateway holds a Cloudflare-side rate limit, so the cap holds even if the code's own neuron ceiling has a bug.
A 429 from the gateway becomes `AiBudgetExhausted`.
That is treated as "budget spent": the call fails, nothing retries, and the pipeline moves to its non-AI fallback.

## The numbers

Flux Schnell at 1024 x 1024 and 4 steps costs about 58 neurons an image.
5,000 / 58 = 86.2, so at most 86 images a day.
The limit must be a sliding window, because a fixed window lets a burst on each side of a boundary through (up to twice the limit in one window).

| Option | Setting | Max a day | Max neurons a day |
| --- | --- | --- | --- |
| A (preferred, if the dashboard accepts a 24 hour window) | 86 requests per 86,400 seconds, sliding | 86 | 4,988 |
| B (if the window must be shorter) | 3 requests per 3,600 seconds, sliding | 72 | 4,176 |

Option B uses 3, not ceil(86 / 24) = 4, because 4 an hour allows 96 a day (5,568 neurons), which breaks the slice.
The same gateway also covers Lucid Origin fallbacks if they are ever used, so check the neuron cost of any new model before relaxing the number.

## Setup (owner, one time)

The Cloudflare API connection used by agents has no write scope for AI Gateway, so create it in the dashboard.
Go to AI, then AI Gateway, then Create Gateway, and name it `portfoliorank-ai`.
Open its Settings and enable Rate-limiting.
Set the rate and period from the table above, and the method to Sliding.
Leave caching off.
Gateways are free on every plan (10 per account on the free plan, 20 on paid), and rate limiting has no extra charge.
