# Re-check of non-ranked sites (recheck-543)

PortfolioRank experiment, 2026-11-14.
Branch `exp/recheck-543`; prompt portfolio-definition-v2.1.
Nothing here changed a grade, listing or rank.

## TL;DR

> All 543 sites that are not ranked were captured fresh, and the 385 that could be graded went to Gemini 3.1 Flash-Lite and Claude Haiku 5.5 with the owner's definition (prompt portfolio-definition-v2.1).
> Both say portfolio for 316 sites and both say not a portfolio for 62; they disagree on 7.
> 287 sites would come back (both agree, pre-ticked), 0 listed sites would leave, 7 disagreements were flagged (the owner decided 7 of them on 13 November: 1 relist, 6 not portfolios), and 61 need a person (a blocked capture or the same text on another domain).
> 75 sites failed to load and 56 captures stayed blocked, so they were never graded; most failed loads are names that no longer resolve.
> 146 of the agreed relists are sites that left the community list (delisted on 2026-11-10); bringing those back is a policy decision for the owner, separate from the grades.
> Gemini said no on grounds v2.1 does not allow (a blog, a missing role) for 13 sites; Haiku for 0.
> Cost: Gemini 202 HTTP requests on the free tier (pilot, full run and extra batch), Haiku $1.05. Nothing has changed on the site: every change waits on the owner on /admin/review.

## Headline numbers

| Number | Value |
| --- | ---: |
| Sites re-checked | 543 |
| Graded by both models | 385 |
| Both: portfolio | 316 |
| Both: not a portfolio | 62 |
| Models disagree | 7 |
| Would relist (agreed) | 287 |
| Would remove (agreed) | 0 |
| Needs a person | 61 |
| Capture blocked | 56 |
| Capture failed | 75 |

## Verdicts by group

| Group | Sites | Would relist | Would remove | No change | Flagged | Needs a person | Capture failed | Waiting |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Graded not a portfolio | 132 | 71 | 0 | 30 | 6 | 17 | 7 | 1 |
| Delisted after grading | 115 | 43 | 0 | 22 | 0 | 6 | 44 | 0 |
| Delisted before grading | 157 | 101 | 0 | 20 | 0 | 13 | 21 | 2 |
| Broken or dead, never graded | 103 | 72 | 0 | 4 | 1 | 20 | 1 | 5 |
| Live, never graded | 36 | 0 | 0 | 29 | 0 | 5 | 2 | 0 |
| All | 543 | 287 | 0 | 105 | 7 | 61 | 75 | 8 |

"Would relist" and "Would remove" are sites both models agree on; they are pre-ticked on the Review page.
"Flagged" sites are on the Review page unticked, with both verdicts side by side.
"No change" means the verdict matches how the site is shown today.
Delisted sites left the community list in the 2026-11-10 cleanup (#53); their rows say "no longer on the community list".

**What this means**

- The owner's queue is the relist, remove, flagged and needs-a-person rows; nothing else needs a decision.

## A decision for the owner: 146 delisted sites

| Agreed relists | Sites |
| --- | --- |
| Delisted after grading (off the community list) | 43 |
| Delisted before grading (off the community list) | 101 |
| Graded "not a portfolio" before | 71 |
| Marked broken before, never graded | 72 |

146 of the 287 agreed relists are delisted sites: they left the community list and were delisted in the 2026-11-10 cleanup (#53), not because anything was wrong with them.
Both models call them portfolios, so a pass rule (PR #220, REVIEW_AUTO_APPLY) would relist them all once it is on; each row says "no longer on the community list".
Whether sites that left the community list should come back is a policy choice, not a grading result; the other relists (sites graded "not a portfolio" before, or marked broken) are corrections.

**What this means**

- Decide the delisted ones as a group before turning auto-apply on; the corrections can go through as they are.

## (a) Where Gemini 3.1 and Haiku agree

| Batched answers | Haiku: portfolio | Haiku: not |
| --- | --- | --- |
| Gemini 3.1: portfolio | 316 | 3 |
| Gemini 3.1: not | 13 | 74 |

Batched (5 sites a request): 390 of 406 agree (96%).
One at a time, on the 100 sites both graded alone: 92 agree (92%).
visual design: the same score on 150 of 406 (37%), within one point on 90%, mean difference 0.75.
project presentation: the same score on 222 of 406 (55%), within one point on 95%, mean difference 0.51.
writing: the same score on 127 of 406 (31%), within one point on 85%, mean difference 0.85.

**What this means**

- Agreement is on the raw answers, before the strong-signals guard; the queue applies the guard to each model before comparing.

## (b) Where they disagree (7)

Each site with both answers and its screenshots.
The owner decided all seven on 13 November: one relist (a weak portfolio) and six not portfolios; those verdicts hold over later grades. The five personal blogs among them went Gemini's way, against Haiku: a possible v2.2 wording is noted in the prompt log.

- [andy-bell.design](https://andy-bell.design) (Graded not a portfolio, signals 3)
  - Gemini 3.1: portfolio (5/5/5), "This is a professional site showcasing the work and educational offerings of a developer."
  - Haiku 5.5: not a portfolio (4/3/4), "This is a publisher's education site (Piccalilli, from set.studio) with courses and articles by several authors, not a personal portfolio of one person."
  - Owner (13 Nov): not a portfolio, not a portfolio (owner, 13 Nov)
- [armujahid.me](https://armujahid.me) (Graded not a portfolio, signals 3)
  - Gemini 3.1: not a portfolio (4/1/5), "This is a blog, not a portfolio; it lacks a clear professional role and a way to view projects."
  - Haiku 5.5: portfolio (4/1/4), "This is a personal blog by Abdul Rauf, so it identifies a person through his name and writing. It shows no developer role and no project links, but a missing sign is not grounds for false."
  - Owner (13 Nov): not a portfolio, not a portfolio (owner, 13 Nov)
- [damianmarkowski.com](https://damianmarkowski.com) (Graded not a portfolio, signals 2)
  - Gemini 3.1: portfolio (4/1/2), "It identifies the person and their role, but lacks a portfolio of work."
  - Haiku 5.5: not a portfolio (3/1/2), "This reads as a link-in-bio card of social profiles and an email button, with no work shown, so it is not a portfolio."
  - Owner (13 Nov): not a portfolio, not a portfolio (owner, 13 Nov)
- [maggioni.dev](https://maggioni.dev) (Graded not a portfolio, signals 3)
  - Gemini 3.1: not a portfolio (3/1/2), "This is a personal blog, not a portfolio. It lacks a clear professional role and a way to view work."
  - Haiku 5.5: portfolio (3/2/3), "This is a personal blog by a named author with post list; no role stated and no work or project links, so it reads as a blog rather than a developer portfolio."
  - Owner (13 Nov): not a portfolio, not a portfolio (owner, 13 Nov)
- [matvey.codes](https://matvey.codes) (Broken or dead, never graded, signals 1)
  - Gemini 3.1: not a portfolio (3/1/1), "It lacks a personal identity, a role, and a way to view work."
  - Haiku 5.5: portfolio (4/1/1), "The domain and page show a personal identity, matvey.codes, but no role or work link is visible; the page is about hobbies, so it is a weak but real personal page."
  - Owner (13 Nov): not a portfolio, not a portfolio (owner, 13 Nov)
- [www.techinz.dev](https://www.techinz.dev) (Graded not a portfolio, signals 3)
  - Gemini 3.1: not a portfolio (3/1/1), "This is a single project page, not a portfolio of work."
  - Haiku 5.5: portfolio (4/1/1), "The page title reads 'Galaxy portfolio | Full Stack Developer' and it links to a GitHub repository, so it is presented as a developer's portfolio. The visible screen shows no name or role, which weakens the five-second test but is not an exclusion."
  - Owner (13 Nov): a portfolio, a portfolio, a weak one (owner, 13 Nov)
- [www.tiagocreator.com](https://www.tiagocreator.com) (Graded not a portfolio, signals 1)
  - Gemini 3.1: not a portfolio (3/1/2), "This is a personal blog, not a professional portfolio; it lacks projects and a clear professional role."
  - Haiku 5.5: portfolio (3/1/2), "Personal identity (Tiago Creator) and a contact link exist, but no role or projects are shown; it reads as a personal blog, so it is a weak portfolio rather than a non-person page."
  - Owner (13 Nov): not a portfolio, not a portfolio (owner, 13 Nov)

**What this means**

- A disagreement is where a person adds the most: one model is wrong on each of these.

## Haiku pending (8)

These sites failed on the GitHub capture but loaded when retried from the owner's machine, so they went to the graders in a small extra batch.
Gemini 3.1 has answered where shown; Haiku runs when the owner runs the Haiku command again, and the report is regenerated then.

- [akshaysanthoshkumar.vercel.app](https://akshaysanthoshkumar.vercel.app) (Broken or dead, never graded): Gemini 3.1 portfolio; Haiku pending
- [az-dev.vercel.app](https://az-dev.vercel.app) (Delisted before grading): Gemini 3.1 portfolio; Haiku pending
- [dub.sh/ankitdey](https://dub.sh/ankitdey) (Broken or dead, never graded): Gemini 3.1 portfolio; Haiku pending
- [hyperautomation.substack.com](https://hyperautomation.substack.com) (Graded not a portfolio): Gemini 3.1 not a portfolio; Haiku pending
- [ilkeozs.info](https://ilkeozs.info) (Broken or dead, never graded): Gemini 3.1 portfolio; Haiku pending
- [kodr.pro](https://kodr.pro) (Broken or dead, never graded): Gemini 3.1 portfolio; Haiku pending
- [manixh.vercel.app](https://manixh.vercel.app) (Broken or dead, never graded): Gemini 3.1 portfolio; Haiku pending
- [www.adpandey.com](https://www.adpandey.com) (Delisted before grading): Gemini 3.1 not a portfolio; Haiku pending

## (c) Not a portfolio, and why (76)

62 sites both models call not a portfolio, and 14 a code rule settles without a model (an unedited placeholder, a parked page, a code host or link-in-bio address).
Reasons, most common first, are in the list below; each site keeps both models' own words.

- [adittya.site](https://adittya.site) (Graded not a portfolio): code rule, parked or for sale
- [amiralirashidi.github.io](https://amiralirashidi.github.io) (Graded not a portfolio): code rule, parked or for sale
- [github.com/1hanzla100/developer-portfolio](https://github.com/1hanzla100/developer-portfolio) (Graded not a portfolio): code rule, not a portfolio address
- [github.com/AnamuddinAhmad/Portfolio_1](https://github.com/AnamuddinAhmad/Portfolio_1) (Graded not a portfolio): code rule, not a portfolio address
- [github.com/AnshulGora/portfolio_template_v1](https://github.com/AnshulGora/portfolio_template_v1) (Graded not a portfolio): code rule, not a portfolio address
- [github.com/QMS85/MyPortfolio](https://github.com/QMS85/MyPortfolio) (Graded not a portfolio): code rule, not a portfolio address
- [github.com/Taiizor](https://github.com/Taiizor) (Graded not a portfolio): code rule, not a portfolio address
- [github.com/bdallard/ai-resume-portfolio](https://github.com/bdallard/ai-resume-portfolio) (Graded not a portfolio): code rule, not a portfolio address
- [github.com/bhagawatadhikari](https://github.com/bhagawatadhikari) (Graded not a portfolio): code rule, not a portfolio address
- [github.com/rohit-wadhwa](https://github.com/rohit-wadhwa) (Graded not a portfolio): code rule, not a portfolio address
- [github.com/saisudhir14](https://github.com/saisudhir14) (Graded not a portfolio): code rule, not a portfolio address
- [linktr.ee/abdullahahsan](https://linktr.ee/abdullahahsan) (Graded not a portfolio): code rule, not a portfolio address
- [linktr.ee/drepin](https://linktr.ee/drepin) (Graded not a portfolio): code rule, not a portfolio address
- [linktr.ee/syedsyab](https://linktr.ee/syedsyab) (Graded not a portfolio): code rule, not a portfolio address
- [sparshkamat.me](http://sparshkamat.me) (Graded not a portfolio): Gemini "The site is currently inaccessible due to a DNS error."; Haiku "The page is an error page from Cloudflare, so no name, role or work can be seen."
- [valentinpotie.github.io/portfolio](http://valentinpotie.github.io/portfolio) (Graded not a portfolio): Gemini "This is a product landing page for a portfolio builder, not a personal portfolio."; Haiku "This is a marketing landing page for a portfolio-building product, not a page about a person; the demo shows a different persona."
- [abu-bakar-portfolio-mauve.vercel.app](https://abu-bakar-portfolio-mauve.vercel.app) (Delisted after grading): Gemini "The page is a broken deployment error, not a portfolio."; Haiku "The page is a deployment error with no name, role, or work shown, so it is a broken page and is excluded."
- [aditya113141.github.io](https://aditya113141.github.io) (Graded not a portfolio): Gemini "The site is a farewell message stating all content has been removed."; Haiku "The page is a removal and farewell notice with no working portfolio content, so it is an error-like page rather than a portfolio."
- [akhshyganesh.github.io](https://akhshyganesh.github.io) (Graded not a portfolio): Gemini "This is a redirect page, not a portfolio."; Haiku "This is a moved-notice page that only points to another domain. It shows no name, role or work of its own, so it is not a portfolio page."
- [almarzancom.vercel.app](https://almarzancom.vercel.app) (Delisted before grading): Gemini "The site is a 404 error page, not a portfolio."; Haiku "The page is a 404 error page with no name, role or way to work, so it is a broken page and not a portfolio."
- [amreshsinha.vercel.app](https://amreshsinha.vercel.app) (Delisted after grading): Gemini "The site is a 404 error page."; Haiku "The page is a 404 error page with no name, role or work, so it is a broken page and not a portfolio."
- [atanu-portfolio-devsecops-production.up.railway.app](https://atanu-portfolio-devsecops-production.up.railway.app) (Delisted before grading): Gemini "The site is a 404 error page, not a portfolio."; Haiku "The page is a 404 error page with no content about a person, so it is excluded as a broken page."
- [balakekarbon.github.io](https://balakekarbon.github.io) (Delisted after grading): Gemini "The site is a broken 404 error page."; Haiku "The page is a GitHub Pages error page with no name, role or personal content, so it is a broken page."
- [beno-portofolio-v2.onrender.com](https://beno-portofolio-v2.onrender.com) (Broken or dead, never graded): Gemini "This is a loading screen for a web hosting service, not a personal portfolio."; Haiku "The page is a Render app-loading screen, an error or blank state, not a portfolio; no name or work is shown."
- [calzye.com](https://calzye.com) (Graded not a portfolio): Gemini "This is a tool/calculator website, not a personal portfolio."; Haiku "This is a calculator product site for the brand Calzye, not a page about a person, so it is a company or product site."
- [dangor220.github.io/developer-portfolio](https://dangor220.github.io/developer-portfolio) (Delisted after grading): Gemini "The site is a 404 error page, not a portfolio."; Haiku "The page is a GitHub Pages 404 error with no person, name, role or work shown."
- [darawsha.github.io](https://darawsha.github.io) (Delisted before grading): Gemini "The site is a broken 404 page."; Haiku "This is a 404 error page with no name, role or work. It fails the exclusion for a broken or blank page."
- [datasciencefolio.streamlit.app](https://datasciencefolio.streamlit.app) (Broken or dead, never graded): Gemini "The site is currently broken and displays an error message instead of content."; Haiku "The page is a broken error screen with no name, role or work visible, so it fails the exclusion for a broken or error page."
- [devlato.com](https://devlato.com) (Graded not a portfolio): Gemini "This is a bare contact page with no projects, role, or professional context."; Haiku "This is a link-in-bio style page: a handle and a list of social links. It shows no name, no role and no project content, so it is not a real portfolio."
- [dinogomez.vercel.app](https://dinogomez.vercel.app) (Delisted after grading): Gemini "The page is a 404 error and does not contain any portfolio content."; Haiku "The page is a 404 error with no name, role or work, so it is a broken page and not a portfolio."
- [furki.vercel.app](https://furki.vercel.app) (Delisted before grading): Gemini "The page is a broken 404 error, not a functional portfolio."; Haiku "The page is a broken 404 deployment error with no content about a person, so it is excluded."
- [garvnanwani.netlify.app](https://garvnanwani.netlify.app) (Delisted after grading): Gemini "This is a 404 error page, not a portfolio."; Haiku "This is a Netlify 404 error page with no person, role or work shown, so it is not a portfolio."
- [grazziotti-portfolio.vercel.app](https://grazziotti-portfolio.vercel.app) (Delisted after grading): Gemini "The site is a broken/paused deployment and does not contain portfolio content."; Haiku "The page is an error page from a paused deployment, with no name, role or work visible, so it is a broken page."
- [hosamaadem-portfolio-6ujt.vercel.app](https://hosamaadem-portfolio-6ujt.vercel.app) (Delisted before grading): Gemini "The site is a 404 error page, not a portfolio."; Haiku "The page is a 404 deployment error with no content about a person, so it is an error page."
- [hosamaadem-portfolio-6ujt.vercel.app](https://hosamaadem-portfolio-6ujt.vercel.app/) (Delisted before grading): Gemini "The site is broken and does not load."; Haiku "The page is a broken 404 error page with no name, role or work, so it is excluded."
- [ifeoluwa-portfolio-five.vercel.app](https://ifeoluwa-portfolio-five.vercel.app) (Delisted before grading): Gemini "The site is a 404 error page, not a portfolio."; Haiku "The page is a 404 deployment error with no name, role, or way to work. It is a broken page, so it is not a portfolio."
- [indrajeet.me](https://indrajeet.me) (Delisted after grading): Gemini "This is a gambling website, not a personal portfolio."; Haiku "Gambling promotion page about a company brand, not a person; no personal identity, role or work, so it is not a portfolio."
- [iodev.io](https://iodev.io) (Delisted before grading): Gemini "This is a login page for LinkedIn, not a personal portfolio website."; Haiku "The page is a LinkedIn sign-up page, not a portfolio about a person. It shows no name, role or work, so it fails the exclusion for a page that is not about a person."
- [jayvegad.vercel.app](https://jayvegad.vercel.app) (Graded not a portfolio): Gemini "The page is a 404 error page, not a portfolio."; Haiku "The page is a broken 404 deployment error page with no content about a person, so it is not a portfolio."
- [kamipresents.com](https://kamipresents.com) (Broken or dead, never graded): Gemini "The domain is expired and shows a parked page, not a personal portfolio."; Haiku "This is an expired-domain error page from a hosting provider, with no person's content on it. It falls under the broken or error page exclusion."
- [karrarnazim.space](https://karrarnazim.space) (Graded not a portfolio): Gemini "This is a domain parking page for sale, not a personal portfolio."; Haiku "This is a parked-for-sale domain listing with no person's name, role or work. It fails the exclusion for a for-sale domain."
- [kenfack-me.vercel.app](https://kenfack-me.vercel.app) (Delisted after grading): Gemini "The site is a 404 error page, not a functional portfolio."; Haiku "The page is a broken 404 error page, with no name, role or way to work shown, so it is excluded."
- [kritan560.github.io/portfolio](https://kritan560.github.io/portfolio/) (Delisted before grading): Gemini "The page is a broken 404 error."; Haiku "This is a broken page: the address returns GitHub's 404 error with no content about a person, so it is excluded."
- [lalith-d-portfolio.netlify.app](https://lalith-d-portfolio.netlify.app) (Delisted after grading): Gemini "The site is a broken 404 error page."; Haiku "The page is a broken Netlify error page with no name, role or work visible, so it is not a portfolio."
- [lukecele-research.vercel.app](https://lukecele-research.vercel.app/) (Delisted after grading): Gemini "The site is a 404 error page."; Haiku "The page is a broken 404 deployment error page with no content about a person, so it is not a portfolio."
- [mohitjoe.vercel.app](https://mohitjoe.vercel.app) (Delisted after grading): Gemini "The site is a broken deployment/error page."; Haiku "The page is a 404 deployment error with no content about a person, so it falls under the broken or error page exclusion."
- [mokhele.pythonanywhere.com](https://mokhele.pythonanywhere.com) (Delisted after grading): Gemini "This is a parked domain page, not a personal portfolio."; Haiku "This is the default PythonAnywhere placeholder page; it shows no person, role or work, so it is not a portfolio."
- [mushfiq.xyz](https://mushfiq.xyz) (Delisted after grading): Gemini "This is a login page for an application, not a personal portfolio."; Haiku "The page is a login and download page for a time-tracking app. It has no personal identity, no role and no way to the person's work, and it is not a portfolio."
- [n-cv.vercel.app](https://n-cv.vercel.app) (Delisted after grading): Gemini "The site is a broken 404 error page."; Haiku "The page is an error page with no name, role or way to work, so it is a broken page."
- [nja-systems.vercel.app](https://nja-systems.vercel.app/) (Delisted before grading): Gemini "This is a broken page, not a portfolio."; Haiku "This is a 404 error page with no name, role or work shown, so it is an error page rather than a portfolio."
- [notesc.netlify.app](https://notesc.netlify.app) (Delisted before grading): Gemini "The site is a 404 error page, not a portfolio."; Haiku "The page is a broken Netlify error page, not a portfolio. No name, role or work link is shown."
- [parinithmavurapu.vercel.app](https://parinithmavurapu.vercel.app) (Delisted after grading): Gemini "The site is a 404 error page, not a portfolio."; Haiku "This is a broken deployment error page with no name, role or way to reach work, so it is not a portfolio."
- [portfolio-nu-lovat-90.vercel.app/project](https://portfolio-nu-lovat-90.vercel.app/project) (Delisted before grading): Gemini "The page is a 404 error page, not a personal portfolio."; Haiku "This is an error page with no name, role or work visible, so it is not a portfolio that can be judged."
- [portfoliojuanfranciscocisneros.web.app](https://portfoliojuanfranciscocisneros.web.app) (Graded not a portfolio): Gemini "The page is a broken deployment error, not a portfolio."; Haiku "The page is a Firebase hosting error with no name, role or work shown, so it is a broken page and is excluded."
- [rafalazar.github.io](https://rafalazar.github.io) (Broken or dead, never graded): Gemini "This is a redirect page, not a portfolio."; Haiku "The page is only a moved-address notice with no portfolio content, and its title names a different person from the facts."
- [raggiodev.vercel.app](https://raggiodev.vercel.app) (Delisted after grading): Gemini "The site is a broken 404 page."; Haiku "The page is a broken 404 error page with no content about a person, so it is not a working portfolio."
- [rahnoxa.antideploy.com](https://rahnoxa.antideploy.com) (Graded not a portfolio): Gemini "This is a company/agency website, not a personal developer portfolio."; Haiku "This is a company services site for Rahnoxa with no personal identity or personal project work, so it is not a personal portfolio."
- [rathodram.is-a.dev](https://rathodram.is-a.dev/) (Delisted before grading): Gemini "The site is a broken 404 error page."; Haiku "The page is a 404 error page with no content about a person, so it is a broken page."
- [rathodramraj.vercel.app](https://rathodramraj.vercel.app) (Delisted before grading): Gemini "The page is a 404 error page, not a personal portfolio."; Haiku "This is a deployment error page with no name, role or work visible, so it is not a portfolio that can be judged."
- [rohitsoni007.github.io/portfolio](https://rohitsoni007.github.io/portfolio) (Delisted after grading): Gemini "The site is a 404 error page, not a portfolio."; Haiku "The page is a broken error page with no content about a person, so it is not a portfolio."
- [shalon.vercel.app](https://shalon.vercel.app) (Delisted after grading): Gemini "This is a commercial product information site, not a personal developer portfolio."; Haiku "This is a product information and purchase guide for a Japanese patch brand, with no person named and no developer identity, so it is not a portfolio."
- [sohailkhan0525.github.io/MyPortfolio](https://sohailkhan0525.github.io/MyPortfolio) (Delisted before grading): Gemini "This is a GitHub repository README file, not a personal portfolio website."; Haiku "The page is a README describing a code repository for the site, with no visible projects or work links, so it reads as a bare code repository rather than a portfolio about the person."
- [suraj-yadav0.github.io/terminal-portfolio](https://suraj-yadav0.github.io/terminal-portfolio/) (Delisted after grading): Gemini "The site is a 404 error page and does not contain portfolio content."; Haiku "The address shows a GitHub Pages error page, 'Site not found', so it is a broken page with no name, role or work."
- [techfolios.github.io](https://techfolios.github.io) (Graded not a portfolio): Gemini "This is a landing page for a software tool, not a personal portfolio."; Haiku "The page is a company or project site for a template tool, not about a person; no personal name or role."
- [thesimpanze.github.io/Portofolio-Rasyid](https://thesimpanze.github.io/Portofolio-Rasyid) (Delisted before grading): Gemini "The site is a 404 error page, not a functional portfolio."; Haiku "This is a broken error page (GitHub Pages 404) with no content about a person, so an exclusion applies."
- [thomas-david-portfolio.netlify.app](https://thomas-david-portfolio.netlify.app) (Graded not a portfolio): Gemini "The site is an unedited template containing placeholder text and demo names."; Haiku "The page is an unedited template: lorem ipsum runs through the work, services and testimonials, and John Doe appears as a testimonial name."
- [vallarasuk.com](https://vallarasuk.com) (Delisted after grading): Gemini "This is a gambling/slot machine site, not a personal developer portfolio."; Haiku "This is a promotional gambling page for PIKA77, not a page about a person, so it is excluded."
- [vikasdev-in.vercel.app](https://vikasdev-in.vercel.app) (Delisted before grading): Gemini "The site is a broken 404 error page."; Haiku "The page is a broken error page with no content about a person, so it is excluded."
- [vikasdev-in.vercel.app](https://vikasdev-in.vercel.app/) (Delisted before grading): Gemini "The site is a broken 404 page."; Haiku "The page is a broken 404 error page with no content about a person, so it is not a working portfolio."
- [vivekchudasama-2004.github.io/portfolio](https://vivekchudasama-2004.github.io/portfolio) (Delisted after grading): Gemini "The page is a 404 error page, not a personal portfolio."; Haiku "This is a GitHub Pages error page with no name, role or work visible, so it is not a portfolio that can be judged."
- [www.abhisheksah.dev](https://www.abhisheksah.dev) (Graded not a portfolio): Gemini "This is a gambling/slot machine site, not a developer portfolio."; Haiku "The page is a gambling promotion site about togel and slots, not a portfolio about a person, so it is excluded."
- [www.beterbekend.nl](https://www.beterbekend.nl) (Graded not a portfolio): Gemini "This is a company website, not a personal portfolio."; Haiku "This is a company agency site (Beter Bekend) with no named person; the 'Jens Van Wijhe' fact is not visible on the page; excluded as not about a person."
- [www.caiovisuals.com](https://www.caiovisuals.com) (Delisted before grading): Gemini "The site is a broken 404 error page."; Haiku "The page is a broken error page (404 deployment not found), with no name, role or work link, so it is excluded."
- [www.hungrybearstudios.com](https://www.hungrybearstudios.com) (Graded not a portfolio): Gemini "This is a company/studio site, not a personal portfolio."; Haiku "This is a studio site for Hungry Bear Studios, with no personal name or personal identity in the header, so it is not a person's portfolio."
- [www.seniordevelopermnelisi.com](https://www.seniordevelopermnelisi.com) (Delisted before grading): Gemini "The site is a broken server error page, not a personal portfolio."; Haiku "This is an HTTP 500.35 error page, not a page about a person, with no name, role or way to work."
- [xqyet.dev](https://xqyet.dev) (Graded not a portfolio): Gemini "It lacks a clear role, projects, and contact information, functioning more as a gimmick than a portfolio."; Haiku "This is a fake BIOS boot screen with no person's name, role or way to any work, so it is not a portfolio."

**What this means**

- Most are broken deploys, 404 pages, parked or hijacked domains and code repositories: dead or not about a person, as v2.1 intends.

## Gemini "no" on grounds v2.1 does not allow (13)

v2.1 says a site is a portfolio unless it is parked or for sale, an unedited placeholder, not about a person, or broken; a missing sign, a missing role included, is never a reason for no, and a blog is not an exclusion.
Gemini 3.1 still said no on such grounds for these sites; Haiku did for 0.

- [armujahid.me](https://armujahid.me) (Graded not a portfolio, signals 3)
  - Gemini 3.1: not a portfolio (4/1/5), "This is a blog, not a portfolio; it lacks a clear professional role and a way to view projects."
  - Haiku 5.5: portfolio (4/1/4), "This is a personal blog by Abdul Rauf, so it identifies a person through his name and writing. It shows no developer role and no project links, but a missing sign is not grounds for false."
  - Owner (13 Nov): not a portfolio, not a portfolio (owner, 13 Nov)
- [ashwinhariharan.com/software-engineering](https://ashwinhariharan.com/software-engineering) (Graded not a portfolio, signals 4)
  - Gemini 3.1: not a portfolio (4/2/4), "This is a personal blog and content site, not a portfolio of software projects."
  - Haiku 5.5: portfolio (3/2/3), "A named person (Ashwin Hariharan) with a clear personal identity; the role is not stated on the page and there is no project showcase, but no exclusion applies."
- [devlato.com](https://devlato.com) (Graded not a portfolio, signals 2)
  - Gemini 3.1: not a portfolio (3/1/1), "This is a bare contact page with no projects, role, or professional context."
  - Haiku 5.5: not a portfolio (3/1/1), "This is a link-in-bio style page: a handle and a list of social links. It shows no name, no role and no project content, so it is not a real portfolio."
- [fabienlaurence.com](https://fabienlaurence.com) (Graded not a portfolio, signals 4)
  - Gemini 3.1: not a portfolio (4/1/2), "This is a personal blog with no projects or professional role defined."
  - Haiku 5.5: portfolio (3/1/1), "Shows a first name (Fabien) and a GitHub link, so identity and a way to work are present. Role is missing, which lowers scores but is not grounds for false."
- [maggioni.dev](https://maggioni.dev) (Graded not a portfolio, signals 3)
  - Gemini 3.1: not a portfolio (3/1/2), "This is a personal blog, not a portfolio. It lacks a clear professional role and a way to view work."
  - Haiku 5.5: portfolio (3/2/3), "This is a personal blog by a named author with post list; no role stated and no work or project links, so it reads as a blog rather than a developer portfolio."
  - Owner (13 Nov): not a portfolio, not a portfolio (owner, 13 Nov)
- [matvey.codes](https://matvey.codes) (Broken or dead, never graded, signals 1)
  - Gemini 3.1: not a portfolio (3/1/1), "It lacks a personal identity, a role, and a way to view work."
  - Haiku 5.5: portfolio (4/1/1), "The domain and page show a personal identity, matvey.codes, but no role or work link is visible; the page is about hobbies, so it is a weak but real personal page."
  - Owner (13 Nov): not a portfolio, not a portfolio (owner, 13 Nov)
- [rknastenka.com](https://rknastenka.com) (Graded not a portfolio, signals 5)
  - Gemini 3.1: not a portfolio (3/1/3), "The site is a personal blog/manifesto and lacks a professional role or any project content."
  - Haiku 5.5: portfolio (3/1/3), "A name and a Projects link are visible, so the page is a personal portfolio. The missing role does not disqualify it."
- [sobolevn.me](https://sobolevn.me) (Graded not a portfolio, signals 5)
  - Gemini 3.1: not a portfolio (3/1/5), "This is a personal blog, not a portfolio; it lacks a clear professional identity and a way to view work."
  - Haiku 5.5: portfolio (4/1/4), "This is a personal blog with no visible name, no stated developer role and no project or resume link, so it is a weak portfolio. No exclusion applies, so it counts as a portfolio."
- [www.erdaltaskesen.com](https://www.erdaltaskesen.com) (Broken or dead, never graded, signals 4)
  - Gemini 3.1: not a portfolio (3/1/3), "It is primarily a blog, not a portfolio showcasing software engineering projects."
  - Haiku 5.5: portfolio (3/1/2), "A named person with a blog and GitHub and LinkedIn icons, but no projects and a role that lists unrelated jobs."
- [www.patrickhyatt.com](https://www.patrickhyatt.com) (Graded not a portfolio, signals 5)
  - Gemini 3.1: not a portfolio (2/1/2), "This is a personal blog, not a professional portfolio; it lacks a clear role and links to work."
  - Haiku 5.5: portfolio (3/2/3), "A personal blog by Patrick Hyatt with no developer role or way to work shown at the top; it is a blog, not a portfolio, but the person is identifiable, so it is not excluded."
- [www.techinz.dev](https://www.techinz.dev) (Graded not a portfolio, signals 3)
  - Gemini 3.1: not a portfolio (3/1/1), "This is a single project page, not a portfolio of work."
  - Haiku 5.5: portfolio (4/1/1), "The page title reads 'Galaxy portfolio | Full Stack Developer' and it links to a GitHub repository, so it is presented as a developer's portfolio. The visible screen shows no name or role, which weakens the five-second test but is not an exclusion."
  - Owner (13 Nov): a portfolio, a portfolio, a weak one (owner, 13 Nov)
- [www.tiagocreator.com](https://www.tiagocreator.com) (Graded not a portfolio, signals 1)
  - Gemini 3.1: not a portfolio (3/1/2), "This is a personal blog, not a professional portfolio; it lacks projects and a clear professional role."
  - Haiku 5.5: portfolio (3/1/2), "Personal identity (Tiago Creator) and a contact link exist, but no role or projects are shown; it reads as a personal blog, so it is a weak portfolio rather than a non-person page."
  - Owner (13 Nov): not a portfolio, not a portfolio (owner, 13 Nov)
- [xqyet.dev](https://xqyet.dev) (Graded not a portfolio, signals 0)
  - Gemini 3.1: not a portfolio (2/1/1), "It lacks a clear role, projects, and contact information, functioning more as a gimmick than a portfolio."
  - Haiku 5.5: not a portfolio (1/1/1), "This is a fake BIOS boot screen with no person's name, role or way to any work, so it is not a portfolio."

**What this means**

- Where Haiku says portfolio on these, the definition is working and Gemini 3.1 is not following it; that matters for which model grades in production.

## (d) Batched against one at a time

| Model | Sites | Same verdict | visual design: same score | project presentation: same score | writing: same score |
| --- | --- | --- | --- | --- | --- |
| Gemini 3.1 | 100 | 93 (93%) | 72 (72%) | 56 (56%) | 61 (61%) |
| Haiku 5.5 | 406 | 397 (98%) | 307 (76%) | 322 (79%) | 297 (73%) |

Gemini 3.1 graded 100 sites alone (20 per group, a fixed seed); Haiku graded every site alone.

**What this means**

- If batching changes a verdict often, a batched answer is not a safe base for a decision on its own.

## (e) Retries and failures

| Run | HTTP requests | Retries | Busy (5xx or network) | Statuses | Answers that did not parse | Wrong site count | Left unanswered |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gemini 3.1 pilot | 2 | 0 | 0 | 200: 2 | 0 | 0 | 0 |
| Gemini 3.1 full run | 198 | 14 | 14 | 0: 1, 200: 183, 503: 13 | 0 | 0 | 0 |
| Gemini 3.1 extra batch | 2 | 0 | 0 | 200: 2 | 0 | 0 | 0 |
| Claude Haiku 5.5 | 496 | 0 | 0 | 200: 496 | 0 | 0 | 0 |

The first full Gemini run (43516379299) was cancelled at 2026-11-13T22:07:18Z for the owner (tests first); 3 batches were answered and kept, one request was in flight, and the run resumed from that state.

**What this means**

- Every busy answer was retried; nothing was dropped.

## Sites that could not be graded (140)

| What happened | Sites |
| --- | --- |
| DNS: name does not resolve | 57 |
| blocked: under 40 words, no outbound links | 50 |
| bot or Cloudflare block | 10 |
| connection refused or dropped | 10 |
| malformed address | 5 |
| timeout | 3 |
| blocked: dialog still on screen | 2 |
| TLS | 1 |
| blocked: gate still on screen | 1 |
| script error in our capture | 1 |

The failed loads were retried once from this machine (not a GitHub address), with a 60-second load, 20 seconds for content and the capture fixes since; names that do not resolve here either are dead.
dead: the name does not resolve from here either: 57
still blocked: under 40 words, no outbound links: 51
still connection refused or dropped: 10
loads now: 9
still timeout: 2
still bot or Cloudflare block: 2
still TLS: 1

**What this means**

- A name that does not resolve from two networks is gone; those sites are dead, not broken by the capture.

## (f) Cost and time

| Run | Requests | Tokens | Cost | From | To | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| Gemini 3.1 pilot | 2 | 35k in, 4k out, 3k thinking | free tier | 2026-11-13T22:04:28.451Z | 2026-11-13T22:04:41.813Z | 0 min |
| Gemini 3.1 full run | 198 | 1938k in, 233k out, 168k thinking | free tier | 2026-11-13T22:06:20.928Z | 2026-11-13T22:57:48.555Z | 51 min |
| Gemini 3.1 extra batch | 2 | 35k in, 4k out, 3k thinking | free tier | 2026-11-13T23:38:25.810Z | 2026-11-13T23:38:40.123Z | 0 min |
| Claude Haiku 5.5 | 496 | 5135k in, 1067k out | $1.05 | 2026-11-13T22:10:03.243Z | 2026-11-13T23:37:13.115Z | 87 min |

Gemini 3.1 runs on the free tier (500 requests a Pacific day assumed); the job stayed under its own cap of 230 and under 440 for the day, leaving room for mini test 8.
Gemini 3.5 was not used; production flags and GEMINI_BUDGET were unchanged.
Capture: 4 splash gates passed, 17 dialogs closed, 0 mode pickers, 128 captures needed their one retry (GitHub Actions, no AI).

## Appendix A: every site

| Site | Group | Path | Gemini 3.1 (batch / solo) | Haiku (batch / solo) | Signals | Proposed | Capture |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [<[Portfolio-Link](https://khushm.netlify.app](<[Portfolio-Link](https://khushm.netlify.app) | Delisted before grading | capture failed | - / - | - / - | - | - | Invalid URL |
| [[Portfolio-Link](https://khushm.netlify.app]([Portfolio-Link](https://khushm.netlify.app) | Delisted before grading | capture failed | - / - | - / - | - | - | Invalid URL |
| [[portfolio-link](https://khushm.netlify.app]([portfolio-link](https://khushm.netlify.app/) | Delisted before grading | capture failed | - / - | - / - | - | - | Invalid URL |
| [abass.wanecrea.com](abass.wanecrea.com) | Delisted before grading | capture failed | - / - | - / - | - | - | Invalid URL |
| [aelarassi.com](http://aelarassi.com) | Broken or dead, never graded | capture blocked | - / - | - / - | 3 | review (flagged) | 1 words and no outbound links |
| [iamreliq.com](http://iamreliq.com) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [kaleighscruggs.com](http://kaleighscruggs.com) | Graded not a portfolio | graders | portfolio / not a portfolio | portfolio / portfolio | 4 | relist |  |
| [kueiyiee-portfolio.vercel.app](http://kueiyiee-portfolio.vercel.app) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [my-portfolio-jz1h.vercel.app](http://my-portfolio-jz1h.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [portfolio.proaikit.com](http://portfolio.proaikit.com/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [shankumar.is-a.dev](http://shankumar.is-a.dev) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [shannoncrabill.com](http://shannoncrabill.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [sparshkamat.me](http://sparshkamat.me) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [vaibhavsingh97.com](http://vaibhavsingh97.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [valentinpotie.github.io/portfolio](http://valentinpotie.github.io/portfolio) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [www.bluexguardian.com](http://www.bluexguardian.com) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [aalahyan3.tech](https://aalahyan3.tech) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://aalahyan3.tech/ |
| [aarondunphy.com](https://aarondunphy.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [aarus2709.me](https://aarus2709.me) | Graded not a portfolio | capture blocked | - / - | - / - | 0 | review (flagged) | 21 words and no outbound links |
| [aashay-dev-ed.develop.my.site.com/AashayWase/s](https://aashay-dev-ed.develop.my.site.com/AashayWase/s) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [abbasraza.dev](https://abbasraza.dev) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist | clicked "click to continue" |
| [abd-cloud-resume-v1.pages.dev](https://abd-cloud-resume-v1.pages.dev/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [abdenassar-portfolio-4smfcqph6-abdenassaramimi99-gmailcom.vercel.app](https://abdenassar-portfolio-4smfcqph6-abdenassaramimi99-gmailcom.vercel.app) | Delisted after grading | capture blocked | - / - | - / - | 3 | review (flagged) | 23 words and no outbound links |
| [abdullah-al-monir.web.app](https://abdullah-al-monir.web.app) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [abdullahbozdag.com](https://abdullahbozdag.com) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://abdullahbozdag.com/ |
| [abhishek-kumar-t.vercel.app](https://abhishek-kumar-t.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [abhishekkandel.com.np](https://abhishekkandel.com.np) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [about.ashutoshcodes.in](https://about.ashutoshcodes.in) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist | clicked "Continue with ChatGPT" |
| [aboutzahin.pages.dev](https://aboutzahin.pages.dev) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [abu-bakar-portfolio-mauve.vercel.app](https://abu-bakar-portfolio-mauve.vercel.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [achint.vercel.app](https://achint.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [adittya.site](https://adittya.site) | Graded not a portfolio | code rule | not a portfolio / not a portfolio | not a portfolio / not a portfolio | 0 | - |  |
| [aditya-pillai.vercel.app](https://aditya-pillai.vercel.app) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [aditya113141.github.io](https://aditya113141.github.io) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [aditya30051993.github.io/my-portfolio](https://aditya30051993.github.io/my-portfolio) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [adityacodes.in](https://adityacodes.in) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://adityacodes.in/ |
| [adityanamdeo.qzz.io](https://adityanamdeo.qzz.io/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [adityathakur.me](https://adityathakur.me) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [affan-portfolio-kappa.vercel.app](https://affan-portfolio-kappa.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [agney.dev](https://agney.dev) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [ahmad-netflix-portfolio-ujir.vercel.app](https://ahmad-netflix-portfolio-ujir.vercel.app) | Graded not a portfolio | capture blocked | - / - | - / - | 2 | review (flagged) | 6 words and no outbound links |
| [ahmednassar7.github.io](https://ahmednassar7.github.io) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [ahmednassar7.github.io](https://ahmednassar7.github.io/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [aj7.is-a.dev](https://aj7.is-a.dev) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://aj7.is-a.dev/ |
| [ajayprajapat.com](https://ajayprajapat.com) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [akhshyganesh.github.io](https://akhshyganesh.github.io) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / portfolio | 2 | - |  |
| [akshaysanthoshkumar.vercel.app](https://akshaysanthoshkumar.vercel.app) | Broken or dead, never graded | graders | portfolio / - | - / - | 6 | - |  |
| [akwastaken.github.io](https://akwastaken.github.io) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [alexandrefernandes.dev](https://alexandrefernandes.dev) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [alexkoncept.github.io](https://alexkoncept.github.io/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [aliahtisham.pro](https://aliahtisham.pro) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://aliahtisham.pro/ |
| [alifjobaer12.vercel.app](https://alifjobaer12.vercel.app) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [alihamza-fawn.vercel.app](https://alihamza-fawn.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [allenkoch.dev](https://allenkoch.dev/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [almarzancom.vercel.app](https://almarzancom.vercel.app) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [ameed.me](https://ameed.me) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [amiralirashidi.github.io](https://amiralirashidi.github.io) | Graded not a portfolio | code rule | not a portfolio / - | - / - | 1 | - |  |
| [amreshsinha.vercel.app](https://amreshsinha.vercel.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [an3dree.dev](https://an3dree.dev) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_CONNECTION_CLOSED at https://an3dree.dev/ |
| [andrianaivo-ismael.vercel.app/admin](https://andrianaivo-ismael.vercel.app/admin) | Graded not a portfolio | capture blocked | - / - | - / - | 3 | review (flagged) | 9 words and no outbound links |
| [andy-bell.design](https://andy-bell.design) | Graded not a portfolio | graders | portfolio / - | not a portfolio / not a portfolio | 3 | relist (flagged) |  |
| [anikahammedkhan.com](https://anikahammedkhan.com) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_CONNECTION_CLOSED at https://anikahammedkhan.com/ |
| [anish7.me](https://anish7.me) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [anukool.me](https://anukool.me) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [aquarifolio.vercel.app](https://aquarifolio.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [arbazansari.dev](https://arbazansari.dev) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://arbazansari.dev/ |
| [arefshalchi.com](https://arefshalchi.com/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [args.tech](https://args.tech) | Broken or dead, never graded | capture blocked | not a portfolio / not a portfolio | not a portfolio / not a portfolio | 0 | review (flagged) | a bot or security check stood in for the site |
| [arjunganesan.com](https://arjunganesan.com) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [armujahid.me](https://armujahid.me) | Graded not a portfolio | graders | not a portfolio / - | portfolio / portfolio | 3 | relist (flagged) |  |
| [arnelbg.com](https://arnelbg.com) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [asharma.tech](https://asharma.tech) | Delisted before grading | capture blocked | - / - | - / - | 3 | review (flagged) | 4 words and no outbound links |
| [ashifek.in](https://ashifek.in) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [ashlok.dev](https://ashlok.dev) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [ashwinhariharan.com/software-engineering](https://ashwinhariharan.com/software-engineering) | Graded not a portfolio | graders | not a portfolio / - | portfolio / portfolio | 4 | relist |  |
| [asmussen.tech](https://asmussen.tech) | Broken or dead, never graded | capture blocked | - / - | - / - | 3 | review (flagged) | 37 words and no outbound links |
| [atanu-portfolio-devsecops-production.up.railway.app](https://atanu-portfolio-devsecops-production.up.railway.app) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [ayooladev.vercel.app](https://ayooladev.vercel.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [ayushj.is-a.dev](https://ayushj.is-a.dev) | Graded not a portfolio | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [az-dev.vercel.app](https://az-dev.vercel.app) | Delisted before grading | graders | portfolio / - | - / - | 6 | - |  |
| [balakekarbon.github.io](https://balakekarbon.github.io) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [balkrishnabk.com.np](https://balkrishnabk.com.np) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [beno-portofolio-v2.onrender.com](https://beno-portofolio-v2.onrender.com) | Broken or dead, never graded | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [blakekarbon.github.io](https://blakekarbon.github.io/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [blanke.lol](https://blanke.lol) | Delisted before grading | capture blocked | - / - | - / - | 0 | review (flagged) | 6 words and no outbound links |
| [bnsaed.com](https://bnsaed.com/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [borisedison.in](https://borisedison.in) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [borove4ik.vercel.app](https://borove4ik.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [breakerino.me](https://breakerino.me) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://breakerino.me/ |
| [brendanlentz.com](https://brendanlentz.com) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [bruno-simon.com](https://bruno-simon.com) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [bruno-simon.com](https://bruno-simon.com/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [burhanaddinzm.github.io](https://burhanaddinzm.github.io/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [cade.codes](https://cade.codes) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [calzye.com](https://calzye.com) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 4 | - |  |
| [cameldjoulako.com](https://cameldjoulako.com) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [captmichael.dev](https://captmichael.dev) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_CONNECTION_CLOSED at https://captmichael.dev/ |
| [ccm.securityops.com.br](https://ccm.securityops.com.br) | Graded not a portfolio | capture failed | - / - | - / - | - | - | page.goto: net::ERR_SSL_UNRECOGNIZED_NAME_ALERT at https://ccm.securityops.com.br/ |
| [chaitanya-sai-meka.vercel.app](https://chaitanya-sai-meka.vercel.app) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 6 | relist | clicked "enter" |
| [charanreddy.qzz.io](https://charanreddy.qzz.io/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [chat-portfolio-dhanushnehru.netlify.app](https://chat-portfolio-dhanushnehru.netlify.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 1 | relist |  |
| [cheovermeyer.com](https://cheovermeyer.com) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://cheovermeyer.com/ |
| [chetanmahajan.vercel.app](https://chetanmahajan.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [chosensoul.kesug.com](https://chosensoul.kesug.com) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [chunhthanhde.github.io](https://chunhthanhde.github.io) | Broken or dead, never graded | capture blocked | - / - | - / - | 1 | review (flagged) | 0 words and no outbound links |
| [clixmods.github.io](https://clixmods.github.io) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [collinskoechportfolio.web.app](https://collinskoechportfolio.web.app) | Broken or dead, never graded | capture blocked | - / - | - / - | 0 | review (flagged) | 0 words and no outbound links |
| [crackedontiti.github.io](https://crackedontiti.github.io) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [cschad.com](https://cschad.com) | Graded not a portfolio | graders | portfolio / not a portfolio | portfolio / portfolio | 3 | relist |  |
| [cyrilaguvasu.tech](https://cyrilaguvasu.tech) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://cyrilaguvasu.tech/ |
| [dalefrench.dev](https://dalefrench.dev) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [damianmarkowski.com](https://damianmarkowski.com) | Graded not a portfolio | graders | portfolio / - | not a portfolio / portfolio | 2 | relist (flagged) |  |
| [dangor220.github.io/developer-portfolio](https://dangor220.github.io/developer-portfolio) | Delisted after grading | graders | not a portfolio / not a portfolio | not a portfolio / not a portfolio | 1 | - |  |
| [darakshanrasheed.in](https://darakshanrasheed.in) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [darawsha.github.io](https://darawsha.github.io) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [datasciencefolio.streamlit.app](https://datasciencefolio.streamlit.app) | Broken or dead, never graded | graders | not a portfolio / - | not a portfolio / not a portfolio | 2 | - |  |
| [datpham.dev](https://datpham.dev) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://datpham.dev/ |
| [davidesantangelo.com](https://davidesantangelo.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [daytime-dev.uk](https://daytime-dev.uk/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 2 | relist |  |
| [deenfoool.github.io/portfolio](https://deenfoool.github.io/portfolio/) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 5 | - |  |
| [deepsaha.com](https://deepsaha.com) | Graded not a portfolio | capture blocked | - / - | - / - | 0 | review (flagged) | 11 words and no outbound links |
| [delwer.live](https://delwer.live) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://delwer.live/ |
| [devi-r.com](https://devi-r.com) | Graded not a portfolio | graders | portfolio / not a portfolio | portfolio / portfolio | 3 | relist |  |
| [devlato.com](https://devlato.com) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 2 | - |  |
| [devlucas.website](https://devlucas.website) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://devlucas.website/ |
| [devmani-cs-code.vercel.app](https://devmani-cs-code.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [devrimmehmet.com](https://devrimmehmet.com) | Graded not a portfolio | graders | portfolio / not a portfolio | portfolio / portfolio | 3 | relist |  |
| [devzahid.in](https://devzahid.in) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [dewaldels.com](https://dewaldels.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [dg.aluc.me](https://dg.aluc.me) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [dheerajgupta.netlify.app/#](https://dheerajgupta.netlify.app/#) | Broken or dead, never graded | capture blocked | - / - | - / - | 1 | review (flagged) | 0 words and no outbound links |
| [dhirajbhawsar-portfolio.vercel.app](https://dhirajbhawsar-portfolio.vercel.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [dinogomez.vercel.app](https://dinogomez.vercel.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [dorlugasigal.netlify.app](https://dorlugasigal.netlify.app) | Graded not a portfolio | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [dub.sh/ananyabiswas](https://dub.sh/ananyabiswas) | Broken or dead, never graded | capture blocked | not a portfolio / - | not a portfolio / not a portfolio | 0 | review (flagged) | a bot or security check stood in for the site |
| [dub.sh/ankitdey](https://dub.sh/ankitdey) | Broken or dead, never graded | graders | portfolio / - | - / - | 6 | - |  |
| [eduardconstantin.github.io](https://eduardconstantin.github.io) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [eharshit.cfd](https://eharshit.cfd) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://eharshit.cfd/ |
| [ehsanrafee.ir](https://ehsanrafee.ir) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://ehsanrafee.ir/ |
| [elgratiofc.vercel.app](https://elgratiofc.vercel.app) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [emjjkk.tech](https://emjjkk.tech) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_CONNECTION_REFUSED at https://emjjkk.tech/ |
| [eneawork.it](https://eneawork.it) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [eneawork.it](https://eneawork.it/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [eneaxharja.com](https://eneaxharja.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [enesehs.github.io](https://enesehs.github.io) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [ericc.vercel.app](https://ericc.vercel.app) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [expensive.toys](https://expensive.toys) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [fabienlaurence.com](https://fabienlaurence.com) | Graded not a portfolio | graders | not a portfolio / - | portfolio / portfolio | 4 | relist |  |
| [fahim-cloud.vercel.app](https://fahim-cloud.vercel.app/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [faisalsaifi.tech](https://faisalsaifi.tech) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://faisalsaifi.tech/ |
| [fereshetyan.space](https://fereshetyan.space) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [ferhatolmez.vercel.app](https://ferhatolmez.vercel.app/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [foisal.org](https://foisal.org) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [frikishaan.com](https://frikishaan.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [furki.vercel.app](https://furki.vercel.app) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [g-dea.com](https://g-dea.com) | Graded not a portfolio | capture blocked | - / - | - / - | 2 | review (flagged) | 18 words and no outbound links |
| [ganesh-vscode.netlify.app](https://ganesh-vscode.netlify.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [garvnanwani.netlify.app](https://garvnanwani.netlify.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [gaspavar.dev](https://gaspavar.dev) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://gaspavar.dev/ |
| [gii-de.onrender.com](https://gii-de.onrender.com) | Delisted before grading | capture blocked | - / - | - / - | 0 | review (flagged) | 2 words and no outbound links |
| [git.id.au](https://git.id.au) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [github.com/1hanzla100/developer-portfolio](https://github.com/1hanzla100/developer-portfolio) | Graded not a portfolio | code rule | not a portfolio / - | not a portfolio / not a portfolio | 6 | - |  |
| [github.com/AnamuddinAhmad/Portfolio_1](https://github.com/AnamuddinAhmad/Portfolio_1) | Graded not a portfolio | code rule | not a portfolio / - | not a portfolio / not a portfolio | 6 | - |  |
| [github.com/AnshulGora/portfolio_template_v1](https://github.com/AnshulGora/portfolio_template_v1) | Graded not a portfolio | code rule | not a portfolio / not a portfolio | not a portfolio / not a portfolio | 6 | - |  |
| [github.com/QMS85/MyPortfolio](https://github.com/QMS85/MyPortfolio) | Graded not a portfolio | code rule | not a portfolio / - | not a portfolio / not a portfolio | 5 | - |  |
| [github.com/Taiizor](https://github.com/Taiizor) | Graded not a portfolio | code rule | portfolio / - | portfolio / portfolio | 5 | - |  |
| [github.com/bdallard/ai-resume-portfolio](https://github.com/bdallard/ai-resume-portfolio) | Graded not a portfolio | code rule | not a portfolio / - | not a portfolio / not a portfolio | 6 | - |  |
| [github.com/bhagawatadhikari](https://github.com/bhagawatadhikari) | Graded not a portfolio | code rule | portfolio / - | portfolio / portfolio | 5 | - |  |
| [github.com/rohit-wadhwa](https://github.com/rohit-wadhwa) | Graded not a portfolio | code rule | portfolio / - | portfolio / portfolio | 6 | - |  |
| [github.com/saisudhir14](https://github.com/saisudhir14) | Graded not a portfolio | code rule | portfolio / portfolio | portfolio / portfolio | 5 | - |  |
| [gokul-raja84.github.io](https://gokul-raja84.github.io) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [gracesnowdesign.co.uk](https://gracesnowdesign.co.uk) | Graded not a portfolio | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [grazziotti-portfolio.vercel.app](https://grazziotti-portfolio.vercel.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 3 | - |  |
| [gretamacri.com](https://gretamacri.com) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_CONNECTION_CLOSED at https://gretamacri.com/ |
| [guille0197.github.io/portafolio](https://guille0197.github.io/portafolio) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [haffee.vercel.app](https://haffee.vercel.app) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [hamishw.com](https://hamishw.com) | Graded not a portfolio | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [hanumantjain.tech](https://hanumantjain.tech) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://hanumantjain.tech/ |
| [harsh-prajapati54-github-io.vercel.app](https://harsh-prajapati54-github-io.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [harshitha-portfolio-fawn.vercel.app](https://harshitha-portfolio-fawn.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [hassan-ali-portfolio-nine.vercel.app](https://hassan-ali-portfolio-nine.vercel.app) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [hassanx.tech](https://hassanx.tech) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://hassanx.tech/ |
| [hellohaylee.com](https://hellohaylee.com/) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [hellosagar.vercel.app](https://hellosagar.vercel.app) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [heny.dev](https://heny.dev) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [hetxpatel.vercel.app](https://hetxpatel.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [heysai.dev](https://heysai.dev/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist | pressed Escape on a dialog |
| [hosamaadem-portfolio-6ujt.vercel.app](https://hosamaadem-portfolio-6ujt.vercel.app) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [hosamaadem-portfolio-6ujt.vercel.app](https://hosamaadem-portfolio-6ujt.vercel.app/) | Delisted before grading | graders | not a portfolio / not a portfolio | not a portfolio / not a portfolio | 0 | - |  |
| [hozi-web3.site](https://hozi-web3.site) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://hozi-web3.site/ |
| [hsumeet.site](https://hsumeet.site) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://hsumeet.site/ |
| [hyperautomation.substack.com](https://hyperautomation.substack.com) | Graded not a portfolio | graders | not a portfolio / - | - / - | 5 | - |  |
| [iamharshdoshi.com](https://iamharshdoshi.com) | Graded not a portfolio | capture blocked | - / - | - / - | 1 | review (flagged) | 22 words and no outbound links |
| [iamridoydey.com](https://iamridoydey.com) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://iamridoydey.com/ |
| [ifeoluwa-portfolio-five.vercel.app](https://ifeoluwa-portfolio-five.vercel.app) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [ijlan.dev](https://ijlan.dev) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [ikabidev.app](https://ikabidev.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 1 | relist |  |
| [ilkeozs.info](https://ilkeozs.info) | Broken or dead, never graded | graders | portfolio / - | - / - | 5 | - |  |
| [indrajeet.me](https://indrajeet.me) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [iodev.io](https://iodev.io) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 2 | - |  |
| [irfan-devs.vercel.app](https://irfan-devs.vercel.app) | Delisted after grading | capture blocked | - / - | - / - | 4 | review (flagged) | 31 words and no outbound links |
| [itsmeabdur.in](https://itsmeabdur.in) | Graded not a portfolio | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://itsmeabdur.in/ |
| [itsnilesh.vercel.app](https://itsnilesh.vercel.app) | Broken or dead, never graded | capture blocked | - / - | - / - | 2 | review (flagged) | 0 words and no outbound links |
| [jacksonm.dev](https://jacksonm.dev) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 5 | - |  |
| [jakegines.in](https://jakegines.in) | Graded not a portfolio | capture blocked | - / - | - / - | 1 | review (flagged) | 31 words and no outbound links |
| [jatin-tekam.netlify.app](https://jatin-tekam.netlify.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [jayanth.site](https://jayanth.site) | Graded not a portfolio | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://jayanth.site/ |
| [jayvegad.vercel.app](https://jayvegad.vercel.app) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [jenulferdinand.dev](https://jenulferdinand.dev) | Graded not a portfolio | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://jenulferdinand.dev/ |
| [jeremiahhaastrup.com](https://jeremiahhaastrup.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [jerryhirsch.com](https://jerryhirsch.com) | Graded not a portfolio | capture blocked | - / - | - / - | 1 | review (flagged) | 7 words and no outbound links |
| [jhedmendoza.is-a.dev](https://jhedmendoza.is-a.dev) | Graded not a portfolio | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [jibanbudhathoki.com.np](https://jibanbudhathoki.com.np) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 4 | - |  |
| [johnborn.co.uk](https://johnborn.co.uk) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist | pressed Escape on a dialog |
| [jrs-studios.web.cern.ch](https://jrs-studios.web.cern.ch/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [juanbenito.vercel.app](https://juanbenito.vercel.app) | Broken or dead, never graded | capture blocked | - / - | - / - | 0 | review (flagged) | 3 words and no outbound links |
| [judicael-ahyi.com](https://judicael-ahyi.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [juhilkbhatt.com](https://juhilkbhatt.com) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [juncie.com](https://juncie.com) | Broken or dead, never graded | graders | portfolio / - | not a portfolio / not a portfolio | 4 | relist |  |
| [kalpsenghani.com](https://kalpsenghani.com) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [kamipresents.com](https://kamipresents.com) | Broken or dead, never graded | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [karanchhunchha.in](https://karanchhunchha.in) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [karrarnazim.space](https://karrarnazim.space) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 3 | - |  |
| [keerthana-raghu.vercel.app](https://keerthana-raghu.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [keithlau2015.github.io/portfolio](https://keithlau2015.github.io/portfolio) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [kenfack-me.vercel.app](https://kenfack-me.vercel.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [kgmyat.vercel.app](https://kgmyat.vercel.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [khangnd.info](https://khangnd.info) | Graded not a portfolio | capture blocked | - / - | - / - | 3 | review (flagged) | 11 words and no outbound links |
| [kidus.ca](https://kidus.ca) | Graded not a portfolio | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://kidus.ca/ |
| [kishormarasini.com.au](https://kishormarasini.com.au) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [kishorrj.vercel.app](https://kishorrj.vercel.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [kodr.pro](https://kodr.pro) | Broken or dead, never graded | graders | portfolio / - | - / - | 3 | - |  |
| [krishnananda.netlify.app](https://krishnananda.netlify.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [kritan560.github.io/portfolio](https://kritan560.github.io/portfolio/) | Delisted before grading | graders | not a portfolio / not a portfolio | not a portfolio / not a portfolio | 1 | - |  |
| [krushna.gridly.xyz](https://krushna.gridly.xyz) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://krushna.gridly.xyz/ |
| [kuldeepjadeja.dev](https://kuldeepjadeja.dev) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://kuldeepjadeja.dev/ |
| [kwamehdhegbo.com](https://kwamehdhegbo.com) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://kwamehdhegbo.com/ |
| [lalith-d-portfolio.netlify.app](https://lalith-d-portfolio.netlify.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [lin-stephanie.github.io](https://lin-stephanie.github.io) | Broken or dead, never graded | capture blocked | - / - | - / - | 1 | review (flagged) | 11 words and no outbound links |
| [linktr.ee/abdullahahsan](https://linktr.ee/abdullahahsan) | Graded not a portfolio | code rule | not a portfolio / - | not a portfolio / portfolio | 4 | - |  |
| [linktr.ee/drepin](https://linktr.ee/drepin) | Graded not a portfolio | code rule | not a portfolio / - | not a portfolio / portfolio | 6 | - |  |
| [linktr.ee/syedsyab](https://linktr.ee/syedsyab) | Graded not a portfolio | code rule | not a portfolio / - | not a portfolio / portfolio | 4 | - |  |
| [lisablunt.github.io](https://lisablunt.github.io) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist | clicked "enter" |
| [luispeche.vercel.app](https://luispeche.vercel.app/) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [lukecele-research.vercel.app](https://lukecele-research.vercel.app/) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [machado001.github.io](https://machado001.github.io) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [macos-kuldeeprajput.vercel.app](https://macos-kuldeeprajput.vercel.app) | Broken or dead, never graded | capture blocked | - / - | - / - | 3 | review (flagged) | still a gate or loader after the click-through |
| [maggioni.dev](https://maggioni.dev) | Graded not a portfolio | graders | not a portfolio / - | portfolio / not a portfolio | 3 | relist (flagged) |  |
| [mahg.me](https://mahg.me) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [mahin527.vercel.app](https://mahin527.vercel.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [mahin527.vercel.app](https://mahin527.vercel.app/) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [main.dodjas56cfa3.amplifyapp.com](https://main.dodjas56cfa3.amplifyapp.com) | Graded not a portfolio | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://main.dodjas56cfa3.amplifyapp.com/ |
| [majd-portfolio.framer.website](https://majd-portfolio.framer.website) | Graded not a portfolio | graders | portfolio / portfolio | portfolio / portfolio | 2 | relist |  |
| [manish-portfolio-gamma-henna.vercel.app](https://manish-portfolio-gamma-henna.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [manixh.vercel.app](https://manixh.vercel.app) | Broken or dead, never graded | graders | portfolio / - | - / - | 6 | - |  |
| [manojmandal.com](https://manojmandal.com) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [marcos-moura97.github.io](https://marcos-moura97.github.io) | Broken or dead, never graded | capture blocked | - / - | - / - | 2 | review (flagged) | 4 words and no outbound links |
| [marstruong.com](https://marstruong.com) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://marstruong.com/ |
| [matvey.codes](https://matvey.codes) | Broken or dead, never graded | graders | not a portfolio / - | portfolio / portfolio | 1 | relist (flagged) |  |
| [mbitu-portfolio.vercel.app](https://mbitu-portfolio.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [md-afjal-ansari.onrender.com](https://md-afjal-ansari.onrender.com) | Delisted after grading | capture blocked | - / - | - / - | 0 | review (flagged) | 2 words and no outbound links |
| [mdkhalidmahmud.com](https://mdkhalidmahmud.com) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://mdkhalidmahmud.com/ |
| [meesverberne.com](https://meesverberne.com) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [merox.dev](https://merox.dev) | Live, never graded | graders | portfolio / - | portfolio / portfolio | 5 | - |  |
| [mfatihdinc.com](https://mfatihdinc.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [mfaysal.com](https://mfaysal.com/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [michellebrenner.com](https://michellebrenner.com) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [missaelr.com/en](https://missaelr.com/en) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://missaelr.com/en |
| [mkishore.is-a.dev](https://mkishore.is-a.dev/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [mohitjoe.vercel.app](https://mohitjoe.vercel.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [mokhele.pythonanywhere.com](https://mokhele.pythonanywhere.com) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [mouraocode.com.br](https://mouraocode.com.br) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://mouraocode.com.br/ |
| [mrepol742.github.io](https://mrepol742.github.io) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [munyaradzimzite.vercel.app](https://munyaradzimzite.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [muse.ai/s/neel-patel-portfolio-tomas-style-xzxx6m5xtl3huxh/44rs8uC9gN1nl-HjxoLSA9T-gfn27ZKRX8RhxAimXuw](https://muse.ai/s/neel-patel-portfolio-tomas-style-xzxx6m5xtl3huxh/44rs8uC9gN1nl-HjxoLSA9T-gfn27ZKRX8RhxAimXuw) | Broken or dead, never graded | capture blocked | - / - | - / - | 0 | review (flagged) | 3 words and no outbound links |
| [mushfiq.xyz](https://mushfiq.xyz) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [my-portfolio-wkse.vercel.app](https://my-portfolio-wkse.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [mylivecv.com/mylivecv/pf-anubhav](https://mylivecv.com/mylivecv/pf-anubhav) | Broken or dead, never graded | capture failed | - / - | - / - | - | - | page.goto: Timeout 30000ms exceeded. |
| [n-cv.vercel.app](https://n-cv.vercel.app) | Delisted after grading | graders | not a portfolio / not a portfolio | not a portfolio / not a portfolio | 0 | - |  |
| [n4ryn.com](https://n4ryn.com) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://n4ryn.com/ |
| [nandaydas.in](https://nandaydas.in) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [naveenkumarm.space](https://naveenkumarm.space) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://naveenkumarm.space/ |
| [nicobachner.com](https://nicobachner.com) | Broken or dead, never graded | capture blocked | - / - | - / - | 2 | review (flagged) | 4 words and no outbound links |
| [nihir-mobile-portfolio.vercel.app](https://nihir-mobile-portfolio.vercel.app) | Graded not a portfolio | capture blocked | - / - | - / - | 3 | review (flagged) | 35 words and no outbound links |
| [nihir-mobile-portfolio.vercel.app](https://nihir-mobile-portfolio.vercel.app/) | Delisted before grading | capture blocked | - / - | - / - | 3 | review (flagged) | 35 words and no outbound links |
| [nikhilkumawat.netlify.app](https://nikhilkumawat.netlify.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [nischaldutt.netlify.app](https://nischaldutt.netlify.app) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [nishchayjain.vercel.app](https://nishchayjain.vercel.app/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [nitishkr.fun](https://nitishkr.fun) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [nja-systems.vercel.app](https://nja-systems.vercel.app/) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [notesc.netlify.app](https://notesc.netlify.app) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [nskr.dev](https://nskr.dev) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_CONNECTION_CLOSED at https://nskr.dev/ |
| [okhten.com](https://okhten.com) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [omkargadekar.vercel.app](https://omkargadekar.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist | pressed Escape on a dialog |
| [orazgulcayew.vercel.app](https://orazgulcayew.vercel.app) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [pabloramon.com.br](https://pabloramon.com.br) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://pabloramon.com.br/ |
| [palmeida.netlify.app](https://palmeida.netlify.app) | Graded not a portfolio | graders | portfolio / portfolio | portfolio / portfolio | 3 | relist |  |
| [pandiyancool.github.io/pandiyan.cool](https://pandiyancool.github.io/pandiyan.cool) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [parinithmavurapu.vercel.app](https://parinithmavurapu.vercel.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [parthh.in](https://parthh.in) | Graded not a portfolio | capture blocked | - / - | - / - | 3 | review (flagged) | 31 words and no outbound links |
| [pavithran26.net](https://pavithran26.net) | Live, never graded | same text | portfolio / - | portfolio / portfolio | 5 | review (flagged) |  |
| [pavithran26.vercel.app](https://pavithran26.vercel.app) | Delisted before grading | same text | portfolio / - | portfolio / portfolio | 5 | review (flagged) |  |
| [pavithran26.vercel.app](https://pavithran26.vercel.app/) | Delisted before grading | same text | portfolio / - | portfolio / portfolio | 5 | review (flagged) |  |
| [pepalonso.com](https://pepalonso.com) | Graded not a portfolio | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [phyominthein.com](https://phyominthein.com) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [pixeldania.netlify.app](https://pixeldania.netlify.app) | Graded not a portfolio | capture blocked | - / - | - / - | 4 | review (flagged) | 0 words and no outbound links |
| [portfolic.vercel.app/lalithdabilpuram01](https://portfolic.vercel.app/lalithdabilpuram01) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [portfolio-84ka.vercel.app](https://portfolio-84ka.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [portfolio-harin999s-projects.vercel.app](https://portfolio-harin999s-projects.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [portfolio-lilac-eight-33.vercel.app](https://portfolio-lilac-eight-33.vercel.app) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist | clicked "skip intro" |
| [portfolio-mti1.vercel.app](https://portfolio-mti1.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [portfolio-nu-lovat-90.vercel.app/project](https://portfolio-nu-lovat-90.vercel.app/project) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [portfolio-os-tau-five.vercel.app](https://portfolio-os-tau-five.vercel.app/) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [portfolio-site-two-virid.vercel.app](https://portfolio-site-two-virid.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [portfolio-syauqi.vercel.app](https://portfolio-syauqi.vercel.app) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [portfolio-website-bc28.vercel.app](https://portfolio-website-bc28.vercel.app) | Delisted before grading | capture blocked | - / - | - / - | 0 | review (flagged) | 6 words and no outbound links |
| [portfolio-website-bc28.vercel.app](https://portfolio-website-bc28.vercel.app/) | Delisted before grading | capture blocked | - / - | - / - | 0 | review (flagged) | 6 words and no outbound links |
| [portfolio.abhirai2006.workers.dev](https://portfolio.abhirai2006.workers.dev/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [portfolio.denil-dominic.com](https://portfolio.denil-dominic.com) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [portfolio.haresmohd012.workers.dev](https://portfolio.haresmohd012.workers.dev/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [portfolio.sanjivthapa.com.np/home](https://portfolio.sanjivthapa.com.np/home) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [portfoliojuanfranciscocisneros.web.app](https://portfoliojuanfranciscocisneros.web.app) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [prasada-dev.netlify.app](https://prasada-dev.netlify.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [prashantk.dev](https://prashantk.dev) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [prataya-portfolio.vercel.app](https://prataya-portfolio.vercel.app) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [premthatikonda.xyz](https://premthatikonda.xyz) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [premthatikonda.xyz](https://premthatikonda.xyz/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [prince-kumar-portfolio-five.vercel.app](https://prince-kumar-portfolio-five.vercel.app/) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [purnendusamanta.github.io/MyPortfolio](https://purnendusamanta.github.io/MyPortfolio/) | Broken or dead, never graded | capture blocked | - / - | - / - | 1 | review (flagged) | 0 words and no outbound links |
| [qazimaazarshad.github.io](https://qazimaazarshad.github.io/) | Delisted before grading | capture blocked | - / - | - / - | 6 | review (flagged) | still a dialog on top after the click |
| [rafalazar.github.io](https://rafalazar.github.io) | Broken or dead, never graded | graders | not a portfolio / not a portfolio | not a portfolio / not a portfolio | 5 | - |  |
| [raggiodev.vercel.app](https://raggiodev.vercel.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [rahnoxa.antideploy.com](https://rahnoxa.antideploy.com) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 3 | - |  |
| [rahulgurujala.is-a.dev](https://rahulgurujala.is-a.dev) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [rakesh.arcavio.com](https://rakesh.arcavio.com) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [rathodram.is-a.dev](https://rathodram.is-a.dev/) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [rathodram.pages.dev](https://rathodram.pages.dev/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [rathodram.vercel.app](https://rathodram.vercel.app) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [rathodramraj.vercel.app](https://rathodramraj.vercel.app) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [rebrand.ly/wilsonmun](https://rebrand.ly/wilsonmun) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [red1-for-hek-demo.vercel.app](https://red1-for-hek-demo.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [red1-for-hek.vercel.app](https://red1-for-hek.vercel.app) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [renjith.com](https://renjith.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [rhenzportfolio.vercel.app](https://rhenzportfolio.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [rimenesribeiro.com](https://rimenesribeiro.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [rishavkumar-portfolio.vercel.app](https://rishavkumar-portfolio.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [ritochabalala.github.io](https://ritochabalala.github.io) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [rituparnawarwatkar.com](https://rituparnawarwatkar.com) | Graded not a portfolio | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [rknastenka.com](https://rknastenka.com) | Graded not a portfolio | graders | not a portfolio / - | portfolio / portfolio | 5 | relist |  |
| [rohitsoni007.github.io/portfolio](https://rohitsoni007.github.io/portfolio) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [roshankrsoni.github.io](https://roshankrsoni.github.io) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [roshankunwar.com.np](https://roshankunwar.com.np) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [roshanparajuli.com.np](https://roshanparajuli.com.np) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [rsakib.com](https://rsakib.com) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://rsakib.com/ |
| [ryanyychen.github.io/portfolio](https://ryanyychen.github.io/portfolio) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [sagar-adulkar.vercel.app](https://sagar-adulkar.vercel.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [sahilbajajportfolio.vercel.app](https://sahilbajajportfolio.vercel.app) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [saidk.io](https://saidk.io) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | - |  |
| [sak03.github.io/sartaj.dev](https://sak03.github.io/sartaj.dev) | Delisted after grading | same text | portfolio / - | portfolio / portfolio | 6 | review (flagged) |  |
| [sakib-m.me](https://sakib-m.me/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [samadtalukder.com](https://samadtalukder.com) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | - |  |
| [samrinjaji.github.io/my-portfolio](https://samrinjaji.github.io/my-portfolio/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [samrinjaji.vercel.app](https://samrinjaji.vercel.app/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [samrit.dev](https://samrit.dev/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [sandeepmallick.github.io/sandeepportfolio](https://sandeepmallick.github.io/sandeepportfolio/) | Graded not a portfolio | graders | not a portfolio / - | portfolio / portfolio | 4 | relist |  |
| [sanjanavenkatesh.vercel.app](https://sanjanavenkatesh.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [sanyam.dev](https://sanyam.dev) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [sarfarosh.vercel.app](https://sarfarosh.vercel.app) | Graded not a portfolio | capture blocked | - / - | - / - | 2 | review (flagged) | 8 words and no outbound links |
| [sarfarosh.vercel.app](https://sarfarosh.vercel.app/) | Graded not a portfolio | capture blocked | - / - | - / - | 2 | review (flagged) | 8 words and no outbound links |
| [sartajalam.in](https://sartajalam.in/) | Delisted before grading | same text | portfolio / - | portfolio / portfolio | 6 | review (flagged) |  |
| [saswatamondal.me](https://saswatamondal.me) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://saswatamondal.me/ |
| [sauravmh.com](https://sauravmh.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [saytes.io](https://saytes.io) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [sebilune.dev](https://sebilune.dev) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://sebilune.dev/ |
| [sergei.com](https://sergei.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [sergiojimenez.vercel.app](https://sergiojimenez.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [setrathex.com.tr](https://setrathex.com.tr) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://setrathex.com.tr/ |
| [seunghun-website.vercel.app](https://seunghun-website.vercel.app) | Graded not a portfolio | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [shalon.vercel.app](https://shalon.vercel.app) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [shan-verse.com](https://shan-verse.com) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [shashikantportfolio.web.app](https://shashikantportfolio.web.app) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [shivamgarg82.github.io/Portfolio](https://shivamgarg82.github.io/Portfolio) | Graded not a portfolio | capture blocked | - / - | - / - | 2 | review (flagged) | 38 words and no outbound links |
| [shivesh1606.github.io/portfolio](https://shivesh1606.github.io/portfolio) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [shreyam1008.com.np](https://shreyam1008.com.np/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [shreyanshportfolio.in](https://shreyanshportfolio.in) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [shubhadeepsec.github.io](https://shubhadeepsec.github.io) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist | clicked "CLICK TO ENTER" |
| [shubhanshusingh.com](https://shubhanshusingh.com) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [sitham.dev](https://sitham.dev) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://sitham.dev/ |
| [slimaeus.github.io](https://slimaeus.github.io) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [sobolevn.me](https://sobolevn.me) | Graded not a portfolio | graders | not a portfolio / - | portfolio / not a portfolio | 5 | relist |  |
| [sohailkhan0525.github.io/MyPortfolio](https://sohailkhan0525.github.io/MyPortfolio) | Delisted before grading | graders | not a portfolio / - | not a portfolio / portfolio | 6 | - |  |
| [sohayelmahmud.github.io](https://sohayelmahmud.github.io) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [sonu-portfolio-1.netlify.app](https://sonu-portfolio-1.netlify.app) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [sonu-portfolio-1.netlify.app](https://sonu-portfolio-1.netlify.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [spee.dev](https://spee.dev) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [squidwardcodes.web.app](https://squidwardcodes.web.app) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 5 | - |  |
| [srianjaneyam.me](https://srianjaneyam.me) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [stimmie.dev](https://stimmie.dev) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [subratdwivedi.dev](https://subratdwivedi.dev) | Graded not a portfolio | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://subratdwivedi.dev/ |
| [sudosidd.dev](https://sudosidd.dev) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [suhail-shabir-portfolio.web.app](https://suhail-shabir-portfolio.web.app) | Broken or dead, never graded | capture blocked | - / - | - / - | 1 | review (flagged) | 0 words and no outbound links |
| [suhail-shabir-portfolio.web.app](https://suhail-shabir-portfolio.web.app/) | Delisted before grading | capture blocked | - / - | - / - | 1 | review (flagged) | 0 words and no outbound links |
| [sujeethsr.com](https://sujeethsr.com) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 2 | - |  |
| [sulayman-bowles.dev](https://sulayman-bowles.dev/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [suraj-yadav0.github.io/terminal-portfolio](https://suraj-yadav0.github.io/terminal-portfolio/) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [suryaa-portfolio-eight.vercel.app](https://suryaa-portfolio-eight.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [swaroop.codes](https://swaroop.codes) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://swaroop.codes/ |
| [syab.tech](https://syab.tech) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [syedomer.me](https://syedomer.me) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://syedomer.me/ |
| [tadashiamano.vercel.app](https://tadashiamano.vercel.app) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [tahahassan.vercel.app](https://tahahassan.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [talhakilic.com.tr](https://talhakilic.com.tr) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://talhakilic.com.tr/ |
| [tanishagupta1.github.io/Tanisha-Gupta-portfolio](https://tanishagupta1.github.io/Tanisha-Gupta-portfolio) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [tariqulislamrc.vercel.app](https://tariqulislamrc.vercel.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [tauqeerkhattak.github.io](https://tauqeerkhattak.github.io) | Broken or dead, never graded | capture blocked | - / - | - / - | 1 | review (flagged) | 0 words and no outbound links |
| [tauqeerkhattak.github.io](https://tauqeerkhattak.github.io/) | Delisted before grading | capture blocked | - / - | - / - | 1 | review (flagged) | 0 words and no outbound links |
| [techfolios.github.io](https://techfolios.github.io) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 4 | - |  |
| [tejafolio.dev](https://tejafolio.dev) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://tejafolio.dev/ |
| [tejafolio.dev](https://tejafolio.dev/) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://tejafolio.dev/ |
| [thea.juniorise.com](https://thea.juniorise.com) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [theavnishkumar.in](https://theavnishkumar.in) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | - |  |
| [thecodehead.com](https://thecodehead.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [thedanielmark.com](https://thedanielmark.com) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 4 | - |  |
| [thekaushikgoswami.github.io](https://thekaushikgoswami.github.io) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [thesimpanze.github.io/Portofolio-Rasyid](https://thesimpanze.github.io/Portofolio-Rasyid) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [thibault.sh](https://thibault.sh) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [thomas-david-portfolio.netlify.app](https://thomas-david-portfolio.netlify.app) | Graded not a portfolio | graders | not a portfolio / not a portfolio | not a portfolio / portfolio | 4 | - |  |
| [timmoth.com](https://timmoth.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [tmbond.com](https://tmbond.com) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [tonagnis.vercel.app](https://tonagnis.vercel.app/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [tsiry-sandratraina.com](https://tsiry-sandratraina.com) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [udaykhalsa.dev](https://udaykhalsa.dev) | Broken or dead, never graded | capture blocked | - / - | - / - | 1 | review (flagged) | 0 words and no outbound links |
| [vaishali-portfolio-nine.vercel.app](https://vaishali-portfolio-nine.vercel.app/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [vale.rocks/portfolio](https://vale.rocks/portfolio) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 3 | - |  |
| [vallarasuk.com](https://vallarasuk.com) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 2 | - |  |
| [vamsi-krishna-portfolio.vercel.app](https://vamsi-krishna-portfolio.vercel.app) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [varshilshah.tech](https://varshilshah.tech/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist | pressed Escape on a dialog |
| [vauth.github.io/hueco](https://vauth.github.io/hueco) | Graded not a portfolio | capture blocked | - / - | - / - | 0 | review (flagged) | 14 words and no outbound links |
| [vidu.sh/an](https://vidu.sh/an) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 2 | relist |  |
| [vikasdev-in.vercel.app](https://vikasdev-in.vercel.app) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [vikasdev-in.vercel.app](https://vikasdev-in.vercel.app/) | Delisted before grading | graders | not a portfolio / not a portfolio | not a portfolio / not a portfolio | 0 | - |  |
| [vinaykatikireddy.is-a.dev](https://vinaykatikireddy.is-a.dev) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [vinaysomawat.github.io](https://vinaysomawat.github.io) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [vivekchudasama-2004.github.io/portfolio](https://vivekchudasama-2004.github.io/portfolio) | Delisted after grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 1 | - |  |
| [wahab-khan.github.io/Abdul-Wahab-Khan](https://wahab-khan.github.io/Abdul-Wahab-Khan) | Broken or dead, never graded | capture blocked | - / - | - / - | 0 | review (flagged) | 0 words and no outbound links |
| [wasibsattar.com](https://wasibsattar.com) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [weskershek.com](https://weskershek.com) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [windows87.github.io](https://windows87.github.io) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [winehoused.github.io/my-portfolio](https://winehoused.github.io/my-portfolio) | Live, never graded | graders | portfolio / - | portfolio / portfolio | 6 | - |  |
| [wltweerasinghe.com](https://wltweerasinghe.com) | Graded not a portfolio | capture blocked | - / - | - / - | 5 | review (flagged) | still a dialog on top after the click |
| [www.7sadakonr.xyz](https://www.7sadakonr.xyz/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.abhishekg.com.np](https://www.abhishekg.com.np) | Live, never graded | capture blocked | - / - | - / - | 0 | review (flagged) | 6 words and no outbound links |
| [www.abhisheksah.dev](https://www.abhisheksah.dev) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 2 | - |  |
| [www.abhisheksharma.codes](https://www.abhisheksharma.codes/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [www.adamalston.com](https://www.adamalston.com) | Graded not a portfolio | graders | portfolio / not a portfolio | portfolio / portfolio | 4 | relist |  |
| [www.adhamdannaway.com](https://www.adhamdannaway.com) | Live, never graded | capture failed | - / - | - / - | - | - | page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.adhamdannaway.com/ |
| [www.adpandey.com](https://www.adpandey.com) | Delisted before grading | graders | not a portfolio / - | - / - | 1 | - |  |
| [www.akshatvg.com](https://www.akshatvg.com) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [www.ali-ch.dev](https://www.ali-ch.dev) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.anandhasivam.indevs.in](https://www.anandhasivam.indevs.in) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [www.arsh.dev](https://www.arsh.dev) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.arsh.dev/ |
| [www.avinash-singh.in](https://www.avinash-singh.in) | Live, never graded | graders | portfolio / - | portfolio / portfolio | 5 | - |  |
| [www.ayodeleayoola.com](https://www.ayodeleayoola.com) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | - |  |
| [www.ayushdoesdev.in](https://www.ayushdoesdev.in/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.badhon.online](https://www.badhon.online) | Live, never graded | graders | not a portfolio / - | portfolio / portfolio | 5 | - |  |
| [www.baqirnaqvi.dev](https://www.baqirnaqvi.dev/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [www.bechirlahoueg.tech](https://www.bechirlahoueg.tech) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.bechirlahoueg.tech/ |
| [www.benoldham.dev](https://www.benoldham.dev) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 3 | - |  |
| [www.beterbekend.nl](https://www.beterbekend.nl) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 2 | - |  |
| [www.bluezly.exid.me](https://www.bluezly.exid.me) | Live, never graded | graders | portfolio / - | portfolio / portfolio | 5 | - |  |
| [www.bobmatyas.com](https://www.bobmatyas.com) | Live, never graded | capture blocked | not a portfolio / - | not a portfolio / not a portfolio | 0 | review (flagged) | a bot or security check stood in for the site |
| [www.borcarazvan.tech](https://www.borcarazvan.tech/) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [www.caesarcode.com.mx/index.html](https://www.caesarcode.com.mx/index.html) | Live, never graded | graders | portfolio / - | portfolio / portfolio | 5 | - |  |
| [www.caiovisuals.com](https://www.caiovisuals.com) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [www.chan-stephane.me](https://www.chan-stephane.me) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [www.chicagoitsystems.com](https://www.chicagoitsystems.com) | Live, never graded | capture failed | - / - | - / - | - | - | page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.chicagoitsystems.com/ |
| [www.chrisryczke.com](https://www.chrisryczke.com) | Live, never graded | capture blocked | - / - | - / - | 3 | review (flagged) | 23 words and no outbound links |
| [www.cmanage.dev](https://www.cmanage.dev) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 4 | - |  |
| [www.daljeetsingh.me](https://www.daljeetsingh.me) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.daljeetsingh.me/ |
| [www.daniel-michael.com](https://www.daniel-michael.com) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | - |  |
| [www.danielsteele.dev](https://www.danielsteele.dev) | Live, never graded | graders | portfolio / - | portfolio / portfolio | 6 | - |  |
| [www.darrellroberts.com](https://www.darrellroberts.com) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | - |  |
| [www.derekchen.dev](https://www.derekchen.dev) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | - |  |
| [www.devanshuverma.in](https://www.devanshuverma.in/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [www.dilipmaurya.in](https://www.dilipmaurya.in) | Live, never graded | capture blocked | - / - | - / - | 1 | review (flagged) | 15 words and no outbound links |
| [www.erdaltaskesen.com](https://www.erdaltaskesen.com) | Broken or dead, never graded | graders | not a portfolio / - | portfolio / portfolio | 4 | relist |  |
| [www.garlicbread.space](https://www.garlicbread.space) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 5 | - |  |
| [www.hafsasalman.com](https://www.hafsasalman.com/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.hienlnt.id.vn](https://www.hienlnt.id.vn/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [www.hitaarthh.com](https://www.hitaarthh.com/) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.hungrybearstudios.com](https://www.hungrybearstudios.com) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 4 | - |  |
| [www.iamdanilo.com](https://www.iamdanilo.com) | Live, never graded | graders | portfolio / - | portfolio / portfolio | 4 | - |  |
| [www.joaoprestes.dev](https://www.joaoprestes.dev) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 4 | relist |  |
| [www.johnclaytonblanc.com](https://www.johnclaytonblanc.com) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | - |  |
| [www.johnsonsiziba.com](https://www.johnsonsiziba.com) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: Timeout 30000ms exceeded. |
| [www.kktp.my](https://www.kktp.my/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [www.kumar-nishant.me](https://www.kumar-nishant.me) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.kumar-nishant.me/ |
| [www.linabrihoum.com](https://www.linabrihoum.com/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.masirjafri.in](https://www.masirjafri.in) | Live, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | - |  |
| [www.mohsinraz.me](https://www.mohsinraz.me) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.mohsinraz.me/ |
| [www.mritunjoy.online](https://www.mritunjoy.online) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.mritunjoy.online/ |
| [www.mujtabasaqib.com](https://www.mujtabasaqib.com) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [www.mujtabasaqib.com](https://www.mujtabasaqib.com/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [www.nareshkhatri.site](https://www.nareshkhatri.site) | Delisted before grading | capture blocked | - / - | - / - | 1 | review (flagged) | 13 words and no outbound links |
| [www.nyambogahezron.dev](https://www.nyambogahezron.dev) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.nyambogahezron.dev/ |
| [www.patrickhyatt.com](https://www.patrickhyatt.com) | Graded not a portfolio | graders | not a portfolio / - | portfolio / portfolio | 5 | relist |  |
| [www.rapidtech1898.com](https://www.rapidtech1898.com) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [www.rickygipson.com](https://www.rickygipson.com/) | Delisted before grading | graders | portfolio / portfolio | portfolio / portfolio | 3 | relist |  |
| [www.robert.hase-zheng.net](https://www.robert.hase-zheng.net) | Delisted after grading | capture blocked | - / - | - / - | 4 | review (flagged) | 36 words and no outbound links |
| [www.rubangino.ca](https://www.rubangino.ca) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.saakethj.in](https://www.saakethj.in) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.saakethj.in/ |
| [www.sajjadsoykot.me](https://www.sajjadsoykot.me/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.sathwiky.dev](https://www.sathwiky.dev) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [www.saurabhdaware.in](https://www.saurabhdaware.in) | Delisted after grading | capture blocked | - / - | - / - | 0 | review (flagged) | 4 words and no outbound links |
| [www.sayanadhikary.me](https://www.sayanadhikary.me) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_CONNECTION_CLOSED at https://www.sayanadhikary.me/ |
| [www.seniordevelopermnelisi.com](https://www.seniordevelopermnelisi.com) | Delisted before grading | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [www.shaankhan.dev](https://www.shaankhan.dev) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [www.shubhamgupta.dev](https://www.shubhamgupta.dev/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [www.stimmie.dev](https://www.stimmie.dev) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.sudevmagar.tech](https://www.sudevmagar.tech) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_CONNECTION_REFUSED at https://www.sudevmagar.tech/ |
| [www.sugatrajsarwade.com](https://www.sugatrajsarwade.com/) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.sushantmondal.com](https://www.sushantmondal.com/) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [www.techinz.dev](https://www.techinz.dev) | Graded not a portfolio | graders | not a portfolio / - | portfolio / portfolio | 3 | relist (flagged) |  |
| [www.tiagocreator.com](https://www.tiagocreator.com) | Graded not a portfolio | graders | not a portfolio / - | portfolio / portfolio | 1 | relist (flagged) |  |
| [www.trixum.net](https://www.trixum.net) | Graded not a portfolio | graders | portfolio / - | portfolio / portfolio | 3 | relist |  |
| [www.vivekjaiswal.me](https://www.vivekjaiswal.me) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [www.welcomedeveloper.com](https://www.welcomedeveloper.com) | Live, never graded | graders | portfolio / not a portfolio | portfolio / portfolio | 3 | - |  |
| [xamarth.pp.ua](https://xamarth.pp.ua) | Delisted before grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://xamarth.pp.ua/ |
| [xqyet.dev](https://xqyet.dev) | Graded not a portfolio | graders | not a portfolio / - | not a portfolio / not a portfolio | 0 | - |  |
| [yakshcore.vercel.app](https://yakshcore.vercel.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 4 | relist | pressed Escape on a dialog |
| [yakshcore.vercel.app](https://yakshcore.vercel.app/) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 4 | relist | pressed Escape on a dialog |
| [yakshdevani.framer.website](https://yakshdevani.framer.website) | Delisted after grading | graders | portfolio / portfolio | portfolio / portfolio | 5 | relist |  |
| [yash1200.github.io](https://yash1200.github.io) | Broken or dead, never graded | capture blocked | - / - | - / - | 1 | review (flagged) | 0 words and no outbound links |
| [yashitanamdeo.github.io](https://yashitanamdeo.github.io) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [yath.dev](https://yath.dev) | Broken or dead, never graded | graders | portfolio / portfolio | portfolio / portfolio | 6 | relist |  |
| [ybz.vercel.app](https://ybz.vercel.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 6 | relist |  |
| [yeabsiras-portfolio.vercel.app](https://yeabsiras-portfolio.vercel.app) | Broken or dead, never graded | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [yocrrz.is-a.dev](https://yocrrz.is-a.dev) | Delisted after grading | graders | portfolio / - | portfolio / portfolio | 4 | relist |  |
| [yodkwtf.com](https://yodkwtf.com) | Live, never graded | graders | portfolio / - | portfolio / portfolio | 6 | - |  |
| [yogeshpaliyal.com](https://yogeshpaliyal.com) | Graded not a portfolio | graders | portfolio / not a portfolio | portfolio / portfolio | 5 | relist |  |
| [yogiveloper.com](https://yogiveloper.com) | Delisted after grading | capture failed | - / - | - / - | - | - | page.goto: net::ERR_NAME_NOT_RESOLVED at https://yogiveloper.com/ |
| [https:omargpax.vercel.app](https:omargpax.vercel.app) | Delisted before grading | graders | portfolio / - | portfolio / portfolio | 5 | relist |  |
| [https\://shreyanshportfolio.in](https\://shreyanshportfolio.in) | Delisted before grading | capture failed | - / - | - / - | - | - | Invalid URL |

## Appendix B: method

The sites: every row of portfolios without tier membership (owner removals left out; there were none), in five groups: graded not a portfolio, delisted after grading, delisted before grading, broken or dead never graded, and live never graded.
The capture (GitHub Actions, no AI): desktop 1440x900 and phone 390x844, the splash click-through, a dialog closed with its primary button or Escape, a mode-picker click, up to 15 seconds for content and one retry; only the screens after a click are stored. 32 sites were captured again after the dialog fixes (#218).
Never graded: a capture still showing a gate, a dialog or a bot check, or under 40 words with no outbound links.
Code: the portfolio signals of the full page, and the narrow rules (unedited placeholders, parked pages, code-host and link-in-bio addresses; templates are fine).
The graders: prompt portfolio-definition-v2.1 (the locked two-sets prompts with the owner's definition in STEP 3), Gemini 3.1 Flash-Lite at temperature 0.2 and thinking "low", Haiku 5.5 at its defaults; the same 83 batches of 5 for both, the last filled up from the first.
The decision: both models' batched answers. Two "no" answers stand; where the models disagree, the strong-signals guard (4 or more signals) keeps a one-model "no" from removing a site. The same text on another domain sends a site to a person only when a model calls it a portfolio.
Raw data stays local in ~/research/portfoliorank-experiments/recheck-543 and in the workflow artifacts.
