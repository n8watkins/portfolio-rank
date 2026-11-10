# Draft: Three months of green checks and zero work

Example post in the house template. Not published. Image 2 needs real daily grade counts from the database before it can be made.

**Title:** Three months of green checks and zero work

**Alt title A:** My AI grader was broken for 105 days and CI said it was fine

**Alt title B:** Green doesn't mean done: the bug that hid behind my CI for three months

**Subtitle:** A dead API key, a script that exited 0 anyway, and the one rule I'm keeping.

**Tags:** build-in-public, postmortem, github-actions

**X share line:** For 3+ months my AI grader did nothing. Dead API key, zero grades, and the AI jobs kept passing because the script exited 0. The fix: fail loudly. Plus why your API key belongs in a header, not the URL.

> **TL;DR**
> - From about Jul 28 to Nov 10, PortfolioRank's AI grader did zero work. Its runs kept passing.
> - The API key was dead. The script logged each error, kept going, and exited 0.
> - Green only means "exited 0". Now the job goes red when it does no real work.
> - Bonus bug: the new key failed in the URL (`?key=`) and worked in the `x-goog-api-key` header.
> - Try it: break one job's credentials on purpose. If it stays green, you have this bug.

[IMAGE 1: hero]

For over three months, the AI half of PortfolioRank did nothing.
Every AI run showed a green check.
I looked at that column of green and moved on.

### A column of green checks, zero grades

PortfolioRank ranks 2,103 developer portfolios with head-to-head votes and AI scoring.
The AI part is a GitHub Actions job that sends portfolios to Gemini and writes back grades and votes.

From about July 28 to November 10, the Gemini key was dead.
Every request failed.
Zero AI grades, zero AI votes, and about 675 portfolios left ungraded.

[IMAGE 2: grades-per-day timeline]

### Why green lied

> **Exit 0 ≠ job done.**
> A green check means the process exited cleanly. It says nothing about whether the work happened.

My script treated an API error like a skipped item: catch it, log it, move on.
Fine for one flaky request.
Terrible when every request fails, because "skipped everything" and "did everything" look identical from outside.

The fix: runs now fail loudly.
If the grader can't do its work, the run goes red.
Red I notice.

### Bug two was hiding behind bug one

I put in a new key, and Google rejected it.
The key was fine.
The old code sent it in the URL as `?key=...`.
Newer AI Studio keys work in the `x-goog-api-key` header.
I moved it, and requests went through.

[IMAGE 3: ?key= vs header code snippet]

Make that move even if your key works in the URL.
URLs end up in request logs, proxy logs and error messages.
Headers usually don't.
Easy trade.

### The first run back

A test batch graded 35 sites: 27 by gemini-3.5-flash-lite, 8 by the 3.1 fallback.
Every fallback was a 503, meaning the model was overloaded.
Zero 429s at 8 requests a minute, so pacing wasn't the problem.
A 503 means "try again soon", so 3.5 now gets retries at 10, 30 and 60 seconds before falling back.

### The quiet cost

The leaderboard went the whole time without a single new AI vote.
It was about 85% AI votes, those counted the same as people's, and one vote could put a portfolio on the Top page.
Three months of nothing still shaped what people saw.
That's part of why the ranking is getting rebuilt, which gets its own post.

[IMAGE 4: green check vs zero work illustration]

### Try this

1. Pick one scheduled job and break its credentials on purpose.
2. Run it.
3. If it's green, you have the same bug I had.

Then make the job exit non-zero when it does zero useful work, and put API keys in headers, not URLs.

Keys will die again.
The job just can't be allowed to say it's fine when it isn't.

**Want to know where your portfolio stands? Grade it on PortfolioRank -> <link>**

<!-- Body word count: ~460 (excluding metadata, TL;DR, image specs). -->

---

### Image slots for Draft 1 v2

#### IMAGE 1: hero

- **Purpose:** Stop the scroll and tell the whole story in one glance: everything looked fine, nothing was happening.
- **Kind:** AI-generated illustration.
- **Spec:** 1600x900. A tall, neat column of bright green checkmarks on the left, like a CI history, all glowing. On the right, an empty conveyor belt or an empty output tray with a single cobweb. Flat style, dark navy background, PortfolioRank accent color for the checks. No readable text, no fake GitHub UI.
- **Alt text:** A long column of green checkmarks next to an empty output tray, showing a job that reported success while producing nothing.
- **Prompt:** Flat vector illustration, dark navy background, a tall column of glowing green checkmarks on the left, an empty dusty output tray with a small cobweb on the right, minimal, no text.

#### IMAGE 2: grades-per-day timeline

- **Purpose:** The evidence. Make the three-month flat line impossible to miss.
- **Kind:** Data chart made by code.
- **Spec:** Line or bar chart, x = date (from a few weeks before Jul 28 through Nov 10, 2026), y = AI grades written per day, pulled from grade timestamps in the database. Shade Jul 28 to Nov 10 in muted red and label it "Key dead, every run green". Mark Nov 10 with the 35-grade test batch and a "Fix shipped" annotation. Optional second line: scheduled runs per day, all green, to show runs kept happening while grades were zero. One accent color, gray gridlines, readable at phone width. [check: needs real daily counts from the database; pre-Jul 28 volume is not in the brief, do not estimate it]
- **Alt text:** Chart of AI grades per day: activity until late July, then a flat line at zero from July 28 to November 10 while scheduled runs kept passing, then a jump to 35 grades on November 10 after the fix.

#### IMAGE 3: `?key=` vs header code snippet

- **Purpose:** Show the bonus fix so a developer can copy it in 5 seconds.
- **Kind:** Real screenshot (of a code snippet, rendered from the actual diff with a tool like Carbon or Ray.so, or a syntax-highlighted code block if the blog supports it).
- **Spec:** Two stacked panels. Top, labeled "Before (in the URL, ends up in logs)": the request with `?key=REDACTED` in the URL, with a red X. Bottom, labeled "After (in a header)": the same request with the `x-goog-api-key: REDACTED` header, with a green check. Use the real code from the repo, trimmed to the few lines that changed. Key always shown as `REDACTED`.
- **Alt text:** Code comparison: before, the Gemini API key sent in the URL as a key query parameter; after, the same key sent in the x-goog-api-key header.

#### IMAGE 4: green check vs zero work

- **Purpose:** The shareable concept image, reusable as the X post card and in the Try-this section.
- **Kind:** AI-generated illustration.
- **Spec:** 1200x675 (X card ratio). Split panel. Left: a big green check badge labeled "Exit 0". Right: a big empty box labeled "Work done: 0". The two labels are the only text, added in post in the house font (not generated by the model). Flat, high contrast, same palette as the hero.
- **Alt text:** Split image: a green check labeled "Exit 0" beside an empty box labeled "Work done: 0".
- **Prompt:** Flat vector split-panel illustration, left side a large green check badge, right side a large empty open cardboard box, clean white background, high contrast, no text.
