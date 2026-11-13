# PortfolioRank post template

Every automatic blog post follows this shape (owner decision, 2026-11-10).

Every PortfolioRank post uses this shape.
The goal: a reader decides in 5 seconds from the title and TL;DR, and gets the whole lesson in under 3 minutes.

### Rules

- **Topic:** portfolios, never PortfolioRank itself (owner, 2026-11-11): what people vote for and against, what the AI grader rewards and penalizes, how portfolios change over time, portfolios worth seeing, trends across the leaderboard, and portfolio or developer-hiring news with a real angle.
  No bug postmortems, build-in-public, running costs, our stack or our pipeline.
- **Payoff:** one clear takeaway a reader can use on their own portfolio, stated early: the opener ends with it, addressed to the reader.
  Cut throat-clearing and anecdotes that don't pay off.
- **Length:** 700 to 1,000 words of body text (image specs and metadata do not count; owner, 2026-11-12, replacing 500 to 800 of 2026-11-11 and 250 to 400 of 2026-11-10); the length comes from named examples and explanation, not repetition.
- **Voice:** follow `VOICE.md`. Lead with the point, short sentences, real numbers, first person. No em dashes, no hype.
- **Facts:** every number traces to a source. Anything unconfirmed gets [check] and stays until confirmed.
  No claim about PortfolioRank's own infrastructure (one draft said Amazon SES; email goes through the Cloudflare mailroom), and any fact that is neither in our data nor followed by a cited link is cut.
- **Skimmability:** subheads say what the section proves, not "Background" or "Results". A reader who reads only the TL;DR, subheads and callout should get the story.
- **Sentences:** one full sentence per line in the Markdown source.
- **Paragraphs:** real paragraphs of 2-4 sentences, never one sentence each, with an opening hook (a notable fact from the sheet) and a closing takeaway of 2-3 sentences.
- **TL;DR:** exactly three bullets, each with at least one fact placeholder.
- **Superlatives:** "largest", "smallest", "most" or "only" must be true against the fact sheet, ties included; a tie is said as a tie.
- **Callout:** restates exactly one numeric fact with the scope its label gives (a share of all graded portfolios is not a share of top portfolios).
- **Try this:** where a named positive example fits, a step links to it.

### Skeleton

```markdown
**Title:** <the hook, ideally with a number or a contradiction>
**Alt title A:** <more literal / search-friendly>
**Alt title B:** <more curiosity-driven>

**Subtitle:** <one line: what happened and why it matters to the reader>

**Tags:** <2-4>

**X share line:** <under 260 characters, stands alone without the link>

> **TL;DR**
> - <what happened, with the key number>
> - <why it happened, in one plain sentence>
> - <the fix or the finding>

[IMAGE 1: hero]

<2-4 line opener: the hook, then the one takeaway for the reader's own portfolio>

### <Descriptive subhead: the problem>
<short paragraphs, 2-4 lines each>

[IMAGE 2: inline chart or screenshot that proves the point]

### <Descriptive subhead: why it happened>

> **<Key number or pull quote>**
> <one line of context>

### <Descriptive subhead: the fix / the second finding>

[IMAGE 3 (and 4 if earned)]

### Try this
1. <concrete step a reader can do today>
2. <...>
3. <...>

<Closing line: the one-sentence lesson.>
**<One CTA only:>** Grade your portfolio on PortfolioRank -> <link>  OR  Get the next post in your inbox -> <newsletter link>
```

### Image slot spec (fill one per slot)

| Field | What to write |
|---|---|
| **Purpose** | What the image proves or does for the reader (hook, evidence, explainer). |
| **Kind** | One of: data chart made by code / real screenshot / stock photo / AI-generated illustration. Prefer data charts and real screenshots: they are evidence. Use AI illustration only for the hero or a concept with no real visual. Avoid stock photos unless nothing else fits. |
| **Spec** | Concrete description. For charts: data source, x and y axes, range, highlights, annotations, colors. For screenshots: exactly what screen, what to crop, what to redact. |
| **Alt text** | One sentence that carries the image's point for someone who can't see it. |
| **Prompt** | AI-generated only: one line, style + subject + composition, "no text" unless text is the point. |

House image style: 1600x900 hero, 1200px-wide inline, flat colors, PortfolioRank palette, no fake UI that could be mistaken for a real screenshot, any code shown in the same monospace font, secrets always redacted.
