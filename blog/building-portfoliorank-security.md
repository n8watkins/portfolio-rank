# I Built a Voting Site, Then Tried to Cheat at It

*Notes from giving PortfolioRank a security pass — and the bugs that were hiding in plain sight.*

---

I built [PortfolioRank](https://portfoliorank.vercel.app) to solve a dumb problem: there's
a wonderful community list of 1,700+ developer portfolios, and it's sorted alphabetically,
which means the *best* ones are impossible to find. So I gave it a frontend and a way to
rank things — you get two portfolios side by side, you pick the better one, and an ELO
score sorts out a leaderboard.

Simple. Wholesome. And then I remembered: the entire value of the site is a leaderboard
people trust. The moment someone can rig the votes, I don't have a ranking — I have a
random number generator with extra steps.

So before telling anyone about it, I sat down and tried to break my own site. Here's what
I found. Most of it was *not* where I expected.

<!-- MEME: "this is fine" cartoon dog sitting in a burning room.
     Suggested file: assets/blog/this-is-fine.gif  ·  search: "this is fine gif" -->
![A cartoon dog in a hat sips coffee while the room burns around it, captioned "this is fine"](../assets/blog/this-is-fine.gif)

*Me, looking at my "totally secure" voting endpoint.*

---

## Lesson 1: "Check, then write" is a trap

My first vote handler did the obvious, sensible thing:

1. **Check** if you've already voted on this matchup.
2. **Check** if you're under your daily limit.
3. **Write** the vote.

I clicked through it a hundred times by hand. Flawless. Ship it.

The bug only wakes up under *concurrency*. Picture ten requests for the same matchup
arriving at the same millisecond. All ten run step 1 — "have you voted yet?" — and all ten
get the answer "nope!" because none of them have *finished writing* yet. Then all ten write.
One vote becomes ten.

<!-- MEME: Spider-Man pointing at Spider-Man (the classic "they're the same" standoff).
     Suggested file: assets/blog/spiderman-pointing.gif  ·  search: "spiderman pointing meme" -->
![Two identical Spider-Men pointing at each other](../assets/blog/spiderman-pointing.gif)

*Ten concurrent requests, each politely confirming nobody has voted yet.*

The daily cap had the same hole. And the ELO math was worse: it read the current score and
wrote `score + 1`, so two votes landing together could both read "5" and both write "6" —
the second silently eating the first. That's not a theoretical edge case on a voting site.
That's *literally the shape of a script trying to pump one portfolio up the rankings.*

The fix wasn't to add more checks in my code — there's *always* a gap between a check and
the write that follows it. The fix was to stop trying to be the authority and let the
database be the authority, because the database is the one thing that can say "this already
happened" without a race:

- A `UNIQUE(rater_id, pair_key)` constraint means the **database** rejects a second vote on
  the same matchup. I just try to insert and catch the rejection.
- Wrapping the whole thing in one transaction (which my database runs one-at-a-time) closes
  the gap between checking and writing completely.

I tested it by firing 8 simultaneous votes at the same matchup. Exactly one survived. 🎉

> **Takeaway:** If a rule must *always* hold, enforce it with a database constraint or a
> transaction — not an `if` statement with a hopeful gap after it.

---

## Lesson 2: An invisible NUL byte ate half my data and said nothing

This one still makes me laugh. To dedupe a matchup regardless of order ("A beats B" ==
"B beats A"), I sorted the two URLs and joined them with a separator. My code *looked* like
it joined them with a space.

It did not. Somewhere in the editing, a **NUL byte** (`\0`) had snuck into the string
instead of a space. You cannot see a NUL byte. It looks like nothing. It looks like the
absence of a character, because it basically is.

And here's the kicker: SQLite treats a NUL as the end of a string. So every key I stored
got silently chopped at the invisible byte — I was saving only the *first* URL of each
pair. Which meant totally unrelated matchups would look identical to each other.

No error. No warning. The types were correct. The API returned a cheerful `200`. Everything
"worked," except it was quietly wrong.

<!-- MEME: man squinting suspiciously at his screen / Jackie Chan "what?" confused face.
     Suggested file: assets/blog/confused-squint.gif  ·  search: "confused math lady gif" or "jackie chan confused" -->
![A man squinting in deep confusion at a screen](../assets/blog/confused-squint.gif)

*"It's the same two URLs but the stored value is half the length. That's not... that can't..."*

I only caught it by dumping the raw bytes of what got saved (`xxd` is a hero) and noticing
the length was wrong. Sure enough — `2200 22` where I expected `2220 22`. A NUL hiding
between two quotes.

> **Takeaway:** When a string behaves *impossibly*, stop trusting your editor and look at
> the actual bytes. And pick separators that can't show up in your data *and* can't be
> silently mangled by where you store it. (I switched to a newline. Newlines are loud.)

---

## Lesson 3: An allowlist doesn't save you if you follow redirects

PortfolioRank fetches each portfolio to run little polish checks (does it have a favicon, an
OG image, that kind of thing). I'd been responsible about it: that endpoint only accepts
URLs that are *on the list*. No fetching arbitrary attacker-supplied addresses. I felt
great about this.

I should not have felt great about this.

Because a listed portfolio is still **someone else's server**, and they decide how their
server responds — including responding with "actually, go look over *here* instead" (an
HTTP redirect). My fetch, set to politely *follow* redirects, would happily chase a listed
site's `302` straight to `http://169.254.169.254/` — the cloud metadata endpoint that can
hand out server credentials — or to `localhost`, or anywhere inside my own private network.
That's [SSRF](https://owasp.org/www-community/attacks/Server_Side_Request_Forgery), and my
allowlist did *nothing*, because it only checked the URL I started with, not where I ended
up.

<!-- MEME: dog on a leash dragging its owner toward something. ("My fetch following a redirect.")
     Suggested file: assets/blog/dog-dragging-leash.gif  ·  search: "dog pulling leash gif" -->
![A small dog enthusiastically dragging its owner across the floor by the leash](../assets/blog/dog-dragging-leash.gif)

*My HTTP client, being led somewhere it really shouldn't go.*

The fix: follow redirects *manually*, and re-check **every single hop** against a blocklist
of private, loopback, and metadata addresses — not just the front door. (While I was in
there, I also capped how many bytes I'll read from a response, because "stream me infinite
gigabytes until your function runs out of memory" is the lazy person's denial-of-service.)

> **Takeaway:** An allowlist only covers the request you make *on purpose*. Redirects are
> requests you make *by accident*.

---

## Lesson 4: Sign-in isn't a button, it's an identity claim

It's easy to think of authentication as a feature — a shiny button that flips you to
"logged in." But the reason this site makes you sign in with GitHub or Google to cast a vote
that *counts* has nothing to do with the button. It's that **creating a hundred throwaway
identities should be hard.**

Anonymous visitors get a few practice votes that never touch the real rankings; only a real
account moves the ELO. The OAuth provider isn't handing me the keys to anyone's account —
it's vouching "yes, this is a distinct human," which is the *only* thing that makes
one-person-one-vote mean anything.

And then I found the bug — in a feature I'd added *that same afternoon*. I'd built a nice
convenience: your practice votes "convert" into real ones when you sign in, so trying the
site first doesn't feel wasteful. Lovely. Also a perfect bypass:

1. Get a fresh anonymous identity.
2. Use up its practice votes.
3. Sign in to bank them as real votes.
4. Go to step 1. Forever.

<!-- MEME: Patrick Star pointing at his head ("can't lose your votes if they always count"). Roll Safe / Patrick "smart" meme.
     Suggested file: assets/blog/roll-safe-think.gif  ·  search: "roll safe think about it gif" -->
![A man tapping his temple knowingly, the "you can't lose if you outsmart the system" meme](../assets/blog/roll-safe-think.gif)

*"You can't hit the daily vote cap if your votes come in through a side door."*

The fix was obvious once I traced it from the attacker's side: the conversion has to count
against the *same* daily cap as normal voting. Otherwise the cap isn't a cap, it's a
suggestion.

> **Takeaway:** Every "convenient shortcut" feature is also a path an attacker can walk.
> Trace it from their side *before* you ship it, not after.

---

## Lesson 5: The boring stuff is the floor you stand on

None of the above replaces the unglamorous basics, so I did those too:

- **Security headers** so the site can't be silently embedded in someone's clickjacking
  frame, and so browsers don't get clever about guessing content types.
- **Secrets that live only in environment variables** and never, ever touch git.
- **Parameterized SQL everywhere**, so user input is *always* treated as data and never as
  code. (This one I'd done from the start, and the audit confirmed it — the one place it
  pays to be boring on day one.)

They're not exciting. They're the floor. You build the exciting stuff on top of the floor.

---

## The actual lesson

If there's one thread running through all of these, it's this: **a security boundary is
anywhere untrusted input crosses into your system** — and "input" is a lot more than a form
field. It's a vote body. It's a third-party server's redirect. It's a cookie someone
re-sent by hand. It's a string literal you typed yourself and never looked at closely.

Most of the work of "security" isn't cryptography or firewalls. It's just *noticing where
those boundaries are* — and being a little suspicious of the version of your code that
worked perfectly the first time you tried it.

<!-- MEME: "I am once again asking" Bernie, or a detective-pointing-at-corkboard. Closing beat.
     Suggested file: assets/blog/detective-corkboard.gif  ·  search: "charlie conspiracy board gif" (It's Always Sunny) -->
![A frantic man in front of a red-string conspiracy corkboard connecting clues](../assets/blog/detective-corkboard.gif)

*Me, three coffees deep, mapping every place a stranger's input touches my database.*

---

PortfolioRank is live at **[portfoliorank.vercel.app](https://portfoliorank.vercel.app)** —
the code is [on GitHub](https://github.com/n8watkins/portfolio-rank) if you want to see how
any of this is actually wired up. Go vote on some portfolios. I promise the rankings are
real now.

*— Nathan ([n8builds.dev](https://n8builds.dev))*

---

### 🖼️ Meme drop-in guide

I left captioned placeholders above so the jokes work even with no images. To make it pop,
drop these into `assets/blog/` (any short looping gif works):

| File | The bit | Search term |
|------|---------|-------------|
| `this-is-fine.gif` | opening — calm dog, burning room | "this is fine gif" |
| `spiderman-pointing.gif` | concurrent requests pointing at each other | "spiderman pointing meme" |
| `confused-squint.gif` | the NUL-byte "that's impossible" moment | "confused math lady gif" |
| `dog-dragging-leash.gif` | fetch chasing a redirect | "dog pulling leash gif" |
| `roll-safe-think.gif` | the vote-cap bypass galaxy-brain | "roll safe think about it gif" |
| `detective-corkboard.gif` | closing — mapping trust boundaries | "charlie conspiracy board gif" |

(Giphy/Tenor let you grab the `.gif` directly. Keep them small so the post loads fast.)
