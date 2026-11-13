# Open questions for the owner

Every question asked of the owner that is not answered yet, with the recommendation.
Updated by the ops session whenever one is asked or answered.
Last updated 2026-11-13 (evening).

## Waiting on you now

| # | Question | Recommendation | Asked |
|---|---|---|---|
| 4 | n8builds-web PR #201 (cuts about 1.5M ms of compute a month): merge and deploy it, or leave it to the n8builds session? | Leave it to the n8builds session, or let me merge it | 2026-11-13 |
| 5 | NetTrailers used 812k ms of compute on Nov 11: flag it to the NetTrailers session? | Yes | 2026-11-13 |
| 6 | Approve the "Add your portfolio" and profile screenshots (scratchpad shots/profile/) so readable profile URLs, sitemap index and structured data can proceed | Review | 2026-11-13 |
| 7 | The remaining strategy decisions (7 to 10, 12 to 22 in STRATEGY.md): "go with the picks"? | Yes | 2026-11-13 |
| 8 | AI votes count at 1/4 of a person's vote, only at tier edges | Yes | 2026-11-12 |
| 9 | Starting rank = 60% report card + 40% check points, after experiment 4 confirms | Yes | 2026-11-12 |
| 10 | The "synced" skill notice in your Claude settings (~/.claude/skills/synced): did you add it? | Check it | 2026-11-12 |
| 16 | PortfolioRank Kit: sender hello@portfoliorank.dev (confirm the link), a mailing address (PO box ok), Verified Sending Domain portfoliorank.dev (CNAMEs, DNS only), one inline double opt-in form. API key done | Yes | 2026-11-13 |
| 19 | n8builds Kit (second free account, login contact@n8builds.dev, sender "Nate from n8builds" <updates@n8builds.dev>): bio, `! pass-env set n8builds/KIT_API_KEY`, sending-domain records pasted to the ops session | Yes | 2026-11-13 |
| 20 | Newsletter mailing address (legally required in every email footer, shown publicly): avoid the home address; PO box (about $20 to $80 per 6 months) or virtual mailbox, decided before the first send for both Kit accounts | Decide before the first newsletter goes out | 2026-11-13 |
| 11 | Create a separate Gemini key for staging: `! pass-env set portfolio-rank/STAGING_GEMINI_API_KEY` | Yes, when experiments resume | 2026-11-13 |
| 12 | First automatic goals: "Newsletter: move to Kit" at 40 subscribers, "Library: 5,000 graded portfolios" | Yes | 2026-11-13 |

## Will need you soon

| # | What | When |
|---|---|---|
| 13 | Press "Send test alert" on the admin page and check the email arrives (not in spam) | When the button is live |
| 14 | Approve the priority experiments and build your answer key (about 40 portfolios, 15 minutes) | After P0 and P1 |

## Answered

| Question | Answer | Date |
|---|---|---|
| Security rules on portfoliorank.dev | Applied by the ops session after the owner reconnected Cloudflare: scanner block, nameless-client challenge, flood limit letting verified bots pass; checked live | 2026-11-13 |
| GitHub sign-in on the new domain | Works (owner confirmed) | 2026-11-13 |
| Privacy operator name | "n8builds", with a link to x.com/n8watkins | 2026-11-13 |
| Delete backups older than 35 days | Yes, only if the bucket holds nothing but backups (verified first) | 2026-11-13 |
| Move staging to staging.portfoliorank.dev | Yes, owner updated sign-in for both | 2026-11-13 |
| Pause all automated Gemini use until the audits finish | Yes, frozen | 2026-11-12 |
| Start P0 and P1 | Yes | 2026-11-13 |
| Release decisions 1 to 6 | Yes, with the picks | 2026-11-13 |
| Buy a domain | Bought portfoliorank.dev, move now | 2026-11-13 |
| Email progress updates | Yes, in one Gmail thread | 2026-11-13 |
| Goal emails with calendar invites, checked weekly | Yes | 2026-11-13 |
| Rank is the ELO; A is the top 30% | Yes | 2026-11-12 |
| No top-30 finals | Correct | 2026-11-12 |
| Profiles are the searchable content; no tool pages | Yes | 2026-11-12 |
| GitHub sign-in callbacks updated for both hosts | Done by the owner | 2026-11-13 |
