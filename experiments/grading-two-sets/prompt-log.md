# Gemini prompt log: Grading test (two sets)

Written by Claude Opus 5.5, the prompt writer, on 2026-11-13, before any expert answer existed and before any Gemini request.
I have not read, and will not read, anything under `~/research/portfoliorank-experiments/grading-two-sets/expert/`.
The prompts are `prompts/solo.txt` (one site), `prompts/batch.txt` (5 sites) and `prompts/schema.json` (the response schemas and the level lines).
Their hashes are in `lock.json`.

## What one request holds

- The system instruction: `solo.txt` or `batch.txt`, as written, nothing added at run time.
- The user turn, per site and in this order: a label line, the desktop screenshot, a label line, the phone screenshot, then one `<site_data>` block.
  In a batch the labels and the block carry the site's label (`site_1` to `site_5`), and the 5 sites follow each other in the order of `groupings.json`.
- The `<site_data>` block is `facts (measured by code, JSON):`, the bundle's `facts.json`, `page_text:` and the bundle's `text.txt`.
  Both files were cleaned of `site_data` markers and control characters, and emails and phone numbers were redacted (`pipeline/redact.mjs`), when the bundles were built, so the expert and Gemini see the same bytes.
- Settings: `gemini-3.5-flash-lite`, temperature 0.2, thinking "low", JSON output with the schema, at most 8,192 output tokens for one site and 32,768 for five.
- The request is built only from the bundle and the prompt files, with no timestamp or run id, so a repeat is byte-identical to the first request (the harness checks the hash).

## Choices, and why

### The rubric is copied, not paraphrased

The level lines in the prompt and in the schema enum are character-for-character the lines of `rubric.txt`, which is the plan page's rubric.
The expert gets the same lines.
Any paraphrase would make a disagreement ambiguous: is it the model, or my wording?

### Reason first, then the level line, then the score

The schema orders each part as `evidence`, `level_line`, `score`, and Gemini fills fields in schema order.
The evidence is written before any number exists, so the number follows from what was seen rather than the reverse.
`level_line` is an enum of the five exact lines, which forces the model to commit to a described level before writing the number.
The score is then nearly redundant, but the plan asks for it, and a level line that does not match the score is logged as a sign of confusion (it is not an error).
In the first grading test, thinking "low" with reason-first fields was the steadiest mode (retest Spearman 0.94).

### "Most portfolios are a 3; a 5 is rare"

The first test found a pile-up of 4s and 5s.
The anchor sentence is the plan's own wording, with the expert's rule beside it: a 5 only when every point of the level-5 line holds, and "do not soften" for 1s and 2s.
I added one line that each part is judged on its own evidence, because a striking design tends to lift every score (a halo effect), which would also hurt the spread rule.

### The checklist is answered per view

Each of the four questions has `seen` (a quote, or "nothing"), then `desktop`, then `phone`.
The plan says the checklist is judged at the top of the page on desktop and on phone, and the phone view is where heroes most often lose the role or the links.
Answering per view keeps that information; the analysis counts a question as yes only when both views say yes (written into `pass-rules.json`), and also reports each view.
I gave concrete yes and no examples for questions 2 and 4, because those are the two judged by the model and the two with a pass rule.
"5+ years of experience" and "passionate" are named as not notable, since those are the most common generic claims.

### The facts are context, confirmed against the screenshots

Code measured the name in the title and top heading, the links in the first screen on each view, broken project links, a resume link anywhere, and a template match.
The prompt explains each field in one line, says to use them, and says the screenshots show what a visitor sees.
That matters for `way_forward`: code counts a visible link, but a link in a closed menu is not visible, and a link styled to look like text may be missed by code.
`template_match` is described as "not a fault by itself", because otherwise a template name would drag down visual design for sites that customised it.

### Page text is untrusted

Everything inside `<site_data>`, and any words in the screenshots, is called third-party data, never instructions, with examples of what an injection would ask.
The redaction tokens `[email]` and `[phone]` are explained, so the model does not read them as placeholder text and mark the site as an unedited template.

### is_portfolio comes after the scores, with a reason first

The plan orders it after the three scores.
I widened the expert's definition by a few words ("or someone else's content", "for-sale"), because the two junk sites in this test are an AI-chat template showing its demo persona, and a clone of a template shown under a different name is a known pattern in the library.
This is a small difference from the expert's instructions, made on purpose, and it should only help the junk check.

### Tips last

One tip per part, at most 20 words, naming what to change on this site, empty when the score is 5.
They come after every judgment, so writing a tip cannot pull a score.

### The batch prompt

`batch.txt` is `solo.txt` with two changes: the "what you get" section describes five labelled sites, and a section says to grade each site as if it were alone, never to compare, rank or spread the scores, and never to let one site's evidence touch another's.
I removed the old batch prompt's `order` field (rank the 5 sites): asking for a ranking in the same answer invites the model to spread the scores to match it, which is exactly the batch drift the first test found.
Every site's two screenshots come right before its own block, so the model never has to match images to text across the request.

## Amendment, 2026-11-13, after the solo step

The first 5-at-a-time request (pass1/A-b1) was refused with HTTP 400 INVALID_ARGUMENT, with no detail.
The 40 solo requests before it had all been answered.
The model allows 65,536 output tokens (the request asked for 32,768) and the five sites' images total about 576 KB, so the likely cause is the batch response schema: five copies of the answer, each with three long enum lists of level lines.
Decision (coordinator, option 1): `level_line` becomes free text in the batch schema only; code still checks it against the rubric (a "5:" prefix, quotes, case and spacing are ignored) and logs a mismatch.
The prompts and the rubric wording are unchanged.
The solo schema is unchanged, so the solo-repeat step stays an identical repeat of the original solo requests.
Because the solo answers used the enum and the batch answers do not, "batch vs solo" now mixes a schema change into the batch effect.
To measure that change alone, 10 Gemini-only requests were added after all other steps (step `solo-freetext`): the same 10 sites as the solo-repeat step, the same solo prompt, with the free-text `level_line` schema (prompt id `grade-two-sets-solo-freetext`).
Comparing solo-freetext with solo, next to solo-repeat with solo, separates the schema effect from run-to-run noise.
The expert's instructions are unchanged: its output format never had an enum.
Planned Gemini requests: 42 used before the amendment, 1 test (pass1/A-b1 again), 41 remaining and 10 controls, 94 in all, inside the hard stop of 120.
The new hashes are in `lock.json`, under `amendments`.

## Amendment, 2026-11-13: Claude Sonnet 5.5 through the API

Owner-approved: Set A's 20 one-at-a-time requests also go to `claude-sonnet-5-5` through the Claude API (`scripts/experiments/grading-two-sets-claude.mjs`, run by the owner).
It gets exactly `prompts/solo.txt` as the system prompt, the same user content in the same order (desktop screenshot, phone screenshot, the `<site_data>` block), and the solo schema as JSON Schema through `output_config.format`.
The conversion drops what structured outputs do not take (`minimum`, `maximum`, item counts, property ordering) and closes every object; the level-line enums stay, so this is the locked solo schema, not the free-text one.
Effort and thinking are left at the model's defaults (both omitted) and recorded as such; temperature is not sent (the model rejects non-default sampling settings).
No refusal fallback is enabled, so every answer comes from Sonnet 5.5 itself; a refusal stops the run.
A hard stop at $0.75, checked before each request with the exact input from `count_tokens`, keeps the cost bounded.
Because the expert is also Sonnet, this column separates the prompt and setting from the model: same model, Gemini's prompt, structured output, a fresh request per site.

## Amendment, 2026-11-13: a second Claude Sonnet 5.5 API run

Owner-approved, about $1.40 more: the Sonnet API column extends to Set B one at a time (20), pass 1 of both sets (8 batches of 5, `prompts/batch.txt` with the free-text batch schema) and the 10 solo-repeat sites, in that order.
Each repeat is byte-identical to this model's own first solo request for that site (checked against the first run's raw requests for the 5 Set A sites).
The request content is built from Gemini's request part for part, so both models get the same text and images in the same order.
The hard stop is a cumulative $2.00 across both runs, counting the first run's $0.4980.
A 4xx that mentions a spend or usage limit or credit stops the run as a separate outcome, with its status, error type, message and the running total recorded; this run also tests whether the owner's $1 monthly spend limit counts promotional-credit use.

## Owner amendment, 2026-11-13: prompt version "portfolio-definition-v2"

A new prompt version for the mini tests and re-checks, not for the locked two-sets comparison, whose prompts stay as they are.
`experiments/portfolio-definition-v2/solo.txt` and `batch.txt` are the locked prompts with only the is_portfolio section (STEP 3) replaced by the owner's definition, word for word.
The closing instruction "Give the reason first, then the answer." is kept, because the answer shape still puts the reason first.
`schema.json` there is a copy of the locked one: the batch schema with the free-text level line, the solo schema with the enum, and the same answer shape.
Prompt ids for the request log: `portfolio-definition-v2-solo` and `portfolio-definition-v2-batch`.
The new section:

> A portfolio is a page that introduces a person and points to their work. It is a portfolio if it shows (1) who they are, a name or clear personal identity (stylized or spaced-out letters count), (2) what they do (developer, engineer, designer, and so on), and (3) a way to their work: a Projects button or link, a GitHub link, project links or a resume. A weak portfolio is still a portfolio: no projects shown on the page, a blog-first homepage, or projects only behind a link are low scores and tips, not a reason to say false. is_portfolio is false ONLY for: parked or for-sale domains; unedited placeholders (demo names like 'Aaaaby', 'John Doe', or someone else's content); pages that are not about a person (a company or studio site, a bare code repository, a link-in-bio page like Linktree); broken, blank or error pages.

**Amendment, the same day: batches of fewer than 5.**
The batch prompt and schema are written for exactly 5 sites ("Five different portfolio websites, labelled site_1 to site_5", 5 items in the schema).
On mini7's 2-site batch, Gemini 3.1 answered 5 sites twice (both answers rejected, the run paused).
For a batch of 2 to 4 sites, the four sentences that name the count now follow n ("Two different portfolio websites, labelled site_1 to site_2", "The other site is not a reference point", "Both sites may get the same scores", "in order from site_1 to site_2"), and the schema's item count and site labels follow n (`batchFor` in `grading-two-sets-run.mjs`).
A batch of 5 is byte-identical to before, in both prompt versions.
Haiku's mini7 batch 2 had already run with the five-site wording; it answered the 2 sites correctly, and that answer is kept as evidence if the batch is re-sent.

What I expect: far fewer "not a portfolio" answers on thin but real pages (one-screen menus, blog-first homes), and the junk check now rests on the named exclusions, so a template demo persona other than the examples may still pass.

## Owner amendment, 2026-11-13: prompt version "portfolio-definition-v2.1"

The owner's decision: only the exclusions decide whether a page is a portfolio.
Reason: in mini7, under v2, abhisheksharma.codes shows a name, a Projects button and GitHub but no role.
The v2 wording both required a role ("It is a portfolio if it shows ... (2) what they do") and said false "ONLY" for the exclusions.
The code-only check followed the first half and said no; Haiku followed the second ("No role is stated, but no exclusion applies") and said yes.
v2.1 removes the conflict: is_portfolio is true unless an exclusion applies, the three signs feed the checklist, scores and tips only, and a missing role is never a no.
Files: `experiments/portfolio-definition-v2.1/solo.txt` and `batch.txt`, which are the v2 files with only the STEP 3 paragraph replaced; `schema.json` is a byte copy of v2's (and of the locked one).
Prompt ids for the request log: `portfolio-definition-v2.1-solo` and `portfolio-definition-v2.1-batch`.
v2 stays in place for the runs already made on it (mini7).
The code-only check in `scripts/experiments/mini7.mjs` now follows v2.1: it says no only for an exclusion code can see (an error or blank page, a parked page, a demo or placeholder name, a link-in-bio host, a code repository host), and reports the three signs without letting them decide; a company or studio site needs judgment, so code never says no for that.
On mini7's seven bundles it now agrees with both models on all seven (the only no is the Streamlit error page); no model was run again.
The new STEP 3 paragraph, word for word:

> is_portfolio is true unless one of these exclusions applies: a parked or for-sale domain; an unedited placeholder (demo names like 'Aaaaby' or 'John Doe', or someone else's content); a page that is not about a person (a company or studio site, a bare code repository, a link-in-bio page like Linktree); a broken, blank or error page. The three signs of a portfolio, (1) who they are, a name or clear personal identity (stylized or spaced-out letters count), (2) what they do (developer, engineer, designer, and so on), and (3) a way to their work (a Projects button or link, a GitHub link, project links or a resume), feed the checklist, the scores and the tips only. A missing sign, a missing role included, is never a reason to say false: a weak portfolio is still a portfolio, with low scores and tips. Give the reason first, then the answer.

## Note, 2026-11-13: a possible v2.2 wording (not a prompt change)

Nothing in the prompts changes with this note; v2.1 stays the current definition.
In the 543 re-check (exp/recheck-543, owner verdicts in `experiments/recheck-543/owner-verdicts.json` at e529231), Gemini 3.1 and Haiku disagreed on 7 sites.
The owner sided with Gemini's "not a portfolio" on 5 personal blogs that Haiku called portfolios (armujahid.me, maggioni.dev, matvey.codes, www.tiagocreator.com, damianmarkowski.com), and called andy-bell.design not a portfolio too; www.techinz.dev he judged a weak portfolio, so it is relisted.
So for the owner a personal blog with no work shown is not a portfolio, which v2.1 does not say: its exclusions are only parked or for sale, placeholders, pages not about a person, and broken pages.
Haiku follows v2.1's wording here; Gemini 3.1 matches the owner's intent.
A possible v2.2 exclusion, to be decided and tested before any use: "a personal blog with no way to the person's work is not a portfolio".
It would sit with the other exclusions and keep "a weak portfolio is still a portfolio", so a blog that does link to projects, GitHub or a resume stays a portfolio.

## Mini test 8, 2026-11-13: prompt version "portfolio-definition-v2.1-projects" (version B)

Owner-approved test "what the grader sees": the same 10 sites, the same definition (v2.1), graded twice with everything else equal.
Version A sends what the grader gets today: the desktop and phone first screens and the page text, with the v2.1 prompts unchanged (`experiments/portfolio-definition-v2.1/`).
Version B adds one or two desktop screens of the Projects section, cut from the tall desktop image (found from the outline's projects heading; the second screen when there is none), with `experiments/portfolio-definition-v2.1-projects/`.
That folder is v2.1 with two changes only, in both solo and batch prompts:
- under WHAT YOU GET, one new line saying what the extra screenshots are, that they serve project presentation, visual design and writing, and that the five-second checklist is still about the top of the page only;
- the project_presentation line now says the projects screenshots count above all.
The schema is a byte copy, so both versions answer in the same shape.
Each extra screenshot is labelled in the request, right after the phone screenshot ("projects section, screen 1 of 2 (desktop, 1440 wide, cut from the whole page)" or "the second screen of the page (no projects heading found)").
Prompt ids: `portfolio-definition-v2.1-solo` and `portfolio-definition-v2.1-batch` for A, `portfolio-definition-v2.1-projects-solo` and `portfolio-definition-v2.1-projects-batch` for B.
Why I wrote B this way: the extra screens are evidence, not a new rule, so the definition and the rubric stay word for word; the one sentence keeps the checklist on the first screen, because a grader who sees projects lower down could otherwise answer "way forward" or "something notable" from them.
How B's screens are cut (fixed before the lock): the projects heading is the first heading below the top one, by position, that names the projects by the excerpt's rule (`PROJECTS_RX`, plus "what I build", which that rule misses), a heading ending in "projects" or "work" first; two screens of 900 px from 24 px above it when the page has room, else one; with no such heading, the second screen of the page; with a one-screen page, nothing (then B equals A).
On the 10 sites: 3 have a projects heading (d2yap.github.io "PROJECTS", shubhadeepsec.github.io "MY WORK", luispeche.vercel.app "What I Build", two screens each), 3 get the second screen (heysai.dev, vallarasuk.com, anish7.me), and 4 are one screen tall on desktop (agney.dev, abhisheksharma.codes, shashikantportfolio.web.app, shubhamgupta.dev), so B adds nothing for them.

What I expect: project presentation moves most (up on sites whose projects are below the fold and only named in the text, down where the screenshots show thin tutorial work); visual design moves a little; the portfolio verdict barely moves, since under v2.1 only the exclusions decide; Haiku moves more than Gemini 3.1, which leans on text.

## Amendment, 2026-11-13: the day cap

The run paused at pass2/A-b3 because the model's requests this Pacific quota day reached the harness's day cap of 430 (376 from the first grading test, 54 from this run; the free quota is 500).
Decision (coordinator): raise the day cap to 485 for this run.
Reason: production has sent no Gemini request since 2026-11-12T23:18Z (the freeze holds), checked in `gemini_requests` at the time of the decision, so the only requests today are the two experiments, and 485 still leaves 15 of the 500.
The run's own hard stop of 120 HTTP requests is unchanged.
If the cap is reached again, the run pauses and resumes after the 08:00Z quota reset.
Nothing about the requests themselves changes.

## What I expect to go wrong

- **Scores still bunch at 3 and 4.** The anchor fights the 4s-and-5s pile-up, but Flash-Lite may overcorrect into all 3s, which passes the spread rule and fails agreement on the strong and weak sites.
- **Visual design on phone.** The phone screenshot is the top of the page only; a phone layout that breaks further down will not be seen by either grader.
- **Project presentation when the projects are below the fold.** Both graders see only the two tops plus the text, so project presentation rests on the text excerpt.
  Where the projects section was not found, both graders may disagree about whether "no projects shown" (a 1) applies.
- **Writing judged on a 4,000-character excerpt.** Long pages are cut, so writing reflects the top, the projects section and some of the rest.
- **The checklist on phone.** Gemini may say yes from the text rather than from the phone screenshot, especially for the role, which is often in the text but hidden by a phone hero.
- **The junk site in Set B is the same kind as Set A's.** Both are the "Hey, I'm Aaaaby" AI-chat template, so the junk check tests one kind of junk twice.
- **Batches drift.** The first test found batch grades about 0.2 lower than solo grades and not interchangeable site by site; removing the ranking should reduce this, but I expect some drift to remain.
- **Position effect.** The first site in a batch may be anchored on; three passes with rotated positions will show it if it is consistent.
- **Level line and score mismatches.** Rare, but each one is logged.
- **Set A's facts are from today and its images from 13 November.** If a site changed in between, the first-screen links may not match the screenshots.
