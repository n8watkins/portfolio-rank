# AI Gateway rate limit for Workers AI

The account is on Workers Paid.
Past the free 10,000 neurons a day, Workers AI bills instead of stopping.
PortfolioRank's cap is at most 40 AI images per UTC day (about 2,320 neurons, hard ceiling 2,500).
Account-wide Workers AI slices: PortfolioRank images 2,500 neurons max, everything else 1,000, the rest buffer.

## How it is enforced

Every `AI.run` goes through `withGateway` in `lib/ai-gateway.mjs`, which passes `{ gateway: { id: "portfoliorank-ai" } }`.
The gateway holds a Cloudflare-side rate limit, so the cap holds even if the code's own ceiling has a bug.
A 429 from the gateway becomes `AiBudgetExhausted`.
That is treated as "budget spent": the call fails, nothing retries, and the pipeline moves to its non-AI fallback.

## The numbers

Flux Schnell at 1024 x 1024 and 4 steps costs about 58 neurons an image.
40 images a day is about 2,320 neurons.
The limit must be a sliding window, because a fixed window lets a burst on each side of a boundary through (up to twice the limit in one window).

| Option | Setting | Max images a day | Max neurons a day |
| --- | --- | --- | --- |
| A (preferred, if the dashboard accepts a 24 hour window) | 40 requests per 86,400 seconds, sliding | 40 | 2,320 |
| B (if the window must be shorter) | 2 requests per 3,600 seconds, sliding | 48 | 2,784 |

Both options stay well under the 2,500 slice plus buffer and under the free 10,000.

## Setup (owner, one time)

The Cloudflare API connection used by agents has no write scope for AI Gateway, so create it in the dashboard.
Go to AI, then AI Gateway, then Create Gateway, and name it `portfoliorank-ai`.
Open its Settings and enable Rate-limiting.
Set the rate and period from the table above (option A if it accepts a day, else B), and the method to Sliding.
Leave caching off.
Gateways are free on every plan (10 per account on the free plan, 20 on paid), and rate limiting has no extra charge.
