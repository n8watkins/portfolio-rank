# Legal pages

**Not legal advice.**
These are PortfolioRank's public policy pages, written in plain words from how the site works.
A lawyer has not reviewed them; have them checked before relying on them, especially before the newsletter or "grade my portfolio" launch in production.

| Source | Page | Status |
| --- | --- | --- |
| [privacy.md](privacy.md) | `/privacy` (`app/privacy/page.tsx`) | live since 2026-11-12; add the newsletter and email sign-in sections when they launch |
| [terms.md](terms.md) | `/terms` (`app/terms/page.tsx`) | live since 2026-11-12 |
| [removal.md](removal.md) | `/removal` (`app/removal/page.tsx`) | live since 2026-11-12 |
| [newsletter.md](newsletter.md) | the newsletter sign-up box and `/newsletter` | draft, needed before the first newsletter email |
| [ai-content.md](ai-content.md) | `/about-posts` | live with the blog pages (2026-11-11) |

Each live page links the other two and the contact email, and every page's footer links all three (`components/shell/SiteFooter.tsx`).
When a page changes, change its Markdown source in the same pull request and update `LEGAL_UPDATED` in `components/legal/Legal.tsx`.
`tests/legal-pages.test.mjs` checks the promises the owner approved (strategy decisions 12 and 13): checking a site adds it, removal at any time including sites waiting to be graded, and backups that expire in 35 days.

The owner's answers of 2026-11-10 are in: the contact email (nate@n8builds.dev), governing law (California, United States), the minimum age (16), how long each kind of data is kept, and how fast requests are handled (removals and reported mistakes within 14 days, data requests within 30).
Still open:

- whether the pages should name a business instead of Nathan Watkins, and the newsletter's sender address;
- whether big policy changes are also announced in the newsletter.

The pages appear in Nathan's name, so they are written in the first person and in his voice (`~/.claude/skills/writing/VOICE.md`): plain, short, no hype.
