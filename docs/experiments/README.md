# Experiments

Results of five finished experiments, kept here after their pull requests were closed.
Each paragraph gives the question, the result as the experiment's own write-up states it, the date and the closed pull request.
All five ran on 2026-11-13 and none was merged.

## Junk detection (closed PR #212)

Can code alone, with no AI, tell real portfolios from junk?
The rules from the brief were right on 80% of a 100-site hand-labelled sample, which is what "call everything real" scores, and caught 1 of 19 junk sites.
A narrowed set of rules was never wrong in the test but catches only about a quarter of the junk, so code can safely remove a few obvious cases and the rest still needs the AI or a person.
`pipeline/junk-rules.mjs` on main uses that narrowed set.
Files: `junk-detection/README.md`, `results.md`, `labels.json`, `rules.mjs`.

## Grading test, two sets (closed PR #206)

Can Gemini 3.5 Flash-Lite grade developer portfolios like an expert, repeatably, and in batches of 5?
Gemini is within one point of the expert on 18 to 20 of 20 sites for every score, and batching does not change its scores more than asking twice does.
It fails five of the seven locked pass rules: too many 5s, writing scored about 0.7 points higher than the expert, both junk sites missed when graded one at a time, answers to an identical request change too often, and the judgment-based five-second questions match on only 14 to 17 of 20.
The write-up recommends keeping AI scores off the report card until a revised prompt passes the rules on the same two sets.
Files: `grading-two-sets/` (write-up, the `mini5`, `mini7` and `mini8` result pages, locked inputs, expert run log, prompt log and the three `portfolio-definition-v2*` prompt sets).

## Meta tags, structured data and fonts (closed PR #201)

Can plain code reliably check a home page for share and search tags, structured data, fonts, crawl files, analytics and web basics, and what would WebP save over JPEG screenshots?
On 100 sampled portfolios, checked by hand on 25, meta tags came out at 100% precision and 97% recall, while the font count was exact on 21 of 25 and the font rule had 60% recall.
Meta tags and structured data are reliable enough to become automatic checks; font findings should stay a tip.
WebP at quality 75 is 44% smaller than JPEG q75.
Files: `meta-schema-fonts/README.md` and `data/summary.json` (the large `data/sites.json` stayed on the branch).

## Grading experiment, rubric v3 (closed PR #185)

Does a new rubric, batches of 5 or richer evidence grade better than the current setup?
None of the three pre-set rules passed: rubric v3 does not agree with the answer key more than v2 (Spearman 0.74 against 0.77), batches of 5 rank as well as solo grading but their scores are not interchangeable, and richer evidence did not help and costs 70% more input tokens.
Follow-ups showed that thinking "low" made v3 the steadiest mode measured.
Files: `grading-v3/grading-experiment.md`, `answer-key.json` (the 40-site answer key) and `key-notes.txt` (the reason recorded for each key entry).

## Strategy after the November audits (closed PR #152)

This is a plan document, not an experiment.
It set the P0 to P5 order of work after six audits, and fresh-eyes.md records it as approved on 2026-11-13.
It is kept as `docs/audits/STRATEGY-2026-11-13.md` with a note at the top that Staging, Gemini's role and how ranks are set have all changed since; `docs/DECISIONS.md` is the source of truth.
