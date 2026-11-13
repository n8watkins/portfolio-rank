# Remove me, or don't name me

> Live at `/removal` (`app/removal/page.tsx`); keep the two in step. Not legal advice. See [README.md](README.md).

Last updated: November 12, 2026.

PortfolioRank lists real people's portfolios, ranks them, and writes about what it finds.
If you're one of them, you decide how much of that you want.
No reason needed.

**Checking a site adds it to PortfolioRank; you can ask for removal at any time**, including while it's still waiting to be graded.

## Three things you can ask for

1. **Remove me.**
   Your site leaves PortfolioRank: the grid, face-offs, the leaderboard, the blog and its profile page.
   It is never added back, even if it's still on the community list.
2. **Don't name me.**
   Your site stays listed and ranked, but posts never name you, link you or show your screenshot.
   You still show up in totals ("1 of 2,103 sites").
3. **Fix my listing.**
   A new address, a new name, or a fresh screenshot and grade after a redesign.

## Do it yourself, for a listed site

Sign in with GitHub and open the claim page (`/claim`).
Prove the site is yours with a short code you add to the page (a github.io site can use the GitHub account it belongs to).
Then:

- Hide its grade: takes effect at once, and you can show it again.
- Remove it: takes effect 24 hours later.
  You can cancel until then, and I'm told about it, so a removal by someone who isn't the owner can be stopped.
- A link from the site to your GitHub profile is enough to claim it, but hiding or removing needs the code, or a claim I've reviewed.

## Ask me, for any site

Use this for a site that isn't listed yet (for example one still waiting to be graded), for "don't name me", or if you'd rather not sign in.

- **Private:** email nate@n8builds.dev with your site's address and which of the three you want.
- **Public:** open a "Remove my portfolio" issue on [GitHub](https://github.com/n8watkins/portfolio-rank/issues/new?template=remove-portfolio.yml).
  Issues are public, so anyone can see the request.

For "remove me" and "fix my listing", I check the request comes from the site's owner, for example from an email on the site's domain or the GitHub account the site links to, so nobody can take someone else's site down.
"Don't name me" only takes something away, so it needs no proof.

## What happens, and when

- I act on emailed and GitHub requests within 14 days.
- **Remove me:** the site goes on PortfolioRank's exclusion list and disappears everywhere on the site.
  Its screenshots and stored page data are deleted 30 days later, and the last backup holding them expires 35 days after that.
  Past votes stay in the vote log the leaderboard is computed from, but your site is no longer shown anywhere.
  They're anonymous: a vote says which two sites were compared, never anything about the site's owner.
- **Don't name me:** your site goes on my do-not-name list.
  I read every post before it's published, and a draft that names you doesn't go out.
  (There is no automatic do-not-name check in the content pipeline yet; the owner's review is the check.)
- Already published: any post that names you is edited to remove your name, link and screenshot within the same 14 days.
  Emails that were already sent can't be recalled.
- The [removed page](https://portfoliorank.dev/removed) counts removal requests but never says whose they were.

## How people are written about anyway

Even without a request, PortfolioRank names individual developers only for good reasons: top sites, big climbers, redesigns that paid off.
Low scores and anything critical are only ever discussed in aggregate, and a post that breaks this rule is dropped before it's published.
Details: [ai-content.md](ai-content.md) (`/about-posts`).

## The community list

PortfolioRank's list comes from [emmabostian/developer-portfolios](https://github.com/emmabostian/developer-portfolios).
Removing yourself from PortfolioRank doesn't remove you from that list; to leave it too, open a pull request or issue there.

## When the newsletter launches

Add "the newsletter" to what "remove me" and "don't name me" cover, and add: "Emails that were already sent can't be recalled."
