# PortfolioRank

**The best developer portfolios. Ranked.**

1,700+ community-curated developer portfolios — browsable, searchable, and (soon) ranked
by head-to-head human votes and AI scoring instead of alphabetical order.

🌐 **Live: [portfoliorank.vercel.app](https://portfoliorank.vercel.app)** · ☕ [Support on Ko-fi](https://ko-fi.com/n8watkins)

## Origin

It started with this tweet by [Ali Spittel](https://twitter.com/ASpittel), which inspired
[Emma Bostian](https://github.com/emmabostian) to create
[developer-portfolios](https://github.com/emmabostian/developer-portfolios) — the
community list this project is built on:

<a href="https://twitter.com/ASpittel/status/1171604728951779328">
	<img width="597" alt="Ali Spittel's tweet: asking developers to share their portfolios" src="assets/ASpittel_tweet.png">
</a>

## Why

The original list is an incredible community resource — thousands of contributors since
2019 — but it's a README sorted A→Z. Nobody can find the *good* ones. PortfolioRank gives
the dataset a real frontend and a ranking system:

- **Browse** — card grid of every portfolio, searchable by name, role, or domain
- **Face-off voting** *(planned)* — two portfolios side by side, pick the better one,
  ELO decides the leaderboard
- **AI bootstrap** *(planned)* — Gemini judges design/content pairwise to seed rankings
  before human votes accumulate
- **Objective scorecards** *(planned)* — real Lighthouse scores (via PageSpeed Insights),
  polish checks, and originality detection for every site

See [PLAN.md](PLAN.md) for the roadmap and [GRADING_CRITERIA.md](GRADING_CRITERIA.md) for
exactly how sites are graded.

## Development

```bash
npm install
npm run dev   # → http://localhost:7678
```

Next.js (App Router) + Tailwind. Data lives in `data/feed.json`; pipeline scripts in
`pipeline/`.

## Security: what building this taught me

PortfolioRank is a public site where anyone can vote, and the votes *are* the product —
a leaderboard nobody trusts is worthless. That makes vote integrity the thing worth
protecting, more than any user data (there barely is any). Here's what I learned hardening
it, in case it's useful to anyone building something similar.

### A "check, then write" is a race condition waiting to happen

My first vote endpoint did the obvious thing: *check* whether you'd already voted on this
matchup, *check* you were under your daily limit, then *insert* the vote. Reads, then a
write. It worked perfectly when I clicked through it by hand.

The problem only shows up under concurrency. Fire ten requests for the same matchup at the
exact same moment and all ten run their "have you voted yet?" check *before* any of them
finishes inserting — so all ten see "no" and all ten write. Same story for the daily cap:
a burst sails straight past it. And because the ELO update read the current score and
wrote `score + 1`, two concurrent votes could both read the same starting value and one
overwrite the other (a "lost update"). For a voting site, that's not a hypothetical — it's
the exact shape of a script trying to inflate one portfolio's rank.

The fix wasn't more checks in my code; it was pushing the guarantee down into the
database, which is the one place that can be authoritative about "did this already
happen." A `UNIQUE(rater_id, pair_key)` index means the *database* refuses a second vote on
the same matchup — I just insert and catch the violation. And wrapping the whole
operation in a single write transaction (libSQL serializes them) closes the gap between
check and write entirely. **Lesson: if a rule must always hold, enforce it with a
constraint or a transaction, not with an `if` statement that has a gap after it.**

### A NUL byte ate half my data, silently

While building the matchup key, I joined the two URLs with a separator. My code *looked*
like it used a space. It didn't — a stray NUL byte (`\0`) had ended up in the string
literal, invisible in my editor. SQLite treats a NUL as a C-string terminator and quietly
truncates `TEXT` at it, so every key got stored as just the first URL, which would have
made completely unrelated matchups collide.

Nothing errored. The types were right, the tests I'd eyeballed passed, the API returned
200. I only caught it by dumping the raw bytes of what got stored (`xxd`) and seeing the
length was wrong. **Lesson: when a string behaves impossibly, look at its actual bytes —
and pick separators that can't appear in your data *and* can't be silently mangled by your
storage layer.** (I switched to a newline.)

### An allowlist doesn't stop SSRF if you follow redirects

The site fetches each portfolio to run polish checks. I'd locked that endpoint down to
only URLs on the roster — no fetching arbitrary attacker-supplied addresses. Felt safe.

It wasn't, because a roster site is still someone else's server, and that someone controls
what their server does — including responding with a redirect. `fetch(..., { redirect:
"follow" })` will happily chase a `302` from a listed site to `http://169.254.169.254/`
(the cloud metadata endpoint) or `http://localhost`, and now my server is making requests
into its own private network on an attacker's behalf. That's a classic SSRF, and the
allowlist on the *initial* URL does nothing to stop it.

The fix is to follow redirects manually and re-validate *every hop* against a blocklist of
private, loopback, and link-local addresses — not just the URL you started with. While I
was there I also capped how many bytes I'll read from a response, because "stream me
gigabytes until the function runs out of memory" is the lazy way to take down a serverless
endpoint. **Lesson: an allowlist only covers the request you make on purpose; redirects are
requests you make by accident.**

### Sign-in is about identity, not a login button

It's tempting to think of auth as a feature — a button that flips you to "logged in." But
the reason this site requires a GitHub or Google account to cast a *counting* vote has
nothing to do with the button: it's that creating a hundred throwaway identities should be
hard. Anonymous visitors get practice votes that never touch the real rankings; only a
real account moves ELO. The OAuth provider isn't giving me access to anyone's account —
it's vouching that "this is a distinct human," which is the only thing that makes one-
person-one-vote mean anything.

The subtle bug here was a feature I'd just added: letting practice votes "convert" to real
ones when you sign in. Convenient — and a perfect bypass, because you could mint a fresh
anonymous identity, use up its practice votes, sign in to bank them, and repeat forever.
The conversion had to count against the same daily cap as live voting, or the cap wasn't a
cap. **Lesson: every "convenient shortcut" feature is also a path an attacker can walk —
trace it from their side before you ship it.**

### The boring layer matters too

None of this replaces defense-in-depth basics: security headers so the site can't be
framed for clickjacking or trusted to sniff content types, secrets that live only in
environment variables and never touch git, and parameterized SQL everywhere so user input
is *always* data and never code. They're unglamorous and they're the floor you build on.

The throughline for all of it: **trust boundaries are wherever input crosses into your
system — a vote body, a third-party redirect, a cookie, a string literal you didn't look
at closely.** Most of the work of "security" is just noticing where those boundaries are.

## Data & credit

Portfolio data originates from
[emmabostian/developer-portfolios](https://github.com/emmabostian/developer-portfolios),
curated by Emma Bostian and 1,700+ contributors — go star it. The raw list is mirrored in
[`data/PORTFOLIOS.md`](data/PORTFOLIOS.md); `data/feed.json` is the structured version.
Want your portfolio included? Add it there via PR and it'll flow into PortfolioRank on
the next sync.

All code here is MIT-licensed. Rankings are opinions (the crowd's and an AI's), not
judgments of the developers themselves — every site on this list shipped, which is more
than most.
