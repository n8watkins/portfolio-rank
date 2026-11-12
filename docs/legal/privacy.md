# Privacy

> **DRAFT, not legal advice.** Not linked from the site yet. See [README.md](README.md).

Last updated: [owner: date it goes live].

PortfolioRank is a side project run by me, [owner: legal name, or business name if there is one].
This page says what the site stores about you, why, who else sees it, and how long it's kept.
Short version: I store as little as I can, I never sell anything, and you can ask me to delete what's yours.

Downloading your data, deleting your account and removing your portfolio are self-serve on the Settings page (see "Your choices").
Questions: nate@n8builds.dev.

## If you just browse

- **No account, no tracking cookies.**
- **Page-view counts** come from Cloudflare Web Analytics, which counts visits without cookies and without building a profile of you.
- **Error reports** go to Sentry when a page breaks.
  They carry the error and the page's path, nothing else: no account, no cookies, no request headers, no query string.
- **Hosting logs.** The site runs on Cloudflare, which sees your IP address and browser details to serve the page, as any host does.
  I don't store your IP address in PortfolioRank's database.
  Where the site limits how often a network can do something (poll votes, and later grade requests), it stores only a one-way hash of the address, never the address itself, and deletes it within 30 days.

## Cookies and browser storage

There is no cookie banner because nothing here tracks you: every cookie is needed for something you asked for.
The same list is on the site's Settings page, which can also forget your saved preferences.

Cookies:

- **Sign-in session**: keeps you signed in, only after you sign in with GitHub, plus two short-lived helpers used during sign-in.
- **Browser id**: a random, signed id so a vote, poll answer or quiz counts once, set the first time you vote, play or grade.
- **Your reports**: which grade reports this browser asked for, so only you see a report's owner tools.
- **Print pass**: a one-hour pass to print a portfolio's report.
- **Face-off intro seen**: so the how-to-play card doesn't show again.

Saved only in your browser (local storage), never sent to the site: your theme (only if you pick Light or Dark), the auto-open setting, whether the face-off shows scores, and which reports already celebrated.
A few notes last only while the tab is open, such as whether the sign-in reminder was shown, and, if you grade with your own Gemini key, that key until the grade is done.

The bot check on some forms (Cloudflare Turnstile) sets no cookies on this site.

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

**Votes and ratings are kept** for as long as the site runs, because the leaderboard is recomputed from the full vote log.
That goes for practice votes made without signing in too: they're tied only to the random id in your cookie.
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
To remove it yourself, use "Remove my portfolio" on the Settings page (see "Your choices").
To stay listed but never be named in posts, see [removal.md](removal.md).

## If you vote in a poll

- Each vote is stored with your account id (or the random id from your practice-vote cookie) and a signed browser id, so each person votes once.
- No API ever shows who voted for what; results are totals.
- Individual poll votes are deleted 30 days after the poll closes; the totals stay.

## If you play the games (when they launch)

- Your quiz answers are stored with your account id, or the random id from your practice-vote cookie, with the time and the percentiles they were scored against.
- Badges you earn are stored the same way, with what they need: how many times you shared a result, and which portfolios you opened (at most 50).
- "Your eye" (how often you agree with the crowd and the AI) is worked out from your own votes and answers; nobody else sees it.
- If you sign in afterwards, your quizzes and badges move to your account.
- Challenge links share the five portfolios of a quiz, never your answers.

## If you claim your portfolio (when claims launch)

- Claiming needs a GitHub sign-in.
  I store your GitHub id number and username with the portfolio's address, how the claim was verified, and a note if you write one.
- To verify, the site fetches your portfolio's public home page (to find a link to your GitHub profile or the verification code) and your public GitHub profile (for your current username).
- Every claim, review and owner action (removing the site, hiding its grade, asking for a re-grade) goes into an audit log with your GitHub id number and the time, so a removal can always be traced to whoever asked for it.
- If you remove your portfolio, it disappears from the site 24 hours later (you can cancel until then, and I'm told about it, so a removal by someone who isn't the owner can be stopped) and its address goes on the public removals list in the site's repository, marked "owner request", without your name; the removed-portfolios page only counts these.
- If you ask for a report link by email, your address is used to send that one email and is not stored; only a one-way hash of it counts how many emails it got that day (at most 3).

## If you grade your portfolio (when "grade my portfolio" launches)

- I store the address you submit, its screenshots, page text, measured facts and the report.
- The report is private by default and shareable by link; you can delete it. [owner: confirm reports are unlisted and deletable]
- To stop abuse, I count requests per account and per network; network addresses are stored only as a one-way hash, kept for at most 30 days.
- If the day's capacity is used up and you ask for an email, I store your email address only to send that report, and delete it 30 days after it's sent, along with the grade request.
- A graded site is never added to the leaderboard unless you ask.

## If you subscribe to the newsletter (when it launches)

- I store your email address, when you signed up and when you confirmed.
- You only get emails after you click the confirmation link.
- Every email has a one-click unsubscribe.
  An address that isn't confirmed within 7 days is deleted.
- After you unsubscribe, I keep the address only on a do-not-email list, so it's never emailed again.
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
| Cloudflare | Hosting, screenshot storage (R2) and page-view counts |
| Turso | The database (votes, likes, lists, grades) |
| GitHub | Sign-in, and the scheduled jobs that update the site |
| Google | Gemini (grades, writing) and PageSpeed Insights (speed scores) |
| Sentry | Error reports |
| Cloudflare Email Service | Sending the newsletter and queued reports |

None of them get your data to sell, and neither do I.

## How long things are kept

| Data | Kept |
| --- | --- |
| Votes and ratings, including practice votes | As long as the site runs (the leaderboard is computed from them) |
| Individual poll votes | 30 days after the poll closes; the totals stay |
| Likes and lists | Until you delete them, or ask me to delete your account's data |
| Quiz answers and badges | Until you ask me to delete your account's data [owner: confirm, or set a limit] |
| Claims and the claims audit log | As long as the site runs [owner: confirm] |
| One-time report links (a hash, never the email address) | Until they expire (a day), deleted that night |
| Listed site data | While listed, then deleted 30 days after it leaves the list |
| Hashed network addresses (rate limits) | At most 30 days |
| Gemini request log (which job asked, when, tokens used; no visitor data) | 90 days, then only daily totals |
| Nightly database backups | 30 days |
| Grade requests, and the email address for a queued report | 30 days after the report is sent |
| Grade reports | [owner: how long a report stays, or until you delete it] |
| Newsletter sign-up that's never confirmed | 7 days |
| Newsletter address | Until you unsubscribe; after that, only on the do-not-email list |

## Your choices

All of these are self-serve, on the site's Settings page, and take effect at once.

- **Download my data**: signed in, one click gives you a JSON file of everything stored against your account: votes, likes, lists, badges, quiz plays, poll votes, claims and the portfolio actions you took.
- **Delete my account**: signed in, type your GitHub username to confirm.
  Your votes, likes, lists, badges, quiz plays, poll votes and claims are deleted together in one step, and you are signed out (your session lives only in your browser's cookie, so signing out ends it).
  Your votes leave the vote log, and the leaderboard drops them at its next recompute.
  Kept, because they name no one: anonymous counts (how many quizzes were played, how many votes each poll option got) and a portfolio's own state, so a removal or a hidden grade you made stays in force, with your account struck from the record of who made it.
- **Remove my portfolio**: prove the site is yours (a link from the site to your GitHub profile, or a code you put on the page), then hide its grade; removing it from PortfolioRank asks for the code (or a review) and takes effect a day later.
- **Forget my preferences**: clears what's saved in your browser.
- Block cookies in your browser; you can still browse, but not vote or sign in.

PortfolioRank is not meant for anyone under 16.

## Changes

When this page changes, the date at the top changes too.
Big changes get a note on the site [owner: and in the newsletter].

Governing law: California, United States.
