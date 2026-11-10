# Privacy

> **DRAFT, not legal advice.** Not linked from the site yet. See [README.md](README.md).

Last updated: [owner: date it goes live].

PortfolioRank is a side project run by me, [owner: legal name, or business name if there is one].
This page says what the site stores about you, why, who else sees it, and how long it's kept.
Short version: I store as little as I can, I never sell anything, and you can ask me to delete what's yours.

Questions or requests: [owner: contact email].

## If you just browse

- **No account, no tracking cookies.**
- **Page-view counts** come from Cloudflare Web Analytics, which counts visits without cookies and without building a profile of you.
- **Error reports** go to Sentry when a page breaks.
  They carry the error and the page's path, nothing else: no account, no cookies, no request headers, no query string.
- **Hosting logs.** The site runs on Cloudflare, which sees your IP address and browser details to serve the page, as any host does.
  I don't store your IP address in PortfolioRank's database.

## If you vote without signing in

You get a few practice votes before signing in.
To make that work, the site sets one cookie holding a random id, signed so it can't be forged.
Your practice votes and the pairs you were shown are stored against that id, with the time.
If you sign in afterwards, those votes can move to your account.

## If you sign in with GitHub

Sign-in uses your GitHub account.
GitHub tells PortfolioRank your GitHub id number, username, display name, email, avatar and the date your GitHub account was created.

- Your **session** lives in a signed, encrypted cookie in your browser, not in my database.
- What I **store** is keyed by your GitHub id number: your votes, your likes, your lists, and counters that limit how many pairs you can draw.
- Your **lists** can be shared by link; a list marked public can be opened by anyone who has the link.
- I don't store your GitHub email or display name in the database.
- The account creation date is used only to tell whether a vote counts when a minimum account age is set.

**Votes are kept** for as long as the site runs, because the leaderboard is recomputed from the full vote log.
When the comparison log is published (when the open ranking method launches), it will show which kind of voter cast each vote (a person or the AI), never who.

## If your portfolio is listed

PortfolioRank lists portfolios from the public community list [emmabostian/developer-portfolios](https://github.com/emmabostian/developer-portfolios), plus sites people submit.
For each listed site I store:

- the name and address from the list;
- screenshots of the public page;
- up to 4,000 characters of the page's visible text;
- facts a script measures (links to a resume, GitHub or contact, whether project links load, own domain, footer year, whether it matches a known template);
- speed and accessibility scores from Google PageSpeed Insights;
- an AI grade from Google's Gemini (see below), and the site's rating and votes.

If your site leaves the list, its screenshots and stored page data are deleted 30 days later.
Its past votes stay in the vote log but are no longer shown.
To be removed, or to stay listed but never be named in posts, see [removal.md](removal.md).

## If you grade your portfolio (when "grade my portfolio" launches)

- I store the address you submit, its screenshots, page text, measured facts and the report.
- The report is private by default and shareable by link; you can delete it. [owner: confirm reports are unlisted and deletable]
- To stop abuse, I count requests per account and per network; network addresses are stored only as a one-way hash, kept for [owner: e.g. 2 days].
- If the day's capacity is used up and you ask for an email, I store your email address only to send that report, and delete it [owner: e.g. 7 days] after it's sent.
- A graded site is never added to the leaderboard unless you ask.

## If you subscribe to the newsletter (when it launches)

- I store your email address, when you signed up and when you confirmed.
- You only get emails after you click the confirmation link.
- Every email has a one-click unsubscribe.
  After you unsubscribe, I keep only a record that the address unsubscribed, so it's never emailed again. [owner: confirm, or delete entirely]
- Terms: [newsletter.md](newsletter.md).

## Google Gemini and the free tier

Public by design.
PortfolioRank only works with portfolios their owners published for the public to see.
Before any page text reaches the AI, we remove email addresses and phone numbers.
Names, public photos and the portfolio's own content stay, because that's what a portfolio is for.
Nothing is blocked by region.

PortfolioRank uses Google's Gemini API to grade portfolios and, later, to write blog posts from the site's data.
What goes to Gemini: screenshots and page text of portfolio sites (with email addresses and phone numbers swapped for placeholders), the measured facts, and aggregate numbers from the site.
What never goes to Gemini: anything about voters, accounts or newsletter subscribers.

PortfolioRank currently uses Gemini's **free tier**, for everyone, everywhere.
Under Google's terms for unpaid services, Google may use what is sent to improve its products, and human reviewers may read it.
So don't put private details into anything you send for grading.
Because only public web pages and aggregate data are sent, I'm comfortable with that, but you should know.
When "grade my portfolio" launches, you'll be able to use your own Gemini API key instead of mine.
If PortfolioRank moves to a paid Gemini plan, this section will be updated.

## Who else handles data

| Service | What for |
| --- | --- |
| Cloudflare | Hosting, screenshot storage (R2), page-view counts, and (later) screenshots and email [owner: confirm] |
| Turso | The database (votes, likes, lists, grades) |
| GitHub | Sign-in, and the scheduled jobs that update the site |
| Google | Gemini (grades, writing) and PageSpeed Insights (speed scores) |
| Sentry | Error reports |
| Cloudflare Email Service | Sending the newsletter and queued reports |

None of them get your data to sell, and neither do I.

## How long things are kept

| Data | Kept |
| --- | --- |
| Votes | As long as the site runs (the leaderboard is computed from them) |
| Likes and lists | Until you delete them, or ask me to delete your account's data |
| Listed site data | While listed, then deleted 30 days after it leaves the list |
| Nightly database backups | [owner: retention period, e.g. 30 days] |
| Grade requests and reports | [owner: e.g. 12 months, or until you delete the report] |
| Newsletter address | Until you unsubscribe |

## Your choices

- Ask for a copy of what's stored about you, or for it to be deleted: email [owner: contact email] from the address or GitHub account it's about.
  I'll answer within [owner: e.g. 30 days].
- Deleting your account's data removes your likes and lists; your votes are removed from the log and the leaderboard recomputed. [owner: confirm votes are deleted on request rather than anonymised]
- Block cookies in your browser; you can still browse, but not vote or sign in.

PortfolioRank is not meant for children under [owner: 13 or 16].

## Changes

When this page changes, the date at the top changes too.
Big changes get a note on the site [owner: and in the newsletter].

Governing law: [owner: jurisdiction].
