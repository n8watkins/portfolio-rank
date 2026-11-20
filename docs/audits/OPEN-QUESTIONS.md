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
| 21 | Later: run /mcp, re-authenticate Cloudflare and also grant Zone Settings, DNS, Bot Management, Web Analytics and Email Sending, so the ops session can do Web Analytics for portfoliorank.dev, the AI-crawler setting (search yes, training no), DNSSEC on both domains, HTTPS-only on n8builds.dev, the Kit and Google verification DNS records, and the one-off test email from portfoliorank.dev (Email Sending onboarding; DMARC p=none like n8builds.dev) | Owner will do it later | 2026-11-13 |
| 11 | Create a separate Gemini key for staging: `! pass-env set portfolio-rank/STAGING_GEMINI_API_KEY` | Yes, when experiments resume | 2026-11-13 |
| 12 | First automatic goals: "Newsletter: move to Kit" at 40 subscribers, "Library: 5,000 graded portfolios" | Yes | 2026-11-13 |

## Will need you soon

| # | What | When |
|---|---|---|
| 13 | Press "Send test alert" on the admin page and check the email arrives (not in spam) | When the button is live |
| 14 | Grading experiment done (report: https://claude.ai/artifact/UVo5LGTefzcjTQAjeCJML9, PR #185). Approve one more check round (about 32 Gemini requests) on the not-a-portfolio check and the too-many-5s fix, then switch report cards to rubric v3 with thinking "low" and grade in batches of 5 (about 400 to about 80 requests a day)? | Now |
| 15 | Keep or retire the unmerged `feat/report-redesign` branch (no PR, last commit Nov 12) | Any time |
| 16 | Add your portfolio (#140): a site someone added that isn't listed yet can't be claimed, re-checked or removed by its real owner. Suggested: let the real owner claim it by the usual GitHub/site check, then re-check or remove it | Before #140 goes live |
| 17 | Add your portfolio (#140): people who add a site they don't own have no limit of their own, only the grader's overall caps. Suggested: 3 unclaimed adds a day per account | Before #140 goes live |
| 18 | Sentry: after #167 deploys, resolve PORTFOLIORANK-2 and add an alert for new issues (I can do it with sentry-cli on your yes) | After #167 |
| 19 | Blog author in search results: you (Nathan Watkins, n8builds.dev, GitHub) or the PortfolioRank organization? #180 uses you. Suggested: you, since /about-posts already says you publish each post | Before #180 merges |
| 20 | List graded sites added through "Add your portfolio" (not on the original list) in the sitemap too? Suggested: yes | After #184 |
| 21 | NetTrailers serves public/check-store-data.html and public/clear-cache.html to anyone. Suggested: remove both | Any time |
| 22 | Walk through staging and approve (or not) the look of the report-card redesign and the compact face-off (#123). They stay off the real site until you OK screenshots | When you have 15 minutes |
| 23 | Approve the new blog look (#131: contents rail, TL;DR box, image motion, More articles). Screenshots in the ops scratchpad shots/blog-layout/ (post and index, desktop and mobile). Stays staging-only until you OK it | When you have 5 minutes |
| 24 | OK to remove two leftover throwaway things the safety guard wouldn't let lanes discard: worktree ~/worktrees/portfolio-rank-staging-check (mid-merge, no real work) and the 7 merged NetTrailers branches in ~/projects/net_trailers | Any time |

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
