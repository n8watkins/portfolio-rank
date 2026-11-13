// GitHub repositories tagged as a portfolio, with a website set
// (docs/DISCOVERY.md "Sources"). The pilot's best source: 71% passed the
// code checks.
//
// One source per topic ("github:portfolio", ...). Its cursor is the range of
// creation days already read, { newest, oldest }:
//   forward   repos created after `newest`, up to yesterday (a finished
//             day, so a window is never read half-full);
//   backfill  whole months before `oldest`, a few per run (backMonths),
//             back to BACKFILL_FLOOR, so the back catalog drains slowly.
// The search API returns at most 1,000 results per query, so a window with
// more is split in half until each part fits.
//
// A github.io site is swapped for the owner's own domain when their
// profile names one (the pilot made 272 such swaps), and each owner gives
// at most one site per run (the custom domain wins).
import { normalizeCandidate } from "../normalize.mjs";

export const TOPICS = ["portfolio", "portfolio-website", "personal-website", "developer-portfolio"];
export const BACKFILL_FLOOR = "2012-01-01";
const API = "https://api.github.com";

const day = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => day(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000));
const monthStart = (s) => `${s.slice(0, 7)}-01`;

/** The windows a run reads: forward from `newest`, then up to `backMonths` whole months before `oldest`. */
export function plan(cursor, { now = new Date(), backMonths = 2, firstDays = 30 } = {}) {
  const yesterday = addDays(day(now), -1);
  const newest = cursor?.newest ?? addDays(yesterday, -firstDays);
  const oldest = cursor?.oldest ?? addDays(newest, 1);
  const windows = [];
  if (newest < yesterday) windows.push({ from: addDays(newest, 1), to: yesterday, dir: "forward" });
  let end = addDays(oldest, -1);
  for (let i = 0; i < backMonths && end >= BACKFILL_FLOOR; i++) {
    const from = monthStart(end) < BACKFILL_FLOOR ? BACKFILL_FLOOR : monthStart(end);
    windows.push({ from, to: end, dir: "back" });
    end = addDays(from, -1);
  }
  return { windows, newest, oldest };
}

/**
 * Reads one topic from its cursor. Returns { items, cursor, requests }: the
 * cursor covers only the windows read in full (a failure stops the run
 * there, and the next run reads the rest).
 * @param {{ http: ReturnType<import("../http.mjs").createHttp>, log: (s: string) => void, now?: Date, caps: { backMonths: number, maxItems: number } }} ctx
 */
export async function readTopic(ctx, topic, cursor) {
  const { windows, newest, oldest } = plan(cursor, { now: ctx.now, backMonths: ctx.caps.backMonths });
  const next = { newest, oldest };
  const repos = [];
  for (const w of windows) {
    if (repos.length >= ctx.caps.maxItems) break;
    try {
      repos.push(...(await searchWindow(ctx, `topic:${topic} archived:false`, w.from, w.to)));
    } catch (e) {
      ctx.log(`github:${topic} ${w.from}..${w.to}: ${String(e?.message ?? e).slice(0, 160)}; stopping here`);
      break;
    }
    if (w.dir === "forward") next.newest = w.to;
    else next.oldest = w.from;
  }
  const items = [];
  for (const r of repos) {
    if (!r.homepage || r.fork || r.archived) continue;
    const n = normalizeCandidate(r.homepage);
    if (!n.ok) continue;
    items.push({
      url: n.url,
      source: "github",
      owner: String(r.owner?.login ?? "").toLowerCase(),
      ownerType: r.owner?.type,
      context: { repo: r.full_name, description: (r.description ?? "").slice(0, 200), topics: (r.topics ?? []).slice(0, 20) },
    });
  }
  await swapToOwnDomain(ctx, items);
  return { items: onePerOwner(items), cursor: next };
}

async function searchWindow(ctx, base, from, to) {
  const q = `${base} created:${from}..${to}`;
  const first = await ctx.http.json(`${API}/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=1`);
  const total = Number(first?.total_count ?? 0);
  if (total > 1000 && from < to) {
    const mid = day(new Date((Date.parse(`${from}T00:00:00Z`) + Date.parse(`${to}T00:00:00Z`)) / 2));
    return [...(await searchWindow(ctx, base, from, mid)), ...(await searchWindow(ctx, base, addDays(mid, 1), to))];
  }
  const out = [...(first?.items ?? [])];
  for (let page = 2; page <= 10 && out.length < Math.min(total, 1000); page++) {
    const res = await ctx.http.json(`${API}/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
    if (!res?.items?.length) break;
    out.push(...res.items);
  }
  ctx.log(`github ${q}: ${total} repos, ${out.length} read`);
  return out;
}

const isPages = (url) => /\.github\.io$/i.test(new URL(url).hostname);

/** github.io sites become the owner's own domain when their profile names one (GraphQL, 100 owners a request). */
async function swapToOwnDomain(ctx, items) {
  if (!ctx.graphql) return;
  const owners = [...new Set(items.filter((i) => i.ownerType === "User" && isPages(i.url)).map((i) => i.owner))];
  for (let i = 0; i < owners.length; i += 100) {
    const batch = owners.slice(i, i + 100);
    const query = `query{${batch.map((l, j) => `u${j}:user(login:${JSON.stringify(l)}){login websiteUrl}`).join(" ")}}`;
    let data = null;
    try {
      data = await ctx.graphql(query);
    } catch (e) {
      ctx.log(`github profiles: ${String(e?.message ?? e).slice(0, 120)}`);
      continue;
    }
    const site = new Map();
    for (const u of Object.values(data ?? {})) {
      if (!u?.websiteUrl) continue;
      const n = normalizeCandidate(u.websiteUrl);
      if (n.ok && !isPages(n.url)) site.set(String(u.login).toLowerCase(), n.url);
    }
    for (const it of items) {
      const own = site.get(it.owner);
      if (own && isPages(it.url)) {
        it.context = { ...it.context, pages: it.url };
        it.url = own;
      }
    }
  }
}

/** One site per owner: a custom domain beats a github.io page. */
export function onePerOwner(items) {
  const by = new Map();
  const rest = [];
  for (const it of items) {
    if (!it.owner) {
      rest.push(it);
      continue;
    }
    const prev = by.get(it.owner);
    if (!prev || (isPages(prev.url) && !isPages(it.url))) by.set(it.owner, it);
  }
  return [...by.values(), ...rest].map((it) => ({ url: it.url, source: it.source, context: it.context, author: it.owner || null }));
}
