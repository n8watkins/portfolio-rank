# Blog engine audit

A read-only architecture review of the content engine, dated 2026-11-12.
Code was read on `feat/blog-owner-feedback` at `ba254ac`.
`preview/staging-all` has the same writer and checks and differs only in `facts.mjs` and the library view.
Data comes from read-only Turso queries on `portfolio-rank-staging` (`content_runs`, `posts`, `gemini_requests`, `image_library*`, `pexels_searches`).
No code was changed and no Gemini calls were made.
The same review, with charts and tables, is at https://claude.ai/artifact/AYnRKg3vPam4qrgeDbc4LW.

The goal is one or two good posts a week, built from PortfolioRank's own data, that link real portfolios, using as few Gemini requests as possible and passing on the first try.

## Verdict

- Of 16 generated draft attempts on staging, 0 passed: 12 were dropped, 1 failed and 3 were deferred because Google was busy.
- The word count failed in 17 of 21 check rounds, and it was the final reason in 8 of the 9 drafts that reached the checks.
  Failing bodies were 224 to 480 words, against a target of 500 to 800 and later 700 to 1,000.
- Revisions do not converge.
  Each one rewrites the whole post, fixes one check and breaks another, and the word count barely moves.
- The final model review was never reached, and neither were the image stage and Pexels.
- Recommendation: code builds the outline, the callout, the TL;DR scaffold, Try this and the layout.
  Gemini writes the prose in one plain-text call.
  Code then checks and repairs it, with at most one small fix call and one review.
  That is about 2 to 3 requests a post, against 8 to 10 now.

## Measurements

| Measure | Value |
| --- | --- |
| Generated drafts that passed | 0 of 16 (13 from "Write a draft now", 3 from the draft step) |
| Average Gemini requests spent on each draft in the revision loop | 9.3 (range 9 to 10, capped by budget) |
| Check rounds that failed on word count | 17 of 21 |
| Content request attempts answered with HTTP 503 | 77 of 140 (3.5 Flash-Lite failed on 62 of its 83 attempts) |
| Content answers that came from the 3.1 Flash-Lite fallback | 40 of 61 |
| Model reviews, image checks, Pexels searches reached | 0 |

Runs 14 to 16 (2026-11-13 02:12 UTC) have no rows in staging `gemini_requests`, so their Gemini log was written somewhere else, probably by the local experiment.

## Current pipeline

This is the staged writer (`WRITER_MODE=staged`, the default) in `pipeline/content/engine.mjs` and `pipeline/content/staged.mjs`.

| Step | Who | Requests |
| --- | --- | --- |
| Pick: score the ready builders for interest, topic and tone | Gemini | 1 a week |
| Fact sheet: 14 to 35 facts with placeholders, names, notable facts, ties, examples, charts, screenshots | Code | 0 |
| Outline, with one retry if the structure check fails, then a drop (this dropped 4 of 13 manual runs) | Gemini | 1 to 2 |
| Sections, one request each (3, 4 or 5) | Gemini | 3 to 5 |
| Finish: re-emits the whole post as JSON, and the body shrinks to about 350 to 480 words | Gemini | 1 |
| List outside claims, Tavily, judge | Gemini | 1 to 2 |
| 12 code checks | Code | 0 |
| Revise up to twice: whole-post rewrite plus claims again | Gemini | 3 to 4 each |
| Final review (never reached on staging) | Gemini | 1 |
| Images: chart or screenshot, library, Pexels plus a check, Workers AI plus a check, fallback | Code and Gemini | 0 to 3 |

A first-try pass costs 8 to 12 requests.
A draft that fails costs 9 to 10 and is dropped.

### Tokens per stage

These are approximate, matched by the shape of each request.

| Stage | Input tokens | Output tokens | Note |
| --- | --- | --- | --- |
| Outline | 3.6k to 4.0k | 0.8k to 1.0k | 3.1 sometimes adds 1.6k to 2.9k thinking tokens; one answer hit MAX_TOKENS |
| Section | 1.4k to 2.7k | 0.14k to 0.85k | often well under the 200 to 260 words asked for |
| Finish or revise | 4.9k to 5.6k | 1.0k to 1.35k | the whole post as JSON, with the body as one escaped string |
| Claim list | 0.8k to 1.1k | 4 to 120 | usually returns an empty list |
| Whole draft | about 15k to 25k | about 4k to 7k | tokens are cheap here; requests and 503s are the real cost |

## Failure analysis

Each check below is counted by the rounds it failed, across the 21 check rounds of the 9 drafts that got past the outline.

| Check | Rounds failed | What it means |
| --- | --- | --- |
| Word count (template) | 17 | Flash-Lite writes about 350 to 480 words into a JSON field whatever the target. It is fatal for 8 of 9 drafts. |
| Payoff in the first 150 words | 8 | A rule about placement. Code can guarantee it if the takeaway is its own field. |
| Paragraph sizes | 6 | Paragraphs of 5 or 6 sentences, or single sentences. Code can split or merge these safely. |
| Layout (Try this, subheads, image markers, hero) | 6 | Pure structure that the model should never have to produce. |
| Tie wording (callout and superlatives) | 6 | The top-grades notable fact reads "the biggest lead ... (a tie)", which invites the superlative the check then fails. |
| Stray numbers or unknown placeholder | 3 | A real model error, but code can cut the sentence instead of rewriting the post. |
| Substance (tier letters, uncovered TL;DR) | 3 | A TL;DR built by code from section facts removes half of these. |
| Actions link | 1 | Code can attach the example link. |

### Root causes

1. Length is asked of the model in the wrong place.
   Three sections are written, then the finish call re-emits them inside one JSON string next to every other field, and they shrink.
   Each revision is another whole-post JSON rewrite, so the length never recovers: one draft went 457, 376, 224 words and another 379, 376, 471.
2. Structure is generated, then checked.
   The headings, Try this, the callout, the image markers, the hero placement and the TL;DR coverage are all deterministic.
   Every one of them is a way for the model to fail, and every failure costs a full rewrite.
3. Revision is a whole-post rewrite with a long list of failures.
   A Lite model fixing seven problems at once in a 1,000-token JSON answer trades one failure for another.
   The rounds show this: numbers fixed while paragraphs broke, the callout fixed while superlatives broke.
4. The fact sheet sets traps.
   Labels go to the writer as-is, and a notable fact says "biggest lead" about a tie.
   Code should hand the writer finished, correct clauses, including the tie wording.
5. The quota is spent on gates that rarely fire.
   The prompt already forbids outside claims, and the claim lister mostly returns nothing, yet it costs 1 to 2 requests a round plus Tavily credits (14 searches across runs 14 to 16).
   The pick call scores builders that are all on topic by construction.

### Bugs found on the way

- `writer.mjs` `buildReviseRequest` hardcodes "700 to 1,000 words (under 665 or over 1,050 fails)", so a medium or long draft is revised toward the wrong length.
- `scorecard.mjs` flags Short or Long against the standard `WORDS`, not the post's own length profile, so every long post would be held for review.
- `LENGTHS.short` (850 to 1,150 words) is longer than `standard` (700 to 1,000 words).
- `facts.mjs` `topGrades` notable text says "the biggest lead ... (a tie)".
- 3.5 Flash-Lite answered 503 on 75% of attempts around 08:00 Pacific.
  A 503 wastes minutes but no quota; at night the error rate may be lower, which is worth checking before blaming prompts.

## Pexels and images

- Images only run after a draft passes, so no generated post on staging has reached them.
  `image_library_uses` and `pexels_searches` are both empty.
- Even after a pass, Pexels is close to unreachable.
  The library comes first, and `rankLibrary` accepts any approved image with one overlapping tag (score of 1 or more).
  The 12 approved images carry broad tags ("data", "leaderboard", "growth", "learning", "careers"), and the post's own tags count as well, so a hero brief like "leaderboard, climbing, growth" always matches.
- In the proposed drafts, the inline slots were chart or screenshot (filled by code) and only the hero was a picture, so each post has about one slot that could ever reach Pexels.
- This review did not check whether `PEXELS_API_KEY` is set on staging; the path does nothing without it.
- Recommendation: keep charts and screenshots in code.
  For the hero, use the library only when the match score is 2 or more.
  Otherwise make one Pexels search, choose the candidate by code (landscape, no people for the hero) and run one Gemini image check.
  Take the fresh Workers AI illustration out of the post path and make it an offline library-filling job that the owner approves.
  Then a post costs 0 image requests most weeks and 1 at most.

## Proposed pipeline

Code owns everything that is deterministic, and Gemini writes only prose.
Checks repair what is safe to repair, and only content problems go back to the model, one paragraph at a time.

| Step | Who | Requests |
| --- | --- | --- |
| Pick: rotate the ready builders, least recently published first, owner's queued topic first | Code | 0 |
| Fact sheet with finished clauses and pre-worded ties; each builder declares its section plan | Code | 0 |
| Outline, callout, Try this scaffold and image slots from the plan | Code | 0 |
| Write: plain-text Markdown with delimited blocks (titles and meta, TL;DR, opener, takeaway, sections, steps, closing); long posts in 2 calls | Gemini | 1 to 2 |
| Assemble sections verbatim, place the takeaway, split or merge paragraphs, cut bad sentences, add links, run the checks; length is a soft gate below 85% of the minimum | Code | 0 |
| Targeted fix of the failing paragraphs only, if needed | Gemini | 0 to 1 |
| One review: topic, tone, names, voice, plus the outside-claim sentences for code to cut | Gemini | 1 |
| Images: charts and screenshots, a strong library match, else one Pexels search and one check | Code and Gemini | 0 to 1 |

| | Today | Proposed |
| --- | --- | --- |
| Requests, first-try pass | 8 to 12 | 2 to 3 |
| Requests, failing draft | 9 to 10 | 3 to 4 |
| Requests a week (2 posts, 1 retry) | about 30, and 117 spent on staging for 0 posts | about 8 |
| First-try pass rate | 0% measured (0 of 16) | 60 to 75% estimated |
| Pass rate with the one fix call | 0% | about 85% estimated |

How the estimate is built: layout, Try this, image markers, callout, TL;DR coverage, actions links, tie wording and paragraph sizes become code's responsibility, and together these made up about 21 of the 46 failed checks.
The word-count failure mostly goes away once code assembles the sections verbatim and length is a soft gate.
What is left is model-dependent: a weak hook or takeaway, a stray number, voice.
That is the 25 to 40% that the single fix call and the review are for.
Replay 10 recorded fact sheets before trusting these numbers.

For the write call, consider a non-Lite Flash model with its own free quota, since it is only 1 to 2 calls a week; check its RPD in AI Studio first.

## What to delete or change

Status as of 2026-11-13, on `feat/blog-owner-feedback` (#131), tested with a mocked Gemini only: the owner has asked for no Gemini spending until the audits are done.

| Piece | Action | Why | Status |
| --- | --- | --- | --- |
| `pipeline/content/staged.mjs` (outline, sections, finish, `OutlineError`), `WRITER_MODE` | Delete | Replaced by the code outline and one plain-text write call. It caused 4 outline drops and the length loss. | Done: deleted, with `WRITER_MODE` in `wrangler.jsonc` and the Worker types. |
| Most of `SYSTEM_INSTRUCTION` (about 30 rules) and the structural fields of `RESPONSE_SCHEMA` | Shrink | Keep the voice, naming, topic and placeholder rules. The shape rules become code. | Done: both deleted; the writer's rules are `compose.mjs` `WRITE_SYSTEM` (11 lines), and the shape comes from `plan.mjs`. |
| `buildReviseRequest` and the `MAX_REVISIONS=2` whole-post loop | Delete | Replaced by at most one paragraph-scoped fix call. | Done: one fix call that rewrites only the failing blocks (`compose.mjs` `blocksToFix`). |
| `claims.mjs` list, Tavily and judge in the default path; `tavily-credits.mjs`, `TAVILY_*` caps | Off by default | Posts come from our data. The review flags outside claims and code cuts them. This is the owner's gate 2, so the owner has to decide. | Done, as decided: the list request is gone; the review lists outside claims, and only those go to Tavily and the judge (`checkClaims` `flagged`). The caps stay. |
| Pick request (`buildPickRequest`, `choosePicks`) | Delete | Every builder is on topic by construction, so code rotation is enough. | Open: still 1 request a week. |
| Fresh Workers AI illustration in the post path | Move | Make it an offline library job with owner approval. | Done: posts pass no Workers AI binding; the hourly library job still makes images for approval. The hero takes a library image only on 2 or more shared tags, else one Pexels search. |
| `checkLinksLoad` every round | Once | Links come from the sheet, so load them once per draft. | Done: once, before the review. |
| Code checks, `fill`, placeholders, naming rule, scorecard, `storePost`, caps, kill switch | Keep | This is the part that works. Every number comes from code. | Kept. Added: `clauses.mjs` (finished sentences, ties pre-worded), `plan.mjs`, code repairs, length as a soft gate below 85% of the minimum. |
| Bugs: revise length text, scorecard length, `short` profile, tie wording | Fix | See "Bugs found on the way". | Done: the scorecard and checks follow the post's profile (short 500 to 750, standard 700 to 1,000, medium 1,200 to 1,600, long 1,800 to 2,200); a tied lead reads "X and Y tie for the biggest lead". |
| Replay harness | Build | Measure every step on the same recorded sheets. | Done: `scripts/content-replay.mjs` on 10 staging sheets in `tests/fixtures/content-replay`, with a mock, a recorded replay or a guarded live Gemini (`CONTENT_REPLAY_LIVE=1`). Live runs wait for the owner's approval. |

## Action plan for the blog lane

1. Build a replay harness first.
   Save the fact sheets of the staging drafts (stored in `posts.facts`) as fixtures, along with a script that runs the writer against them with a recorded or live Gemini.
   Every later step is measured on the same 10 sheets: pass rate, requests and words.
2. Fix the cheap bugs in place: the revise length text, the scorecard length profile, the `short` profile, and the tie wording in the top-grades notable fact.
3. Move structure into code.
   Add a `plan` to each builder (section subheads, facts per section, an example per section, the callout fact, image slots).
   Assemble the TL;DR scaffold, callout, Try this links, CTA and markers in code.
   Keep the current checks; most of them will start passing by construction.
4. Replace the staged and single writes with one plain-text write using delimited blocks, with a much shorter system instruction.
   Code places the sections verbatim.
   Measure the words per section on the fixtures and set the length profiles to what the model actually delivers, plus the soft gate.
5. Add safe code repairs (split or merge paragraphs, cut bad sentences, place the takeaway) before the checks, then the single paragraph-scoped fix call.
6. Collapse the gates.
   Turn the claims pipeline off by default (owner decision) and let the review flag outside claims for code to cut.
   Delete the pick call.
   Then delete `staged.mjs`, the revise loop and `WRITER_MODE`.
7. Images: raise the library match threshold for the hero, give it a single Pexels search and check, and move fresh illustrations offline.
   Run one passed draft end to end on staging so the image path is finally exercised.
8. Try the writer model on the fixtures: Flash-Lite against the non-Lite Flash for the one write call, and keep whichever gives the better pass rate and quality for 1 to 2 calls a week.
   Schedule drafts away from the 08:00 Pacific 503 window.
