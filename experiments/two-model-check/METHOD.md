# Two-model check: method, fixed before any model answer was seen

Written 2026-11-23, after the split was made and before the first model request.
Experiment only: nothing here changes the product, and no site is visited.

## The question

Does a better prompt, given the code's findings and the page's text as well as the screenshot, asked of two different models, with action only when both agree, beat code alone?
By how much, and at what cost?

## Inputs

Only the saved copy of the 2026-11-23 benchmark (`~/projects/ops/handoffs/portfolio-rank/files/`): `benchmark-portfolio-or-not.json` and `benchmark-pages/<site>/` (`render-0.jpg`, `rendered.txt`, `rendered.html`, `record.json`).
Every model sees exactly the same bytes, and every answer is cached on disk keyed by a hash of the model, the system prompt, the request text, the image and the repeat number, so a rerun costs nothing.

## The split

`split.json` (seed 20261124, mulberry32): the 309 labelled sites (the 3 unsure ones left out), stratified by label class, kind and whether the code left the site listed (keep or flag) or not, each stratum shuffled and halved.
Design half 154, held-out half 155.
The held-out half has 72 real portfolios (all listed by code), 26 non-portfolios (18 listed by code) and 57 dead sites (5 listed by code).
I may look at answers on the design half and revise the prompt.
The held-out half is run once with the final prompt; those are the numbers that count.

The models are asked only about sites the browser rendered (a screenshot or a page text).
The 57 dead sites with no render cannot be shown to a model; in the combined system the code's health check already hides them.
One real site (dorlugasigal.netlify.app) has text but no screenshot; the picture-only arms skip it.

## The request

- The screenshot (`render-0.jpg`, the first screen at 1280x800).
- The finished page's visible text (`rendered.txt`), emails and phone numbers replaced with the repository's own `redactContacts` (`pipeline/redact.mjs`), blank runs folded, cut at 4,000 characters (production's cut).
- A plain block of what the code found, written as facts: the listed address and where it ended up; the HTTP status; the page title; the health check's verdict; which of the six signals were found and which were not; any junk, address or parking rule that matched; the visible text length; the text length of the finished HTML with hidden parts included; how often the visible text changed while the page settled and its length at first and at the last change (the saved settle samples, the closest the data has to "still on an intro").
- Not included: the label, its evidence, the old AI verdict, the code's outcome (keep, flag, pool, remove) or anything derived from them.
- The name and address from the list, as production sends them.

## The answer

Structured output (Gemini `responseSchema`, Claude `output_config.format` JSON schema): `reason` first (at most 40 words), then `answer` (portfolio, not_portfolio, cannot_tell), `cannot_tell_why` (intro or gate, too little to see, error page, or none) and `kind` (for not a portfolio).
"Cannot tell" never counts as a no.

## The models

- Google Gemini `gemini-3.5-flash-lite` (production's `PRIMARY_MODEL`, `pipeline/gemini.mjs`), with production's settings: temperature 0.2, thinking level minimal.
- Anthropic Claude Haiku 5.5 (`claude-haiku-5-5`), effort low, adaptive thinking.
  Departure from the brief: Claude Haiku 5.5 rejects any non-default temperature (HTTP 400), so it runs at its default sampling; "low effort" is its nearest lever.
- Each model answers independently; neither sees the other's answer.
- Stability: both models answer the full request a second time (repeat 2) on a fixed sample of 60 held-out sites (`stabilitySample`, seed 20261125).

## The arms (held-out half)

| Arm | Prompt | Screenshot | Page text | Code facts |
|---|---|---|---|---|
| old | production's old `is_portfolio` line (main `pipeline/rubric.mjs`), yes or no | yes | no | no |
| pic | the new prompt | yes | no | no |
| text | the new prompt | yes | yes | no |
| full | the new prompt | yes | yes | yes |

The brief asked for old, text and full.
I added `pic` so the prompt's own effect (old to pic), the text's (pic to text) and the code facts' (text to full) are each one step.

## Scoring (held-out half, each with a count and a Wilson 95% interval)

Per arm and per model, and for the two models together (a double no):
- real portfolios answered "not a portfolio";
- non-portfolios answered "portfolio" or "cannot tell" (both are misses);
- dead sites: how each was answered;
- how often the two models disagree, and on what.

The combined system the owner would run: the code decides what it can prove (its pool and remove outcomes stand), the two-model check is asked only about the sites the code leaves listed (keep and flag), and a site is removed only when both models answer "not a portfolio".
It is set beside code alone on the same held-out half: real portfolios hidden or removed, non-portfolios left listed, dead sites left listed.
Every site the double-no rule would wrongly remove is named with its full address and both models' reasons, and every non-portfolio it still leaves listed is named.

What counts as "clearly helps", fixed now: on the held-out half, the combined system removes at least a quarter of the non-portfolios the code leaves listed and wrongly removes no real portfolio.
With 72 real portfolios, zero wrong removals still allows a true rate up to about 5% (the upper end of the interval), and that is said with the result.

## Cost

Tokens from each provider's usage figures (Gemini `usageMetadata`, thinking included; Claude `usage`), priced at Gemini 3.5 Flash-Lite $0.30 in and $2.50 out per million (the repository's `pipeline/gemini-log.mjs` paid rate) and Claude Haiku 5.5 $0.10 in and $0.50 out per million.
Per site per model, the experiment's total, and projections for a list of about 2,150 sites and for 30 new sites a day.

## Limits

At most 3,000 model requests in all (every HTTP attempt counts, retries included, in `ledger.jsonl`), at most 4 in flight, stop at $15 of measured spend.

## Prompt history

Every version stays in `prompts.mjs`.

- v1 (2026-11-23, before any answer): written from the owner's definition and rulings in the brief, `PORTFOLIO_RULE` on `origin/feat/gemini-three-outputs`, and the 2026-11-13 lessons (reason first; a weak portfolio is still a portfolio; an intro screen is not a no; the owner's call that a personal blog with no work is not a portfolio).
  Design half, full arm: no real portfolio got a double no (0 of 71); the combined system left 8 of 27 non-portfolios listed (code alone: 18).
  Gemini called two real sites plain blogs (andrew.codes has a resume link; vidu.sh/an is a blog with an about blurb); Haiku answered "cannot tell (too little to see)" on pages it had fully seen: a link-only page on the person's own domain (devlato.com), a hobbies page (matvey.codes), a "this site has moved" notice (akhshyganesh.github.io); and it called a GitHub profile README a portfolio.
- v2 (frozen as the final prompt before the held-out run): four additions to the rules, nothing removed.
  A personal site with a resume link, a work history or an experience section counts as a digital resume even with a blog.
  A code-host profile is not a portfolio even when its README lists projects.
  A page that is only an avatar or handle and social or contact links is a link page, on the person's own domain too.
  A personal page about hobbies or life with no technical work, and a page that only says the site moved, are not portfolios (kind other).
  Design half, full arm: still 0 of 71 real portfolios with a double no; the combined system leaves 4 of 27 non-portfolios listed (three near-empty pages both models call "cannot tell", and nicobachner.com).
  I stopped here: the four left are pages where "cannot tell" is defensible under the brief's rule, and pushing the models to say no on near-empty pages would also hit near-empty real portfolios such as ericc.vercel.app.
