# Junk detection test

Question: can code alone, with no AI, tell real portfolios from junk, and how accurate is it?
The goal was a measured accuracy close to 99% before code rules are allowed to mark a site "not a portfolio".

Short answer: no.
The rules from the brief are right on 80% of the sample, which is exactly what "call everything real" scores.
They catch 1 of 19 junk sites.
A narrowed set of rules is never wrong in this test, but it only catches about a quarter of the junk.
Code can safely remove a few obvious cases, and the rest still needs the AI or a person.

## What was done

All data came from the production Turso DB, read only, on 2026-11-13.
No AI API was called, nothing was written to production, and no browser was pointed at the site.

1. `export.mjs` copies the `portfolios` table (2401 rows) to `local/all.json`, which is not committed.
2. `sample.mjs` draws a fixed-seed sample (seed 20261113) into `sample.json`.
   It has 20 sites graded not-a-portfolio by gemini-3.1-flash-lite, 20 graded not-a-portfolio by gemini-3.5-flash-lite, 20 sites delisted after a "yes, portfolio" grade, and 40 random sites that are ranked today.
3. Each site was labelled by hand from its stored desktop and phone screenshots plus its stored page text.
   The labels were made blind: sites were shown in a shuffled order (`blind-order.json`) with no group, model or AI verdict.
   The labels went into `labels.json` and were committed before any rule ran.
4. `rules.mjs` holds the rules as pure functions over the stored fields.
5. `evaluate.mjs` scores the rules and writes `results.md` and `results.json`.
6. Because the sample holds only a handful of rule hits, every row in the whole DB that any rule flags (45 rows) was also labelled from its screenshots (`hit-labels.json`).
   That gives each rule's precision over everything it would act on.
   These labels were made after the rules ran, so they are not blind to the rule output.

Label meanings: REAL is a real person's portfolio, even if sparse, odd, or behind an intro.
JUNK is an unedited template or placeholder, a parked or for-sale page, an empty page, a copy of another domain's page, or a page that is not a person's portfolio (a company, a blog only, an app, a repo, a link-in-bio page).
UNSURE is used when the screenshots do not show enough to decide.

One label was changed after the audit, and the change is recorded in the file.
red1-for-hek.vercel.app looked real in its screenshot, but the audit showed it is a copy of redoyanulhaque.me listed under another person's name.

## Labels

The sample has 77 REAL, 19 JUNK and 4 UNSURE.
All 19 junk sites are in the not-a-portfolio group.
All 20 delisted sites and 39 of the 40 ranked sites are real.

## The rules from the brief

| Rule | What it checks |
|---|---|
| (a) | `facts.template` is set, or the text has a known template string such as "Build your AI portfolio" or "Hey, I'm Aaaaby" |
| (b) | The same normalised page text (letters only, 20 words or more) appears on another domain anywhere in the DB |
| (c) | A placeholder name (Aaaaby, John Doe, Jane Doe, Your Name, Lorem ipsum and similar) in the name or the first 300 characters |
| (d) | Parked or for-sale wording, or "coming soon" with under 50 words |
| (e) | Under 30 words and no outbound links (no project link, no GitHub link, no contact link in `facts`) |
| (f) | Guard: `signals.score` of 4 or more means real unless (a) to (d) hit |

## Results on the sample (96 labelled, UNSURE left out)

| Rule | Caught | Wrong | Missed | Precision | Recall | Accuracy |
|---|---|---|---|---|---|---|
| (a) template | 0 | 1 | 19 | 0% | 0% | 79.2% |
| (b) same text elsewhere | 0 | 0 | 19 | n/a | 0% | 80.2% |
| (c) placeholder name | 0 | 0 | 19 | n/a | 0% | 80.2% |
| (d) parked | 1 | 0 | 18 | 100% | 5.3% | 81.3% |
| (e) short, no links | 0 | 0 | 19 | n/a | 0% | 80.2% |
| Combined, with the (f) guard | 1 | 1 | 18 | 50% | 5.3% | 80.2% |
| Baseline: call everything real | 0 | 0 | 19 | n/a | 0% | 80.2% |

## Precision over every row each rule flags in the whole DB

| Rule | Flagged | Junk | Real | Unsure | Precision |
|---|---|---|---|---|---|
| (a) | 11 | 4 | 7 | 0 | 36% |
| (b) | 2 | 1 | 1 | 0 | 50% |
| (c) | 6 | 3 | 1 | 2 | 75% |
| (d) | 3 | 1 | 2 | 0 | 33% |
| (e) | 26 | 0 | 24 | 2 | 0% |
| Combined, with the (f) guard | 44 | 7 | 33 | 4 | 18% |

Used as a gate, the brief's combined rules would have removed 33 real portfolios to catch 7 junk sites.

## Why the rules miss

Half of the sample has no stored page text or facts at all (50 of 100 rows).
None of the 20 delisted rows and 68 of the 132 not-a-portfolio rows have page text, so text rules cannot see them.
7 of the 19 junk sites in the sample are in that blind half.

The junk that does exist is mostly the wrong kind of page, not a template or a parked domain.
In the sample it is blogs with no portfolio (5), GitHub repos or a Linktree (3), company sites (2), a calculator app, an admin login page, a "this page has moved" stub, a joke 301 page, a coming-soon page, an essay page, an empty placeholder, a copy of another site and one parked domain.
Word lists and word counts cannot tell a blog or a company site from a portfolio.

Each brief rule also hits real sites:

- `facts.template` fires on real people who started from a template and made it their own (7 of 11 hits are real).
- "parked" appears in normal copy, and "coming soon" can be a widget on a full site.
- "your name" matched "repo in your name" on a freelancer's site.
- Under 30 words almost always means an intro gate, a loader or a terminal-style page, not junk (0 of 26 hits are junk).
  The (f) guard does not help, since nearly all of these have a low score because the capture saw only the intro.
- The same text on two domains flags both copies, including the original owner.

## Recommended rule set

Use code only for the cases that were never wrong in this test, and send everything else to the AI or a person.

1. Template strings, exact: "Build your AI portfolio", "Hey, I'm Aaaaby".
   Do not use `facts.template`.
2. Placeholder names, exact: Aaaaby, John Doe, Jane Doe.
   Treat lorem ipsum as "needs review", not junk, since both lorem ipsum hits were a real name on a half-edited site.
3. Parked wording, exact phrases: "has expired and is parked", "domain is for sale", "buy this domain", "make an offer on this domain".
   Do not use the bare word "parked" or "coming soon".
4. A new URL rule: the listed URL is on github.com, gitlab.com, linktr.ee or a similar link hub, or its path is /admin or /login.
5. Same text on another domain goes to review, not straight to junk, because one of the copies is the original.
6. Drop the word-count rule (e) and the (f) guard.

On the sample this set catches 5 of 19 junk sites with no real site wrong: 100% precision, 26% recall, 85.4% accuracy.
Over the whole DB it marks 20 rows junk and 2 for review.
Of the 20, the 9 that were labelled are all junk.
The other 11 are GitHub repos, GitHub profiles and Linktree pages that were not opened.
Whether a GitHub profile counts as a portfolio is a policy call (the one in the sample was marked UNSURE).
These numbers are optimistic, because the narrowing and the URL rule were chosen after seeing this sample.
Check them on a fresh sample before trusting them as a gate.

A 99% accuracy target is not reachable by code alone on this data.
The narrowed rules can still be a safe first filter that saves AI calls on the obvious cases.

## The AI's not-a-portfolio verdicts

Of the 40 sampled is_portfolio=0 grades, 19 look wrong (real portfolios), 18 look right and 3 are unsure.

- gemini-3.1-flash-lite: 11 of 20 are real portfolios (55%), 3 unsure.
- gemini-3.5-flash-lite: 8 of 20 are real portfolios (40%).

The wrong ones are mostly sparse or gated portfolios: a loading screen, an intro gate, a terminal or desktop-style page, or a short landing page with links.

## Follow-ups worth doing

- Store page text and facts for every row, including the ones captured before facts existed, so code rules can see them at all.
- `meta.domHash` is set on most rows that lack page text and shows 13 cross-domain clusters.
  Some are real copies, and some are shared error or bot-check pages, so it needs its own audit before use.
- Re-test the narrowed set on a fresh sample, seeded differently, before it gates anything.

## Files

| File | What it is |
|---|---|
| `export.mjs` | Read-only export of the table to `local/all.json` (gitignored) |
| `sample.mjs` | Draws the fixed-seed sample into `sample.json` |
| `blind-order.json` | Shuffled order used for blind labelling (blind id to sample id) |
| `labels.json` | Hand labels for the 100 sample sites, with a one-line reason each |
| `hit-labels.json` | Hand labels for the 45 rows any rule flags in the whole DB |
| `hits.json` | Those 45 rows and which rules hit them |
| `rules.mjs` | The rules, the recommended narrowed set and the URL rule |
| `evaluate.mjs` | Scores everything and writes `results.md` and `results.json` |

Reproduce with `node experiments/junk-detection/export.mjs`, then `node experiments/junk-detection/evaluate.mjs`.
A fresh export reflects the DB on that day, so counts can drift.
