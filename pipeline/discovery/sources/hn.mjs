// Hacker News through the Algolia API (public, no key; docs/DISCOVERY.md
// "Sources"). Three sources:
//
//   hn:comments  comments sharing the writer's own portfolio or personal
//                site ("my portfolio", "personal website"), cursor = the
//                time up to which comments are read ({ after })
//   hn:hired     "Ask HN: Who wants to be hired?" (one thread a month, about
//                600 posts): top-level posts only, cursor { after } for new
//                posts plus { backBefore } for older threads, a few a run
//   hn:share     the big "Share your personal site" threads (a few thousand
//                posts each, about one a year): cursor { done: [story ids] },
//                a few threads a run
//
// A post gives at most two links, reduced to the site's home page. Posts
// listing more are roundups, not someone sharing their own site. The upper
// bound of a window is an hour ago, so comments still being indexed are
// read by the next run instead of being skipped.
import { extractLinks, normalizeCandidate } from "../normalize.mjs";

const API = "https://hn.algolia.com/api/v1";
const DAY = 86400;

const hostOf = (u) => new URL(u).hostname;

/** The site links of one post: at most `max` home pages, none when the post links more (a roundup). */
export function postLinks(html, { max = 2 } = {}) {
  const roots = [];
  for (const link of extractLinks(html)) {
    const n = normalizeCandidate(link, { root: true });
    if (n.ok && !roots.some((r) => hostOf(r) === n.host)) roots.push(n.url);
  }
  return roots.length > max ? [] : roots;
}

/** Every hit of an Algolia query between two times, newest first, walking back past the 1,000-hit page cap. */
async function allHits(ctx, params, after, before) {
  const hits = [];
  let upper = before;
  for (let guard = 0; guard < 200; guard++) {
    const url = `${API}/search_by_date?${params}&hitsPerPage=1000&numericFilters=${encodeURIComponent(`created_at_i>${after},created_at_i<${upper}`)}`;
    const page = await ctx.http.json(url);
    const got = page?.hits ?? [];
    hits.push(...got);
    if (got.length < 1000) break;
    const oldest = Math.min(...got.map((h) => h.created_at_i));
    if (oldest >= upper) break;
    upper = oldest + 1;
  }
  return hits;
}

const nowSec = (ctx) => Math.floor((ctx.now ?? new Date()).getTime() / 1000);

/** hn:comments: comments that share the writer's own site, since the cursor. */
export async function readComments(ctx, cursor) {
  const bound = nowSec(ctx) - 3600;
  const after = cursor?.after ?? bound - 30 * DAY;
  const items = [];
  for (const q of ['"my portfolio"', '"personal website"', '"portfolio site"', '"my personal site"']) {
    for (const h of await allHits(ctx, `query=${encodeURIComponent(q)}&tags=comment`, after, bound)) {
      const text = String(h.comment_text ?? "");
      if (!/my (portfolio|personal (web)?site|website|site)|portfolio site/i.test(text.replace(/<[^>]+>/g, " "))) continue;
      for (const url of postLinks(text)) items.push({ url, source: "hn", author: h.author ?? null, context: { post: `hn:${h.objectID}` } });
    }
  }
  return { items, cursor: { after: bound } };
}

async function threadPosts(ctx, storyId, after, before) {
  const hits = await allHits(ctx, `tags=${encodeURIComponent(`comment,story_${storyId}`)}`, after, before);
  return hits.filter((h) => Number(h.parent_id) === Number(storyId));
}

/** hn:hired: new top-level posts in recent "Who wants to be hired?" threads, plus a few older threads. */
export async function readHired(ctx, cursor) {
  const bound = nowSec(ctx) - 3600;
  const after = cursor?.after ?? bound - 60 * DAY;
  const list = await ctx.http.json(`${API}/search_by_date?tags=${encodeURIComponent("story,author_whoishiring")}&query=${encodeURIComponent("who wants to be hired")}&hitsPerPage=1000`);
  const threads = (list?.hits ?? []).filter((h) => /who wants to be hired/i.test(h.title ?? "")).sort((a, b) => b.created_at_i - a.created_at_i);
  const items = [];
  const add = (h) => {
    for (const url of postLinks(String(h.comment_text ?? ""))) items.push({ url, source: "hn", author: h.author ?? null, context: { post: `hn:${h.objectID}` } });
  };
  // New posts: threads still taking posts (a thread gets most in its first weeks).
  for (const t of threads.filter((t) => t.created_at_i > after - 45 * DAY)) for (const h of await threadPosts(ctx, t.objectID, after, bound)) add(h);
  // Older threads, newest first, whole threads at a time.
  let backBefore = cursor?.backBefore ?? Math.min(...threads.filter((t) => t.created_at_i > after - 45 * DAY).map((t) => t.created_at_i), after);
  for (const t of threads.filter((t) => t.created_at_i < backBefore).slice(0, ctx.caps.hnBackThreads)) {
    for (const h of await threadPosts(ctx, t.objectID, 0, bound)) add(h);
    backBefore = t.created_at_i;
  }
  return { items, cursor: { after: bound, backBefore } };
}

const SHARE_TITLE = /(share|show|post|drop|link)\b.*\b(your|personal)\b.*\b(site|website|blog|homepage|portfolio)/i;

/** hn:share: the "Share your personal site" threads not read yet, a few a run. */
export async function readShare(ctx, cursor) {
  const done = new Set((cursor?.done ?? []).map(String));
  const found = new Map();
  for (const q of ["personal site", "personal website", "personal blog", "portfolio"]) {
    const res = await ctx.http.json(`${API}/search?tags=ask_hn&query=${encodeURIComponent(q)}&numericFilters=${encodeURIComponent("num_comments>100")}&hitsPerPage=50`);
    for (const h of res?.hits ?? []) if (SHARE_TITLE.test(h.title ?? "")) found.set(String(h.objectID), h);
  }
  const todo = [...found.values()].filter((t) => !done.has(String(t.objectID))).sort((a, b) => b.created_at_i - a.created_at_i).slice(0, ctx.caps.hnShareThreads);
  const items = [];
  for (const t of todo) {
    for (const h of await threadPosts(ctx, t.objectID, 0, nowSec(ctx))) {
      for (const url of postLinks(String(h.comment_text ?? ""))) items.push({ url, source: "hn", author: h.author ?? null, context: { post: `hn:${h.objectID}` } });
    }
    done.add(String(t.objectID));
  }
  return { items, cursor: { done: [...done] } };
}
