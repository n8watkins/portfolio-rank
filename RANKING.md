# Ranking v2: OpenSkill leaderboards

How PortfolioRank's new leaderboards are computed, approved by the owner on 2026-11-10.
The method, its settings and every comparison are open, so anyone can recompute the boards and get the same result.

Status: built and tested, not switched on.
The live `/top` page still shows the ELO board from the `ratings` table, and the daily vote job still casts ELO votes.
The switch happens with the redesign (see "Switching it on" below).

## The idea in one paragraph

Every site has a rating with two numbers: a mean (how good it seems) and an uncertainty (how sure we are).
A site starts from its AI grade, so it is roughly in the right place on day one.
Every comparison, by a person or by the AI, moves the sites in it: a lot when they are unsure, a little when they are settled.
The AI compares about 100 pairs a day, mostly between sites with similar ratings, favouring the ones it is least sure about.
When a site's page changes, its uncertainty resets so it can move fast again.

## Engine

- OpenSkill (Weng-Lin ratings), Plackett-Luce model, through the [`openskill`](https://github.com/philihp/openskill.js) package (MIT).
- It rates one-on-one results and whole ranked groups (one request ranking several sites) with the same model, which Glicko-2 cannot.
- Scale: OpenSkill's defaults, mean 25, uncertainty (sigma) 25/3, beta 25/6, tau 25/300.
- The code is in `lib/ranking/` (`engine.mjs`, `views.mjs`), the numbers in `lib/ranking/config.mjs`.

## Seeding from the AI grade

| Tier | Starting mean |
| :-: | ---: |
| S | 33 |
| A | 29 |
| B | 25 |
| C | 21 |
| D | 17 |

- Tiers are 4 points apart, about one beta: once settled, a site one tier up wins a one-on-one about 62% of the time, and an S beats a D about 88% of the time at the starting uncertainty.
- The quality score (1 to 5, `quality_score` in rubric v2, the weighted mean of the AI axes for older grades) nudges the mean within the tier: 2 points per quality point away from what that tier usually scores (S 4.8, A 4.45, B 3.6, C 2.7, D 1.55, measured on the June grade export), at most 1.5 either way, so tiers never overlap.
- Starting uncertainty: 4 for a rubric v2 grade by gemini-3.5-flash-lite, 4.5 for an older grade or one by 3.1, and 8.33 ("unsure") for a site with no grade.
- Sites graded "not a portfolio", delisted or confirmed down are rated but not shown.

## Three views

| View | Evidence | Seed |
| --- | --- | --- |
| Merged (default) | human votes at full weight, AI one-on-one comparisons at half weight | AI grade |
| People | human votes only | none: everyone starts at 25, unsure |
| AI | AI one-on-one comparisons only | AI grade |

How Merged works: one rating that takes both evidence sets, replayed in time order, with every AI comparison applied at weight 0.5 (its move and its shrink of the uncertainty are halved; `RANKING_AI_WEIGHT` changes it).
A starred ("Superstar") human vote counts twice, as it does in the ELO board.

Why one combined rating rather than a blend of the People and AI ratings:

- A blend would count the AI seed twice and has no honest uncertainty; one rating has one mean and one uncertainty that reflect all the evidence.
- It needs no blend weight that changes as votes come in: a site with many human votes is moved mostly by them, a site with none still has a sensible rating from the AI.

Why the AI counts less:

- All AI comparisons come from one judge, so their mistakes are correlated (the same blind spots, a measurable preference for the site shown first), while human votes come from many people.
- The AI compares about 100 pairs a day against a few dozen human votes; at full weight it would drown out people, which is what the audit flagged in the ELO board.
- People see what the product is about; the AI keeps the board moving where nobody voted.

The AI view is the AI's own opinion, for the side-by-side comparison and for finding big gaps between people and the AI.
People starts without the AI seed, so it is purely what people think, and it needs many votes before it says much.

Ranking: each board is sorted by the mean.
The uncertainty is shown as a 95% range (mean plus or minus two sigma) and a label: settled (sigma at most 2.5), confident (at most 3.5), provisional (at most 5), unsure.
"Enough evidence" means confident or settled.
Two neighbours are marked tied when the higher one's chance to beat the lower is under 55%.
Sorting by the mean, rather than a cautious mean minus three sigma, keeps a redesigned site in its place while its uncertainty is reset.

## Every comparison is recorded

Table `comparisons`, one row per judgement:

| Column | What |
| --- | --- |
| `created_at` | when (ISO, UTC) |
| `rater_type` | `human` or `ai` |
| `rater_id`, `model` | who: the account, or the AI judge and the model that answered |
| `prompt_version`, `rubric_version` | which prompt (`compare-v1`, `batch-v1`, `legacy-pairwise` for ELO-era AI votes) |
| `method` | `one_on_one` or `batched` |
| `shown` | the sites in the order shown (JSON); null for votes from before this table, which did not record it |
| `ranking` | the result, best first (JSON groups; sites in one group tied); null for a skip |
| `outcome` | `ranked` or `skip` |
| `starred` | a human Superstar vote |
| `experiment` | null for the main lane; an experiment's name keeps it out of every public view |
| `match_seed`, `match_kind` | the matchmaking seed and slot (`close`, `random`, `repeat`) that chose it |
| `source` | `vote:<id>` for rows mirrored from the vote log |

Until the app writes comparisons itself, the recompute mirrors the vote log into this table first: human and AI votes with their models, never practice votes; a practice vote claimed at sign-in is picked up, an undone vote is removed.

### Batched comparisons

One request shows several sites (5 by default) and the model ranks them; OpenSkill rates the whole ranked group at once.
They are stored like any other comparison but are experiment only: they count in the AI and Merged views only when `RANKING_BATCHED_COUNTS` is `true`.
Until then the recompute adds an `ai_experiment` view (the AI view with batched results counted) so the two can be compared.
The owner's rule: batched results join the ranking once they agree well enough with one-on-one (about two weeks of data).

## Matchmaking

`lib/ranking/matchmaking.mjs`, used by the daily job:

- Mostly close matches: an anchor site is drawn with weight sigma to the fourth (an unsure site about 18 times as often as a freshly seeded one, which is drawn about 6 times as often as a settled one), and its opponent from the 12 sites on either side of it by mean, weighted towards close, unsure matchups.
- 1 in 5 pairs is random from anywhere, so a site that got much better can be noticed and jump far.
- 1 in 20 pairs repeats an earlier pair in the other order, which measures how consistent the judge is and how much the order matters.
- The order shown is random every time and recorded.
- Deterministic: the plan comes from the ratings and a seed (the date plus what was already done today), recorded on every comparison.
- No pair twice within 30 days (except deliberate repeats), and no site in more than 3 comparisons a day.
- Batches: an unsure anchor plus neighbours by rating, every 5th batch with one random site, order shuffled.

## Stability analytics

`lib/ranking/analytics.mjs`, in every recompute's summary:

- Rank movement: per view, per week, the mean, median and 90th percentile of how many places sites moved, and the biggest climbers and fallers (from the weekly snapshots in `rank_history`).
- Contradictions: of the triangles of sites the same judge compared pairwise, the share that go round in a circle (A beat B, B beat C, C beat A).
- Repeat disagreement: how often a judge gives a different answer on a pair it judged before.
- Position bias: how often the site shown first wins, with a 95% interval, per judge.

## Change detection

When a site's page fingerprint changes (a hash of the capture's DOM shape and CSS classes, `portfolios.meta`), the recompute records a reset in `rating_resets` and the site's uncertainty goes back to unsure from that moment; its mean stays.
The first fingerprint of a site is its baseline, never a reset.
Some sites change hashed class names on every build: a false alarm only costs a few extra comparisons, never the site's place.
The hook is `recordFingerprint(db, url, fingerprint, at)` in `lib/ranking/store.mjs`, and `detectPageChanges(db)` runs it over every captured site.

## Running it

| Command | What |
| --- | --- |
| `node scripts/recompute-ratings.mjs` | mirror votes, detect page changes, rebuild every view into `site_ratings` and `rank_history`, record the run in `ranking_runs` |
| `node scripts/recompute-ratings.mjs --read-only` | the same summary without writing anything (works with a read-only token) |
| `node scripts/recompute-ratings.mjs --export FILE` | also write the input (sites, grades used for seeding, comparisons, resets) as an export |
| `node scripts/recompute-ratings.mjs --from FILE` | recompute from an export, no database: anyone can check the board |
| `node pipeline/compare.mjs` | the AI comparisons by hand (the end-of-day run on Cloudflare does them every night); does nothing unless `RANKING_V2` is `true` |
| `node scripts/simulate-ranking.mjs [--grades CSV] [--votes-log LOG] [--out DIR]` | offline evaluation on the real roster with simulated judges |
| `GET /api/leaderboard?view=merged\|people\|ai` | the recomputed board, read-only (empty until the first recompute) |

Against the production database, run through `pass-env run -- node scripts/recompute-ratings.mjs --read-only` first.
Each run records the input digest and the settings, so the same digest and settings always give the same boards.

## Settings

| Variable | Default | What |
| --- | --- | --- |
| `RANKING_V2` | off | `true` runs the AI ranking comparisons and the recompute in the end-of-day run (a Worker variable in `wrangler.jsonc`; the repository variable of the same name only steers a manual `judge-vote.yml` run) |
| `RANKING_BUDGET` | `{"one_on_one": 100, "batched": 100}` | daily comparisons on gemini-3.5-flash-lite |
| `RANKING_BATCHED_COUNTS` | off | `true` counts batched results in the AI and Merged views |
| `RANKING_AI_WEIGHT` | `0.5` | the AI's weight in Merged |

AI comparisons use gemini-3.5-flash-lite only (owner decision 2026-11-10): when 3.5 is busy after its retries or its daily quota is spent, the rest waits for the next run.
The job respects the `GEMINI_FALLBACK` switch (`pipeline/gemini.mjs`, off): if an owner turns it on, an answer from the backup model is stored with `experiment = 'backup-model'`, so it never counts in any board.
The comparisons run in the end-of-day run on what is left of the day's quota after people, new and changed sites, within their own cap ("AI ranking comparisons", 200 requests a day by default; `GEMINI_BUDGET`, [pipeline/budget.mjs](pipeline/budget.mjs)).
`RANKING_BUDGET` still splits them between one-on-one and batched.

## Offline evaluation (2026-11-10)

`scripts/simulate-ranking.mjs` on the real roster (2,103 sites), 661 real grades from the June export, the 40 real AI votes of the June pairwise log, and simulated grades, judges and votes for the rest (the production vote log was not available offline).
56 simulated days at the default budgets plus 30 human votes a day:

- Seeding alone already orders sites well (Spearman 0.86 against the hidden truth); AI comparisons raise it to 0.89, Merged 0.90, batched counted 0.92; People, from random human votes, 0.39.
- Every S site starts above every D site (worst S rank 104, best D rank 1,882).
- A D site whose page changes and is now S quality reaches the top 10% after 8 AI comparisons (11 days) and the top 5% after 9; without the uncertainty reset it is compared once in 6 weeks and never climbs.
- Enough evidence after 8 weeks: 15 sites in AI, 1 in Merged, 0 in People, but 977 with batched results counted: at 100 one-on-one a day each site gets about 5 comparisons in 8 weeks, which narrows the range but rarely below sigma 3.5.
- Neighbours in the top 20 are all within the tie threshold: the board should show ranges and ties, not imply that #7 beats #8.

These numbers come from a simulation and only say the machinery works as intended; real ones come from the first weeks of live data.

## Switching it on

1. Run `node scripts/recompute-ratings.mjs --read-only` against production and check the boards.
2. Run it once without `--read-only` to create the tables and the first boards.
3. Set `RANKING_V2` to `"true"` in `wrangler.jsonc` (and `RANKING_BUDGET` if the split should change) through a pull request: from the next night, the end-of-day run makes the comparisons and rebuilds the boards.
4. With the redesign, read the boards from `lib/ranking/board.ts` (or `/api/leaderboard`) on `/top`, and have `/api/rank` write human votes straight to `comparisons` with the order shown.
5. After about two weeks, compare `ai_experiment` with `ai`; if batched agrees well enough with one-on-one, set `RANKING_BATCHED_COUNTS` to `true`.

## Tier letters (owner rule, 2026-11-13)

Behind `RANKING_V2`, like the rest; the code is [lib/tiers.mjs](lib/tiers.mjs) and [lib/tiers-db.mjs](lib/tiers-db.mjs).

- Every graded portfolio has a letter from day one.
  The face-off count only says how settled it is: 10 face-offs (an AI one counts a quarter) is settled.
- The starting order is points from automated checks ([lib/check-points.mjs](lib/check-points.mjs)); face-offs move it from there.
- A is the top 30% of that order, B the next 40%, C the rest, each split in thirds (A+, A, A-).
  The boundaries are shares of the library, not point lines, so they hold as votes move ratings.
- S is earned, never given at the start: 3 face-off wins (an AI win counts a quarter) while in the top 1%.
  SSS is the first 3 of those, S+, S and S- split the rest in thirds.
  A site that drops out of the top 1% loses S at the next daily run.
- D is reserved for portfolios failing the must-haves (a name, a role, a way forward) from the five-second checks.
  The hook is `failsMustHaves` in lib/tiers.mjs, switched off, so no one is D.
- Equal ratings break by the date added (first graded), then the address.

## Settling

How far the library is from every member having 10 face-offs, and how long that takes at a given pace.
A projection only: nothing is spent.
Rerun it with `node scripts/settling.mjs` (read-only; `--json`, `--people 100,500`, `--gemini 400`), with `TURSO_DATABASE_URL` set for a remote database.

Staging, 2026-11-13 (1,369 graded portfolios, 66 weighted face-offs so far):

| | Count |
| --- | --- |
| Letters now | A 411, B 547, C 411, S 0, D 0 |
| Settled (10+ face-offs) | 0 |
| Face-offs short, summed over every member | 13,624 |
| Distinct pairs in the library | 936,396 |
| People's votes needed (each vote pairs two unsettled sites) | 6,812 |
| Gemini one-on-one comparisons needed (each counts a quarter) | 27,248 |
| Gemini batches of 5 needed (10 pairs each) | 2,725 |

| Pace | Days to settle everyone |
| --- | --- |
| People, 100 votes a day | 69 |
| People, 500 a day | 14 |
| People, 1,000 a day | 7 |
| People, 5,000 a day | 2 |
| Gemini one-on-one, 400 a day | 69 |
| Gemini batches of 5, 400 a day | 7 |

The counts are a best case: they assume every face-off pairs two sites that both still need one, which Play's draw favours ([lib/play/draw.mjs](lib/play/draw.mjs)) but does not guarantee.
The AI one-on-one budget today is 100 a day (`RANKING_BUDGET`), so 400 a day is a raise.
Batched results do not count toward tiers today (only one-on-one face-offs are replayed); the batch line is what it would take if they did.
