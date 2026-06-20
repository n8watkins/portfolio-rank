# Making a Giant List Actually Fun to Browse — with a Little AI

*How I used generative AI to turn a 1,700-item alphabetical list into something you'd actually want to explore and share.*

---

There's this wonderful community list — [1,700+ developer portfolios](https://github.com/emmabostian/developer-portfolios) people have collected over the years. It's a goldmine. It's also a plain README sorted A→Z, which means the genuinely great ones are buried next to everything else and nobody can find them. Amazing content, miserable to actually enjoy.

That's a pattern I keep running into: **the content already exists and it's good — what's missing is the *experience* of it.** And lately, generative AI has become the cheat code for closing that gap. So I built [PortfolioRank](https://portfoliorank.vercel.app), and this is the story of doing exactly that.

<!-- MEME: treasure chest buried under junk / "it's free real estate"
     Suggested file: assets/blog/free-real-estate.gif  ·  search: "free real estate gif" -->
![A pile of treasure half-buried in junk](../assets/blog/free-real-estate.gif)

*1,700 great sites, sorted alphabetically. Somewhere in there is the best portfolio you've never seen.*

---

## Step 1: The boring-but-essential part — make it browsable

Before anything clever, the basics: give the list a real front door. A searchable grid, filters by role, name, and domain. That alone turns "scroll a 1,700-line README" into "find the frontend folks in two clicks."

It's not exciting, but table stakes are table stakes — you can't make something *fun* if it isn't even usable first.

---

## Step 2: Filters find a *category*. They don't find the *good ones.*

Here's where it gets interesting. Filtering answers "show me the backend portfolios." It does **not** answer the question everyone actually has: *"okay, but which ones are the best?"*

For that you have to **rank** them. And ranking 1,700 sites means somebody has to actually look at all 1,700 and form an opinion on each. By hand, that's a weekend you are never getting back.

<!-- MEME: exhausted person / "ain't nobody got time for that"
     Suggested file: assets/blog/no-time.gif  ·  search: "ain't nobody got time for that gif" -->
![A woman waving her hand, captioned "ain't nobody got time for that"](../assets/blog/no-time.gif)

*Me, contemplating manually reviewing 1,700 websites.*

---

## Step 3: To rank them, you have to digest them — so let the AI look

This is the moment generative AI earns its keep. Instead of me squinting at 1,700 sites, I have an AI **look at each one** — its screenshot — and tell me what's working: the design, the clarity, the polish, a quick grade. A tireless first-pass critic that's just as sharp on site #900 as it was on site #1.

Suddenly the impossible part is cheap. The AI digests the pile so a human doesn't have to. That's the whole trick: **let the AI do the heavy reading, so people get to do the fun part.**

<!-- MEME: robot happily doing chores
     Suggested file: assets/blog/robot-chores.gif  ·  search: "robot doing chores gif" -->
![A little robot cheerfully working away](../assets/blog/robot-chores.gif)

*The AI, grading its 600th portfolio without complaining once.*

---

## Step 4: The catch — free AI isn't infinite (and it only sees the surface)

Of course there's a catch. Two, actually.

First, I'm running this on a **free** AI tier (Google's Gemini), and free means limits — you can only ask it to grade so many sites a day. So you design around it: grade in daily batches, cap how much you spend, and pick up where you left off tomorrow. Not glamorous, but "it quietly finishes itself over a few days" is totally fine when nobody's standing there waiting.

Second — and more important — **an AI judging a screenshot is judging how something *looks*,** not whether the projects are real or the code is any good. It's a fantastic *starting point*, not the final verdict. Which is exactly why the AI doesn't get the last word…

---

## Step 5: AI seeds the leaderboard; people get the final say

The AI's grades become the **starting** ranking — so the leaderboard isn't a sad empty page on day one. Then real people refine it, one tap at a time: two portfolios side by side, pick the better one. That's the whole interaction.

Voting like that is *fun* and *fast* in a way "write a thoughtful review" never is — and head-to-head taste is the one thing humans are genuinely better at than the AI. So the machine does the cold-start grunt work; the crowd does the part it's best at.

<!-- MEME: the "two buttons, sweating" decision meme
     Suggested file: assets/blog/two-buttons.gif  ·  search: "two buttons sweating meme" -->
![A person sweating over which of two buttons to press](../assets/blog/two-buttons.gif)

*The entire voting UX: this one or that one?*

---

## Step 6: One rule that makes the votes mean something

If anyone could vote infinitely, the ranking would be worthless — and the whole point is a leaderboard people trust. So there's exactly one rule: **your vote only counts if you sign in.** Anonymous visitors get a few practice rounds to try it; only a real account moves the rankings. It's not about the login button — it's that "one real person, one vote" is the *only* thing that makes a crowd ranking mean anything.

I learned the edge of that the slightly-hard way. I'd built a nice convenience — your practice votes "convert" into real ones when you sign in, so trying the site first doesn't feel wasteful. Lovely idea. Also a perfect loophole: get a fresh anonymous identity, use its practice votes, sign in to bank them as real, repeat forever. The fix was making the convenient shortcut play by the same daily limit as everything else. **Every shortcut you build for good users is a shortcut someone else will try to drive a truck through** — worth remembering on any project where the numbers matter.

---

## The bigger idea

None of this is really about portfolios. It's a pattern, and you probably have a version of it: **some pile of genuinely good content — a list, a dataset, an archive — stuck behind a boring interface.**

Generative AI is now the cheapest it has ever been to add the layer that makes that content *enjoyable*. It can read, summarize, grade, and organize at a scale no human will sit through. You bring the taste and the rules; the AI brings the tireless digestion.

Take existing content. Add a little AI. Make it fun to explore and share. That's the whole playbook.

<!-- MEME: chef's kiss / "perfection"
     Suggested file: assets/blog/chefs-kiss.gif  ·  search: "chefs kiss gif" -->
![Someone doing an Italian chef's-kiss gesture](../assets/blog/chefs-kiss.gif)

*Static list in, browsable ranked gallery out.*

---

PortfolioRank is live at **[portfoliorank.vercel.app](https://portfoliorank.vercel.app)** — go find a great portfolio (the AI already did the first pass), and the code is [on GitHub](https://github.com/n8watkins/portfolio-rank) if you want to see how it's wired up.

*— Nathan ([n8builds.dev](https://n8builds.dev))*

---

### 🖼️ Meme drop-in guide

I left captioned placeholders above so the jokes work even with no images. To make it pop, drop these into `assets/blog/` (any short looping gif works):

| File | The bit | Search term |
|------|---------|-------------|
| `free-real-estate.gif` | opening — treasure buried in a list | "free real estate gif" |
| `no-time.gif` | reviewing 1,700 sites by hand | "ain't nobody got time for that gif" |
| `robot-chores.gif` | the AI grading tirelessly | "robot doing chores gif" |
| `two-buttons.gif` | the head-to-head voting UX | "two buttons sweating meme" |
| `chefs-kiss.gif` | closing — list in, gallery out | "chefs kiss gif" |

(Giphy/Tenor let you grab the `.gif` directly. Keep them small so the post loads fast.)
