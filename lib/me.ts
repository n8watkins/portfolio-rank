import feed from "@/data/feed.json";
import { db, ensureSchema } from "@/lib/db";
import { heroOf, shotBases } from "@/lib/shots";
import { hiddenUrls } from "@/lib/roster";
import { ownedJobs } from "@/lib/grader/server";
import { readJob } from "@/lib/grader/jobs.mjs";
import { publicJob } from "@/lib/grader/view.mjs";
import { emailState } from "@/lib/grader/notify.mjs";
import { gradedPool } from "@/lib/grader/report.mjs";
import { siteKeyOf } from "@/lib/grader/url.mjs";
import { AI_CRITERIA } from "@/pipeline/rubric.mjs";
import { domainOf, reportPath } from "@/lib/home";

// The visitor's own portfolio page (/me): their latest grade, read through
// the signed owner cookie (lib/grader/server.ts ownedJobs), so it is never
// cached and never shown to anyone else.

type FeedRow = { name: string; url: string; tagline?: string };
const FEED = feed as FeedRow[];

let listedByKey: Map<string, FeedRow> | null = null;
/** The listed portfolio a grade is about, if it is on the list. */
function listedSite(siteKey: string): FeedRow | null {
  if (!listedByKey) {
    listedByKey = new Map();
    for (const p of FEED) {
      try {
        listedByKey.set(siteKeyOf(p.url), p);
      } catch {}
    }
  }
  return listedByKey.get(siteKey) ?? null;
}

type Step = { key: string; label: string; state: "done" | "running" | "waiting" | "pending" | "needs_key" | "failed" | "off" };
type Line = { id: string; label: string; pass?: boolean | null; detail?: string; score?: number | null; note?: string };
type Fix = { criterion: string; title: string; why: string; by: "ai" | "code" };
type SiteLink = { url: string; name: string; domain: string; tier: string; path: string };

/** GET /api/grade/<id>'s answer (lib/grader/view.mjs publicJob). */
export type Job = {
  id: string;
  url: string;
  domain: string;
  status: string;
  reason: string | null;
  ownKey: boolean;
  createdAt: string;
  steps: Step[];
  shots: { hero: string; mobile: string } | null;
  email: { requested: boolean; sent: boolean };
  checks: { ok: boolean; message?: string } | null;
  report: null | {
    tier: string;
    isPortfolio: boolean | number | null;
    roles: string[];
    facts: Line[];
    judgments: Line[];
    strengths: Fix[];
    fixes: Fix[];
    percentile: { rank: number; total: number; topPct: number; ahead: number } | null;
    similar: SiteLink[];
    better: { criterion: string; label: string; yours: number; sites: SiteLink[] }[];
    model: string | null;
    gradedAt: string;
    regradeAfter: string | null;
  };
};

export type Standing = { id: string; label: string; score: number; vsAll: number; vsRole: number | null };

export type Listed = {
  url: string;
  name: string;
  path: string;
  /** Rank on the people's board (ELO), when it has votes. */
  people: { rank: number; elo: number; votes: number } | null;
  fights: { won: boolean; other: { url: string; name: string; domain: string; hero: string | null }; at: string }[];
};

export type Mine = {
  job: Job;
  /** The shot to show: the grade's own capture, else the list's. */
  hero: string | null;
  name: string;
  tagline: string | null;
  standings: { rows: Standing[]; total: number; role: string | null; peers: number } | null;
  listed: Listed | null;
  /** Screenshots of the portfolios the report points to (similar, doing it better). */
  heroes: Record<string, string>;
  /** When this was read: what "re-grade available in N days" counts from. */
  at: number;
};

/** Ties count as half: "better than X%" of those portfolios. */
const better = (mine: number, all: number[]) =>
  all.length ? Math.round((100 * all.reduce((n, v) => n + (v < mine ? 1 : v === mine ? 0.5 : 0), 0)) / all.length) : 0;

type PoolSite = { url: string; axes: Record<string, number | null>; roles: string[] };

async function standingsOf(job: Job): Promise<Mine["standings"]> {
  const rep = job.report;
  if (!rep) return null;
  const pool = ((await gradedPool(db())) as PoolSite[]).filter((p) => {
    try {
      return siteKeyOf(p.url) !== siteKeyOf(job.url);
    } catch {
      return true;
    }
  });
  if (pool.length === 0) return null;
  const roles = new Set(rep.roles.map((r) => r.toLowerCase()));
  const peers = pool.filter((p) => p.roles.some((r) => roles.has(String(r).toLowerCase())));
  // A comparison with a handful of peers says nothing: shown from 20.
  const usePeers = peers.length >= 20;
  const rows: Standing[] = [];
  for (const c of AI_CRITERIA as { id: string; name: string }[]) {
    const j = rep.judgments.find((x) => x.id === c.id);
    if (typeof j?.score !== "number") continue;
    const values = (list: PoolSite[]) => list.map((p) => p.axes[c.id]).filter((v): v is number => typeof v === "number");
    rows.push({ id: c.id, label: c.name, score: j.score, vsAll: better(j.score, values(pool)), vsRole: usePeers ? better(j.score, values(peers)) : null });
  }
  return { rows, total: pool.length, role: usePeers ? (rep.roles[0] ?? null) : null, peers: usePeers ? peers.length : 0 };
}

async function listedOf(site: FeedRow): Promise<Listed> {
  const client = db();
  const [rating, fights] = await Promise.all([
    client.execute({ sql: "SELECT elo, votes FROM ratings WHERE url = ?", args: [site.url] }),
    client.execute({
      // votes_winner_idx and votes_loser_idx (lib/schema.mjs): a few rows, not the log.
      sql: `SELECT * FROM (
              SELECT id, 1 AS won, loser AS other, created_at FROM votes WHERE winner = ? ORDER BY id DESC LIMIT 5
            ) UNION ALL SELECT * FROM (
              SELECT id, 0 AS won, winner AS other, created_at FROM votes WHERE loser = ? ORDER BY id DESC LIMIT 5
            ) ORDER BY id DESC LIMIT 5`,
      args: [site.url, site.url],
    }),
  ]);
  let people: Listed["people"] = null;
  const r = rating.rows[0];
  if (r && Number(r.votes) > 0) {
    const hidden = await hiddenUrls();
    const above = await client.execute({ sql: "SELECT url FROM ratings WHERE votes >= 1 AND elo > ?", args: [Number(r.elo)] });
    const listed = new Set(FEED.map((p) => p.url));
    const rank = above.rows.filter((x) => listed.has(String(x.url)) && !hidden.has(String(x.url))).length + 1;
    people = { rank, elo: Number(r.elo), votes: Number(r.votes) };
  }
  const others = fights.rows.map((x) => String(x.other));
  const shots = await shotBases(others);
  const names = new Map(FEED.map((p) => [p.url, p.name]));
  return {
    url: site.url,
    name: site.name,
    path: reportPath(site.url),
    people,
    fights: fights.rows.map((x) => {
      const url = String(x.other);
      return {
        won: Number(x.won) === 1,
        other: { url, name: names.get(url) ?? domainOf(url), domain: domainOf(url), hero: shots.has(url) ? heroOf(shots.get(url)!) : null },
        at: String(x.created_at),
      };
    }),
  };
}

/** This browser's latest grade (newest first, skipping deleted or expired ones), or null. */
export async function myPortfolio(): Promise<Mine | null> {
  const ids = await ownedJobs();
  if (ids.length === 0) return null;
  await ensureSchema();
  const client = db();
  for (const id of [...ids].reverse()) {
    const raw = await readJob(client, id);
    if (!raw) continue;
    const job = publicJob(raw, { mine: true, emails: await emailState(client, id) }) as Job;
    const site = listedSite(String(raw.site_key));
    let hero = job.shots?.hero ?? null;
    if (!hero && site) {
      const shots = await shotBases([site.url]);
      hero = shots.has(site.url) ? heroOf(shots.get(site.url)!) : null;
    }
    const linked = job.report ? [...job.report.similar, ...job.report.better.flatMap((b) => b.sites)].map((x) => x.url) : [];
    const [standings, listed, linkedShots] = await Promise.all([
      standingsOf(job),
      site && job.report ? listedOf(site) : Promise.resolve(null),
      shotBases([...new Set(linked)]),
    ]);
    return {
      job,
      hero,
      name: site?.name ?? job.domain,
      tagline: site?.tagline ?? null,
      standings,
      listed,
      heroes: Object.fromEntries([...linkedShots].map(([u, b]) => [u, heroOf(b)])),
      at: Date.now(),
    };
  }
  return null;
}
