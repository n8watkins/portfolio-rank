# Privacy

> Live at `/privacy` (`app/privacy/page.tsx`); keep the two in step. Not legal advice. See [README.md](README.md).

Last updated: November 12, 2026.

PortfolioRank is a side project run by n8builds.
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
  Where the site limits how often a network can do something, it stores only a one-way hash of the address, never the address itself, and deletes those counters within a day.

## Cookies and browser storage

There is no cookie banner because nothing here tracks you: every cookie is needed for something you asked for.
The same list is on the site's Settings page, which can also forget your saved preferences.

Cookies:

- **Sign-in session**: keeps you signed in, only after you sign in with GitHub, plus two short-lived helpers used during sign-in.
- **Browser id**: a random, signed id so a vote, poll answer or quiz counts once, set the first time you vote, play or grade.
- **Your reports**: which grade reports this browser asked for, so only you see a report's owner tools.
- **Print pass**: a one-hour pass to print a portfolio's report.
- **Face-off intro seen**: so the how-to-play card doesn't show again.

Saved only in your browser, never sent to the site: your theme (only if you pick Light or Dark), the auto-open setting, whether the face-off shows scores, and which reports already celebrated.
A few notes last only while the tab is open, such as whether the sign-in reminder was shown, and, if you grade with your own Gemini key, that key until the grade is done.

The bot check on some forms (Cloudflare Turnstile) sets no cookies on this site.

## If you vote without signing in

You get a few practice votes before signing in.
The site sets one cookie holding a random id, signed so it can't be forged.
Your practice votes and the pairs you were shown are stored against that id, with the time.
If you sign in afterwards, those votes can move to your account.

## If you sign in with GitHub

GitHub tells PortfolioRank your GitHub id number, username, display name, email, avatar and the date your GitHub account was created.

- Your **session** lives in a signed, encrypted cookie in your browser, not in my database.
- What I **store** is keyed by your GitHub id number: your votes, your likes, your lists, and counters that limit how many pairs you can draw.
- Your **lists** can be shared by link; a list marked public can be opened by anyone who has the link.
- I don't store your GitHub email or display name in the database.
- The account creation date is used only to tell whether a vote counts when a minimum account age is set.

**Votes are kept** for as long as the site runs, because the leaderboard is computed from the full vote log.
That goes for practice votes too: they're tied only to the random id in your cookie.
If the comparison log is ever published, it will show which kind of voter cast each vote (a person or the AI), never who.

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
To take it off yourself, see "Your choices"; to stay listed but never be named in posts, see [removal.md](removal.md).

## If you claim your portfolio

- Claiming needs a GitHub sign-in.
  I store your GitHub id number and username with the portfolio's address, how the claim was verified, and a note if you write one.
- To verify, the site fetches your portfolio's public home page (to find a link to your GitHub profile or the verification code) and your public GitHub profile (for your current username).
- Every claim and owner action (removing the site, hiding its grade, asking for a re-grade) goes into an audit log with your GitHub id number and the time, so a removal can always be traced to whoever asked for it.
- If you remove your portfolio, it disappears from the site 24 hours later (you can cancel until then, and I'm told about it, so a removal by someone who isn't the owner can be stopped).
  Its address then goes on the public removals list in the site's repository, marked "owner request", without your name; the removed-portfolios page only counts these.
- If you ask for a report link by email, your address is used to send that one email and is not stored; only a one-way hash of it counts how many emails it got that day.

## If you vote in a poll

- Each vote is stored with your account id (or the random id from your practice-vote cookie) and a signed browser id, so each person votes once.
- No page or API ever shows who voted for what; results are totals.
- Individual poll votes are deleted 30 days after the poll closes; the totals stay.

## If you play the games

- Your quiz answers are stored with your account id, or the random id from your practice-vote cookie, with the time and the percentiles they were scored against.
- Badges you earn are stored the same way, with what they need: how many times you shared a result, and which portfolios you opened (at most 50).
- "Your eye" (how often you agree with the crowd and the AI) is worked out from your own votes and answers; nobody else sees it.
- If you sign in afterwards, your quizzes and badges move to your account.
  Challenge links share the five portfolios of a quiz, never your answers.

## If you check or grade a site

Checking and grading a site are opening soon; this is how they work.

**Checking a site adds it to PortfolioRank; you can ask for removal at any time.**
A site that is already listed gets its results refreshed.
Any other site waits, privately, to be graded: it's shown on PortfolioRank only once it's graded, and never if it turns out not to be a portfolio.

- I store the address you submit, its screenshots, page text, measured facts and the report.
- To stop abuse, I count requests per browser and per network.
  Both are stored only as one-way hashes, with the request.
- If you ask for the report by email, your address is used only to send it: it's erased as soon as the email goes out, or after 30 days if it never does.
  Report links in those emails stop working after 7 days.
- A grade request, its hashes, its report and its screenshots are deleted 180 days after the request.

## If you check a site with the free tools (when the tools launch)

The free tools (speed check, share preview checker, portfolio checklist) work without an account.

- I store the address you check and what the tools measured: Lighthouse scores and timings, the page's title, description and share image address, and the checklist results (resume, GitHub and contact links found, project links that load, own domain, HTTPS, footer year, template).
  The same results are reused for a day, so checking again costs nothing.
- Every site the tools can load is added to PortfolioRank.
  A site that's already listed gets its saved results refreshed on its page.
  Any other site waits, privately, to be graded; it's shown on PortfolioRank only once it's graded, and never if it turns out not to be a portfolio.
- To stop abuse, I count checks per browser and per network; network addresses are stored only as a one-way hash, kept for at most 30 days.
- The tools use Google PageSpeed Insights, which loads the page you checked; nothing about you is sent to Google.
- To take a site off PortfolioRank: if it's listed, use "Remove my portfolio" (see "Your choices"); if it's still waiting to be graded, email me at nate@n8builds.dev from any address and I'll remove it within 14 days.
  [owner: confirm this flow, and whether a waiting site gets a self-serve removal too]

## If your site was found on a public list (when discovery launches)

PortfolioRank also looks for portfolios on public pages: GitHub repositories tagged as a portfolio, Hacker News posts where people share their own site, and community lists people add themselves to (personalsit.es, uses.tech).

- I store the site's address and where it was found, then load its home page once (respecting robots.txt) to check it is a live, English, personal portfolio.
- A site that isn't one keeps only a one-way hash of its address, the reason and the date, so it is never checked again; a site that couldn't load keeps its address until it is checked again, at most three times.
- A site that passes waits, privately, to be graded; it's shown on PortfolioRank only once it's graded, and never if it turns out not to be a portfolio.
- To keep your site out, email me at nate@n8builds.dev or use "Remove my portfolio"; it goes on the takedown list and discovery never adds it again.
  [owner: confirm before discovery is switched on]

## If you subscribe to the newsletter (when it launches)

- Kit (kit.com), the newsletter service, stores your email address, when you signed up and when you confirmed.
  PortfolioRank itself keeps no copy.
- You only get emails after you click the confirmation link in Kit's email.
- Every email has a one-click unsubscribe.
- After you unsubscribe, Kit keeps the address only as unsubscribed, so it's never emailed again.
- Kit counts opens and clicks of the newsletter emails.
- Terms: [newsletter.md](newsletter.md).

## Google Gemini and the free tier

PortfolioRank only works with portfolios their owners published for the public to see.
It uses Google's Gemini API to grade them and to help write blog posts from the site's data.

- What goes to Gemini: screenshots and page text of portfolio sites, with email addresses and phone numbers swapped for placeholders first, the measured facts, and aggregate numbers from the site.
- What never goes to Gemini: anything about voters, accounts or the people who check a site.

PortfolioRank uses Gemini's **free tier**.
Under Google's terms for unpaid services, Google may use what is sent to improve its products, and human reviewers may read it.
Only public web pages and aggregate data are sent, so I'm comfortable with that, but you should know.
If you grade with your own Gemini key, the request goes to Google under your key's terms instead.

## Who else handles data

| Service | What for |
| --- | --- |
| Cloudflare | Hosting, the bot check, screenshot and backup storage (R2), page-view counts and sending email |
| Turso | The database (votes, likes, lists, grades) |
| GitHub | Sign-in, and the scheduled jobs that update the site |
| Google | Gemini (grades, writing) and PageSpeed Insights (speed scores) |
| Sentry | Error reports |
| Cloudflare Email Service | Sending queued reports and sign-in links |
| Kit (kit.com) | Keeping the newsletter list and sending the newsletter |

None of them get your data to sell, and neither do I.

## How long things are kept

| Data | Kept |
| --- | --- |
| Votes, including practice votes | As long as the site runs (the leaderboard is computed from them), or until you delete your account |
| Individual poll votes | 30 days after the poll closes; the totals stay |
| Likes and lists | Until you delete them, or your account |
| Quiz answers and badges | Until you delete your account |
| Claims and the claims audit log | As long as the site runs; deleting your account removes your name from it |
| Listed site data | While listed, then deleted 30 days after it leaves the list |
| Hashed network counters (rate limits) | At most a day |
| Grade requests, reports and their screenshots | 180 days after the request |
| An email address for a report | Until the email is sent, or 30 days if it never is |
| Gemini request log (which job asked, when, tokens used; no visitor data) | 90 days, then only daily totals |
| Nightly database backups | 35 days |
| Free tool results for a site | Until the site is checked again (each check replaces the last) [owner: confirm, or set a limit] |
| A site waiting to be graded (from the free tools) | Its address until it's graded or turned down; a site turned down for good keeps only a one-way hash, the reason and the date |
| Newsletter sign-up that's never confirmed | Kept by Kit as unconfirmed; never emailed again |
| Newsletter address | At Kit, until you unsubscribe; after that, only on Kit's do-not-email list |

The nightly backup is a copy of the database in private storage.
Anything deleted from the database can stay in a backup until that backup expires, so every deletion on this page is complete within 35 days.
(The bucket's lifecycle rule `expire-backups-35d` enforces this; see docs/ASSUMPTIONS.md section G.)

## Your choices

These are self-serve on the Settings page and take effect at once.

- **Download my data**: signed in, one click gives you a JSON file of everything stored against your account: votes, likes, lists, badges, quiz plays, poll votes, claims, the portfolio actions you took and the grades you asked for while signed in.
- **Delete my account**: signed in, type your GitHub username to confirm.
  Your votes, likes, lists, badges, quiz plays, poll votes, claims and the grades you asked for while signed in are deleted together in one step, and you are signed out.
  The leaderboard drops your votes at its next recompute.
  Kept, because they name no one: anonymous counts, and a portfolio's own state, so a removal or a hidden grade you made stays in force with your account struck from the record of who made it.
- **Remove my portfolio**: on the claim page, prove the site is yours with a code you put on the page (or a claim I've reviewed), then hide its grade or remove it.
  A removal takes effect a day later and can be cancelled until then.
  For a site that isn't listed yet, including one still waiting to be graded, email me (see [removal.md](removal.md)).
- **Forget my preferences**: clears what's saved in your browser.
- Block cookies in your browser: you can still browse, but not vote or sign in.

Anything else, including a request about data that isn't tied to an account: email nate@n8builds.dev.
I answer data requests within 30 days.

PortfolioRank is not meant for anyone under 16.

## Changes

When this page changes, the date at the top changes too, and big changes get a note on the site.
Governing law: California, United States.

## Not on the page yet

Add these sections when the features launch in production:

- **Newsletter** (`NEWSLETTER_ENABLED`): what's stored (address, signed-up and confirmed times), confirmation, one-click unsubscribe, unconfirmed addresses deleted after 7 days, the do-not-email list after unsubscribing; terms in [newsletter.md](newsletter.md).
- **Email sign-in**: what the one-time link stores and for how long.
