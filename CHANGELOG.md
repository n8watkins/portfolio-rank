# Changelog

## 0.5.0 - 2026-11-18

### New

- Screenshots on /shots links load again.
- Lighthouse scores and page checks on portfolio pages load instantly once measured, and show the date they were measured.
- Share image for link previews ([#41](https://github.com/n8watkins/portfolio-rank/pull/41))
- Undo a deleted list, a removed portfolio or an unlike instead of confirming first ([#42](https://github.com/n8watkins/portfolio-rank/pull/42))
- PortfolioRank's own cleanup: roster-aware jobs, weekly health check, /removed ([#53](https://github.com/n8watkins/portfolio-rank/pull/53))
- 3.5 first with catch-up on 3.1, shared pacing, request log, re-grade history ([#54](https://github.com/n8watkins/portfolio-rank/pull/54))
- AI grades read your page text, and code checks your links and contact details ([#57](https://github.com/n8watkins/portfolio-rank/pull/57))
- Grades and AI votes from 3.5 only, no fallback to 3.1 ([#63](https://github.com/n8watkins/portfolio-rank/pull/63))
- Pacific quota day, cut-off answers fail, contact redaction, Turso reads, full backups ([#72](https://github.com/n8watkins/portfolio-rank/pull/72))
- Weekly polls back end: tables, read and vote API, nightly generation ([#76](https://github.com/n8watkins/portfolio-rank/pull/76))
- Weekly model watch reports Gemini model changes to the owner ([#74](https://github.com/n8watkins/portfolio-rank/pull/74))
- Staging site at staging.portfoliorank.n8builds.dev, deployed before production ([#78](https://github.com/n8watkins/portfolio-rank/pull/78))
- Grade my portfolio back end, switched off until the redesign ([#81](https://github.com/n8watkins/portfolio-rank/pull/81))
- Back end for games, badges, claims, live stats and report downloads, behind GAMES_V2 ([#80](https://github.com/n8watkins/portfolio-rank/pull/80))
- The redesign's shared shell on every page, with a light theme ([#84](https://github.com/n8watkins/portfolio-rank/pull/84))
- Shorter posts, real paragraphs, tie-aware facts, staged writer ([#90](https://github.com/n8watkins/portfolio-rank/pull/90))
- The redesigned home page and /me on real data ([#87](https://github.com/n8watkins/portfolio-rank/pull/87))
- Cap PortfolioRank's Tavily use at 200 credits a month and show usage in admin quota ([#91](https://github.com/n8watkins/portfolio-rank/pull/91))
- Staged writer is the default for the content engine ([#92](https://github.com/n8watkins/portfolio-rank/pull/92))
- Route Workers AI through the portfoliorank-ai gateway with a hard rate limit ([#95](https://github.com/n8watkins/portfolio-rank/pull/95))
- Blog images from an owner-approved library, at most 40 free AI images a day ([#94](https://github.com/n8watkins/portfolio-rank/pull/94))
- A settings menu, self-serve data download and account deletion ([#99](https://github.com/n8watkins/portfolio-rank/pull/99))
- Grade your portfolio, How grading works, and self-serve portfolio removal ([#96](https://github.com/n8watkins/portfolio-rank/pull/96))
- The redesigned leaderboard and Play, with Guess the percentile behind GAMES_V2 ([#89](https://github.com/n8watkins/portfolio-rank/pull/89))
- Answer GET /healthz with ok for uptime monitors
- Lock the staging site inside the Worker ([#105](https://github.com/n8watkins/portfolio-rank/pull/105))
- A polls page with this week's poll, what is coming and past results ([#107](https://github.com/n8watkins/portfolio-rank/pull/107))
- The blog: short posts from PortfolioRank's own data, each one read by a person before it goes out.
- Image library review with tabs, Make now feedback and 40 a day ([#117](https://github.com/n8watkins/portfolio-rank/pull/117))
- Write a draft now, rewrites, guidelines and a scorecard for blog drafts ([#118](https://github.com/n8watkins/portfolio-rank/pull/118))
- Automatic library images run once a day at 23:15 UTC ([#126](https://github.com/n8watkins/portfolio-rank/pull/126))
- PortfolioRank moves to portfoliorank.dev ([#163](https://github.com/n8watkins/portfolio-rank/pull/163))
- Privacy, terms and removal pages, linked from every page's footer ([#155](https://github.com/n8watkins/portfolio-rank/pull/155))
- An Alerts page with a Send test alert button ([#160](https://github.com/n8watkins/portfolio-rank/pull/160))
- Owner goals with a weekly check and a calendar invite when one is first reached ([#161](https://github.com/n8watkins/portfolio-rank/pull/161))
- /admin is an overview with a card for each admin page, one admin layout and a usage page ([#134](https://github.com/n8watkins/portfolio-rank/pull/134))
- A Limits page with every free allowance against its limit ([#151](https://github.com/n8watkins/portfolio-rank/pull/151))
- Blog posts tell search engines their author, last edit and place in the blog ([#180](https://github.com/n8watkins/portfolio-rank/pull/180))
- Grading budget goes to new sites, Lighthouse for every graded site, safer AI prompts ([#148](https://github.com/n8watkins/portfolio-rank/pull/148))
- Site alert emails say they come through Cloudflare Email Service, not Kit ([#177](https://github.com/n8watkins/portfolio-rank/pull/177))
- Code plans each blog post and Gemini writes it in one plain-text call ([#187](https://github.com/n8watkins/portfolio-rank/pull/187))
- Tiers by ELO kept incrementally, shown only while RANKING_V2 is on ([#189](https://github.com/n8watkins/portfolio-rank/pull/189))
- With RANKING_V2 on, reports, share images, /me and emails show the tier by ELO ([#190](https://github.com/n8watkins/portfolio-rank/pull/190))
- Add your portfolio and the free tools, behind TOOLS_ENABLED ([#191](https://github.com/n8watkins/portfolio-rank/pull/191))
- Profiles tell search engines who the person is, described from their grade ([#192](https://github.com/n8watkins/portfolio-rank/pull/192))
- The sitemap is an index of pages, blog and profile files, with real change dates ([#193](https://github.com/n8watkins/portfolio-rank/pull/193))
- Sign in with an emailed one-time link, beside GitHub ([#124](https://github.com/n8watkins/portfolio-rank/pull/124))
- Get new blog posts by email through Kit, off in production until launch ([#196](https://github.com/n8watkins/portfolio-rank/pull/196))
- Find new portfolios automatically, every run off by default ([#197](https://github.com/n8watkins/portfolio-rank/pull/197))
- Checks re-run only when a portfolio changed or got old, behind FRESHNESS_ENABLED ([#199](https://github.com/n8watkins/portfolio-rank/pull/199))
- Verify ownership by file or meta tag; check a site exists before adding ([#202](https://github.com/n8watkins/portfolio-rank/pull/202))
- Letters from day one, S earned, D reserved ([#210](https://github.com/n8watkins/portfolio-rank/pull/210))
- Splash screens that ask for a click are clicked through first ([#208](https://github.com/n8watkins/portfolio-rank/pull/208))
- Strong page signals keep a not-a-portfolio site listed ([#213](https://github.com/n8watkins/portfolio-rank/pull/213))
- A capped re-check of not-a-portfolio grades ([#214](https://github.com/n8watkins/portfolio-rank/pull/214))
- Close a dialog on top of the page before the screenshots ([#215](https://github.com/n8watkins/portfolio-rank/pull/215))
- A template is not a fault ([#217](https://github.com/n8watkins/portfolio-rank/pull/217))
- A template never counts in the checks score ([#219](https://github.com/n8watkins/portfolio-rank/pull/219))
- Review queue for proposed status changes, applied only on confirm ([#216](https://github.com/n8watkins/portfolio-rank/pull/216))
- Review passes apply themselves behind REVIEW_AUTO_APPLY, with Undo ([#220](https://github.com/n8watkins/portfolio-rank/pull/220))
- Review rows that both graders agree on are now confirmed automatically, with Undo on /admin/review.
- Keep the 543 re-check verdicts in excluded.json; dead sites rechecked ([#222](https://github.com/n8watkins/portfolio-rank/pull/222))
- Portfolios that stop loading are hidden within a day and come back on their own, with their grade and votes, when they work again.

### Fixed

- TS narrowing lost in closure — capture anonVotesUsed in a const
- Run the daily sync on Ubuntu 24.04 so new portfolios get captured again ([#5](https://github.com/n8watkins/portfolio-rank/pull/5))
- Upgrade next, next-auth and transitive deps to clear Dependabot alerts ([#6](https://github.com/n8watkins/portfolio-rank/pull/6))
- Use plain hyphens instead of em dashes in page titles and copy ([#9](https://github.com/n8watkins/portfolio-rank/pull/9))
- A clearer 404 and error page, page-visit counts, and error reports ([#39](https://github.com/n8watkins/portfolio-rank/pull/39))
- Gemini key in header, 3.5 Flash-Lite with 3.1 fallback ([#52](https://github.com/n8watkins/portfolio-rank/pull/52))
- Sign-in opens as a proper window, and keyboard voting waits for it ([#56](https://github.com/n8watkins/portfolio-rank/pull/56))
- Shareable browse filters, honest grading copy, diagnostics Retry, no sideways scroll ([#64](https://github.com/n8watkins/portfolio-rank/pull/64))
- Deploy-time schema migrations, HSTS, Sentry source maps, lint clean ([#66](https://github.com/n8watkins/portfolio-rank/pull/66))
- The blocked share image note is readable ([#67](https://github.com/n8watkins/portfolio-rank/pull/67))
- Cached leaderboard keeps its 5-minute max-age; email via Cloudflare Email Service ([#73](https://github.com/n8watkins/portfolio-rank/pull/73))
- Flux-1-schnell calls no longer send a seed ([#93](https://github.com/n8watkins/portfolio-rank/pull/93))
- Turnstile refuses on deployed Workers without a secret ([#104](https://github.com/n8watkins/portfolio-rank/pull/104))
- Account export and deletion include grades requested while signed in ([#111](https://github.com/n8watkins/portfolio-rank/pull/111))
- Sign everyone out once, restore undone removals weekly ([#114](https://github.com/n8watkins/portfolio-rank/pull/114))
- A grade that can't take screenshots shows its free checks instead of "couldn't grade" ([#119](https://github.com/n8watkins/portfolio-rank/pull/119))
- Each leaderboard view shows exactly one gold, one silver and one bronze ([#121](https://github.com/n8watkins/portfolio-rank/pull/121))
- The owner is emailed when a nightly run never starts or dies partway ([#153](https://github.com/n8watkins/portfolio-rank/pull/153))
- A Worker without its database URL says so instead of trying a local file ([#167](https://github.com/n8watkins/portfolio-rank/pull/167))
- The sitemap lists only graded portfolio profiles ([#169](https://github.com/n8watkins/portfolio-rank/pull/169))
- The owner is emailed before the GitHub dispatch token expires ([#170](https://github.com/n8watkins/portfolio-rank/pull/170))
- The checks and social links no longer move the page as they load ([#174](https://github.com/n8watkins/portfolio-rank/pull/174))
- Every table is in the schema, so staging and restores have them all ([#165](https://github.com/n8watkins/portfolio-rank/pull/165))
- One failing hourly task no longer skips the rest of the hour ([#166](https://github.com/n8watkins/portfolio-rank/pull/166))
- When Cloudflare asks you to tick its box, the grade waits for the tick ([#138](https://github.com/n8watkins/portfolio-rank/pull/138))
- Leaderboard rows show each site's icon, not a placeholder ([#200](https://github.com/n8watkins/portfolio-rank/pull/200))
- A full-screen app container is not an overlay; gate overlays are clicked ([#218](https://github.com/n8watkins/portfolio-rank/pull/218))
- Blocked pre-checks go to the browser, slow pages get time, screenshots retry ([#225](https://github.com/n8watkins/portfolio-rank/pull/225))
- Failed captures retry the next night, not two nights later ([#227](https://github.com/n8watkins/portfolio-rank/pull/227))

### Safer

- Rankings only count votes on the pairs PortfolioRank shows you, so nobody can vote their own site to the top.
- Practice votes can't be fished for, and claims can't overspend ([#58](https://github.com/n8watkins/portfolio-rank/pull/58))
- Claiming a portfolio now needs proof on the site itself (a link to your GitHub profile or the verification tag), so nobody else can claim or remove your portfolio.
- 30-day GitHub account age for votes and owner actions; admin by id; origin checks ([#109](https://github.com/n8watkins/portfolio-rank/pull/109))
- Removing a portfolio needs the meta tag, waits a day and can be undone ([#113](https://github.com/n8watkins/portfolio-rank/pull/113))
- Hiding a grade needs owner-only proof; a github.io site belongs to its account ([#128](https://github.com/n8watkins/portfolio-rank/pull/128))
- "use the free tier" only queues the grade, never calling Gemini on our key ([#159](https://github.com/n8watkins/portfolio-rank/pull/159))
- Test stand-ins work only in test runs and next dev ([#168](https://github.com/n8watkins/portfolio-rank/pull/168))
- The CSP refuses inline event handlers and plugins ([#173](https://github.com/n8watkins/portfolio-rank/pull/173))
- Sign out everywhere, and the admin's session lasts 12 hours ([#175](https://github.com/n8watkins/portfolio-rank/pull/175))
- Only someone who can deploy to a site can cancel its removal from PortfolioRank.

### Faster

- Screenshots load from our own domain with long caching, the main image first ([#61](https://github.com/n8watkins/portfolio-rank/pull/61))
- Public pages load from the edge cache, scanner probes get a plain 404 ([#101](https://github.com/n8watkins/portfolio-rank/pull/101))
- Profiles, the blog and share images stay cached at the edge for days ([#157](https://github.com/n8watkins/portfolio-rank/pull/157))
- Answer a signed-out session read before Next starts ([#156](https://github.com/n8watkins/portfolio-rank/pull/156))
- The edge cache keys profiles by site, ready for readable profile addresses ([#181](https://github.com/n8watkins/portfolio-rank/pull/181))
- Stay inside Turso and R2 free tiers to 50,000 portfolios ([#150](https://github.com/n8watkins/portfolio-rank/pull/150))
- Client navigation in the header and tab bar, one session read ([#135](https://github.com/n8watkins/portfolio-rank/pull/135))
- 404 file-like paths that are not routes before Next ([#228](https://github.com/n8watkins/portfolio-rank/pull/228))

