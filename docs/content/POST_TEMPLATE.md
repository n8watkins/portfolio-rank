# PortfolioRank post template

Every automatic blog post follows this shape (owner decision, 2026-11-10).

Every PortfolioRank post uses this shape.
The goal: a reader decides in 5 seconds from the title and TL;DR, and gets the whole lesson in under 3 minutes.

### Rules

- **Length:** 400-600 words of body text (image specs and metadata don't count).
- **Voice:** follow `VOICE.md`. Lead with the point, short sentences, real numbers, first person. No em dashes, no hype.
- **Facts:** every number traces to a source. Anything unconfirmed gets [check] and stays until confirmed.
- **Skimmability:** subheads say what the section proves, not "Background" or "Results". A reader who reads only the TL;DR, subheads and callout should get the story.
- **Sentences:** one full sentence per line in the Markdown source.

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
> - <the takeaway the reader can use>
> - <optional: the bonus lesson>

[IMAGE 1: hero]

<2-3 line opener: the hook, then the stakes>

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
