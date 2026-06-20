# Plan: Save / Share / Lists

Goal (owner's words): people should be able to **save** portfolios they like,
**share** them (from the detail view *and* while voting), and keep **different
named lists**. Backed by the existing **Turso** DB (signed-in, durable,
cross-device, shareable) — not just localStorage.

## Data model (add to `ensureSchema()` in lib/db.ts)

```sql
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,            -- rater_id (gh:.. / g:..); human only
  name TEXT NOT NULL,
  slug TEXT UNIQUE,               -- short random id for sharing (e.g. nanoid)
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lists_owner_idx ON lists (owner);

CREATE TABLE IF NOT EXISTS list_items (
  list_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (list_id, url)      -- one entry per url per list
);
```

- **Default "Saved" list:** lazily create a list named `Saved` per owner on first
  save (the ♥ button writes there). Other lists are user-created collections.
- **Sharing:** every list has a `slug`; a public list renders read-only at
  `/list/[slug]`. Sharing a single *portfolio* needs no list — just share its
  `/p/[slug]` URL.

## API (all under `app/api/`)

- `POST /api/save  { url }` → toggle url in the owner's default "Saved" list
  (create the list if missing). Returns `{ saved: boolean }`. Sign-in required
  (return 403 `signin_required` for anon → client opens SignInModal, same as voting).
- `GET  /api/save?urls=a,b,c` → `{ saved: string[] }` so cards/detail can show the
  filled-vs-empty heart. (Or fold the saved state into the existing GET /api/rank
  and /p/[slug] data to avoid an extra request.)
- `GET  /api/lists` → owner's lists (+ counts).
- `POST /api/lists  { name }` → create a named list (assign a slug).
- `POST /api/lists/[id]/items  { url }` / `DELETE …?url=` → add/remove in a specific list.
- (later) `PATCH /api/lists/[id]` rename / toggle is_public; `DELETE /api/lists/[id]`.

Reuse `getRater()` (lib/rater.ts); only `type==="human"` may save. Validate urls
with `isKnownPortfolio` (lib/roster.ts), same as voting, to keep it roster-only.

## UI

- **Detail page** (`app/p/[slug]`): a **♥ Save** toggle + a **Share** button next
  to "Visit site". Share = `navigator.share({url})` on mobile, copy-link fallback
  on desktop (a tiny client `ShareButton` component).
- **/rank cards** (`app/rank/page.tsx`): a small **♥** on each card (save while
  voting) — sits next to the existing ⭐ Super button overlay. Optional Share too.
- **Account dropdown** (components/AuthButton.tsx): add **"My lists"** → `/lists`.
- **`/lists`** (signed-in): my lists, create/rename/delete, open a list.
- **`/list/[slug]`** (public, read-only): the shared list — grid of its portfolios,
  "by {owner}" attribution, shareable. Reuse the PortfolioGrid card styling.

## Phasing (ship in order; each is independently useful)

1. **Quick Save (♥) + Share a portfolio.** Schema + `/api/save` + ♥ on detail &
   rank cards + ShareButton + a `/saved` view. (Sharing a portfolio link needs no
   auth.) ← most value, do first.
2. **Named lists.** `/api/lists` + `/lists` page + "add to list" picker on the ♥.
3. **Public shareable lists.** `/list/[slug]` page + is_public + share-list button.

## Notes / gotchas

- Anon users: prompt sign-in to save (consistent with the vote gate). Could later
  let anon save to localStorage and claim on sign-in (mirrors the practice-vote
  claim flow in app/api/claim) — defer.
- Saved state on cards needs the saved-set; cheapest is to add it to the existing
  GET /api/rank response (rater already resolved there) rather than a 2nd fetch.
- Keep `app/api/save` writes atomic (single statement upsert/delete); no ELO
  involved so no transaction gymnastics needed.
- `/list/[slug]` should be `force-dynamic` (reads DB) and get OG metadata
  (generateMetadata) so shared lists preview nicely — reuse the pattern from
  `app/p/[slug]/page.tsx`.
