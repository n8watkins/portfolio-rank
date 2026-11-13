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
