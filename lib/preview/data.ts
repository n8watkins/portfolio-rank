// Data for the redesign preview (branch preview/redesign). Nothing here talks
// to a database or an API.
//
// Real: the roster (data/feed.json), the screenshots (the public shots bucket,
// keyed like pipeline/capture.mjs does) and, when ai-grades.csv sits in the
// repo root (it is gitignored), the June Gemini grades.
// Sample: everything that does not exist yet - the People ranking, confidence
// bands, weekly movement, measured facts, grade reports and visitor states.
// Pages mark sample values with <SampleTag />.

import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import path from "path";
import feed from "@/data/feed.json";

const SHOTS = "https://pub-680e930bd59047488d688e63d7477fee.r2.dev";

export type Tier = "S" | "A" | "B" | "C" | "D";

export type AiGrade = {
  tier: Tier;
  design: number;
  fiveSecond: number;
  story: number;
  writing: number;
  memorability: number;
  motion: number;
  model: string;
  /** True when it came from ai-grades.csv, false when made up for the preview. */
  real: boolean;
};

export type Site = {
  name: string;
  url: string;
  tagline?: string;
  slug: string;
  domain: string;
  /** Capture base: `${base}/hero.jpg`, `${base}/mobile.jpg`. */
  shot: string;
  grade?: AiGrade;
};

export type View = "merged" | "ai" | "people";

export type Ranked = Site & {
  /** Score shown in this view (0-100 for merged and AI, ELO for people). */
  score: number;
  band: number;
  rank: number;
  tied: boolean;
  /** Places gained this week (sample); negative is a drop. */
  move: number;
  aiRank: number;
  peopleRank: number;
  disagree: boolean;
  /** The ranks this site could hold given its uncertainty (score ± band). */
  likely: [number, number];
  /** Share of graded portfolios at or above this rank, rounded up. */
  topPct: number;
};

function hashNum(s: string, salt = ""): number {
  const h = createHash("sha1").update(salt + s).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

export function domainOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "")).toLowerCase();
  } catch {
    return url;
  }
}

function slugOf(url: string): string {
  return domainOf(url)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const shotKey = (url: string) => createHash("sha1").update(url).digest("hex").slice(0, 16);

function readGrades(): Map<string, AiGrade> {
  const out = new Map<string, AiGrade>();
  const file = path.join(process.cwd(), "ai-grades.csv");
  if (!existsSync(file)) return out;
  const lines = readFileSync(file, "utf8").trim().split("\n").slice(1);
  for (const line of lines) {
    const f = line.replace(/^"|"$/g, "").split('","');
    if (f.length < 11 || f[1] !== "true") continue;
    const n = (i: number) => Number(f[i]);
    out.set(f[9], {
      tier: f[0] as Tier,
      design: n(2),
      fiveSecond: n(3),
      story: n(4),
      writing: n(5),
      memorability: n(6),
      motion: n(7),
      model: f[10],
      real: true,
    });
  }
  return out;
}

function sampleGrade(url: string): AiGrade {
  const g = (salt: string) => 2 + Math.round(hashNum(url, salt) * 3);
  const design = g("d");
  const sum = design + g("f") + g("s") + g("w") + g("m");
  const tier: Tier = sum >= 23 ? "S" : sum >= 20 ? "A" : sum >= 16 ? "B" : sum >= 12 ? "C" : "D";
  return { tier, design, fiveSecond: g("f"), story: g("s"), writing: g("w"), memorability: g("m"), motion: 1 + Math.round(hashNum(url, "mo") * 4), model: "sample", real: false };
}

type Cache = { roster: Site[]; bySlug: Map<string, Site>; pool: Site[]; realGrades: boolean };
let cache: Cache | null = null;

function load(): Cache {
  if (cache) return cache;
  const grades = readGrades();
  const seen = new Set<string>();
  const roster: Site[] = [];
  for (const p of feed as { name: string; url: string; tagline?: string }[]) {
    let slug = slugOf(p.url) || "site";
    while (seen.has(slug)) slug += "-2";
    seen.add(slug);
    roster.push({
      name: p.name,
      url: p.url,
      tagline: p.tagline,
      slug,
      domain: domainOf(p.url),
      shot: `${SHOTS}/${shotKey(p.url)}`,
      grade: grades.get(p.url),
    });
  }
  const realGrades = grades.size > 0;
  // Without the CSV, a deterministic made-up grade for every 3rd site.
  if (!realGrades) roster.forEach((s, i) => i % 3 === 0 && (s.grade = sampleGrade(s.url)));
  const pool = roster.filter((s) => s.grade);
  cache = { roster, bySlug: new Map(roster.map((s) => [s.slug, s])), pool, realGrades };
  return cache;
}

export const roster = () => load().roster;
export const siteBySlug = (slug: string) => load().bySlug.get(slug);
export const hasRealGrades = () => load().realGrades;

/** 0-100 from the six Gemini sub-grades; motion counts least. */
export function aiScore(g: AiGrade): number {
  const raw = g.design * 3 + g.fiveSecond * 2 + g.story * 2 + g.writing * 2 + g.memorability * 2 + g.motion * 0.5;
  return Math.round((raw / (5 * 11.5)) * 100);
}

function rankBy<T>(items: T[], score: (t: T) => number): Map<T, { rank: number; tied: boolean }> {
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  const out = new Map<T, { rank: number; tied: boolean }>();
  sorted.forEach((t, i) => {
    const first = sorted.findIndex((u) => score(u) === score(t));
    const count = sorted.filter((u) => score(u) === score(t)).length;
    out.set(t, { rank: first + 1, tied: count > 1 });
    void i;
  });
  return out;
}

let boards: Record<View, Ranked[]> | null = null;

/** The three leaderboard views over every graded site. */
export function leaderboard(view: View): Ranked[] {
  if (!boards) {
    const pool = load().pool;
    const ai = new Map(pool.map((s) => [s, aiScore(s.grade!)]));
    // Sample People ELO: loosely follows the AI score, with real disagreement.
    const people = new Map(
      pool.map((s) => [s, Math.round(1200 + (ai.get(s)! - 60) * 5 + (hashNum(s.url, "p") - 0.5) * 220)])
    );
    const aiRanks = rankBy(pool, (s) => ai.get(s)!);
    const peopleRanks = rankBy(pool, (s) => people.get(s)!);
    const n = pool.length;
    const merged = new Map(
      pool.map((s) => [
        s,
        Math.round((100 - ((aiRanks.get(s)!.rank + peopleRanks.get(s)!.rank) / 2 / n) * 100) * 10) / 10,
      ])
    );
    const visitorUrl = sampleVisitorSite().url;
    const make = (v: View, scoreOf: Map<Site, number>, band: (s: Site) => number): Ranked[] => {
      const ranks = rankBy(pool, (s) => scoreOf.get(s)!);
      const scores = pool.map((s) => scoreOf.get(s)!);
      return pool
        .map((s) => {
          const sc = scoreOf.get(s)!;
          const b = band(s);
          const lo = scores.filter((x) => x > sc + b).length + 1;
          const hi = scores.filter((x) => x >= sc - b).length;
          const ar = aiRanks.get(s)!.rank;
          const pr = peopleRanks.get(s)!.rank;
          return {
            ...s,
            score: scoreOf.get(s)!,
            band: band(s),
            rank: ranks.get(s)!.rank,
            tied: ranks.get(s)!.tied,
            move: v === "ai" ? 0 : s.url === visitorUrl ? (v === "people" ? 6 : 4) : Math.round((hashNum(s.url, "mv" + v) - 0.45) * 14),
            aiRank: ar,
            peopleRank: pr,
            disagree: Math.abs(ar - pr) > n * 0.12,
            likely: [lo, Math.max(lo, hi)] as [number, number],
            topPct: Math.max(1, Math.ceil((ranks.get(s)!.rank / n) * 100)),
          };
        })
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    };
    boards = {
      ai: make("ai", ai, () => 0),
      people: make("people", people, (s) => 18 + Math.round(hashNum(s.url, "b") * 40)),
      merged: make("merged", merged, (s) => Math.round((0.2 + hashNum(s.url, "mb") * 0.7) * 10) / 10),
    };
  }
  return boards[view];
}

/** This week's biggest movers in the merged view (sample movement). */
export function climbers(limit = 5): Ranked[] {
  return leaderboard("merged")
    .filter((r) => r.rank <= 150)
    .sort((a, b) => b.move - a.move || a.rank - b.rank)
    .slice(0, limit);
}

export const rosterCount = () => load().roster.length;

/** Where a grade would land among every listed portfolio. */
export function estimate(g: AiGrade): { rank: number; total: number; topPct: number } {
  const pool = load().pool;
  const score = aiScore(g);
  const above = pool.filter((s) => aiScore(s.grade!) > score).length;
  const pct = above / pool.length;
  const total = rosterCount();
  return {
    rank: Math.max(1, Math.round((pct * total) / 10) * 10 || 1),
    total,
    topPct: Math.max(1, Math.ceil(pct * 20) * 5),
  };
}

/** Pairs for the face-off, from the top of the merged board. */
export function faceoffPairs(count = 12): [Ranked, Ranked][] {
  const top = leaderboard("merged").slice(0, 160);
  const out: [Ranked, Ranked][] = [];
  for (let i = 0; i < count; i++) {
    const a = top[(i * 37 + 5) % top.length];
    const b = top[(i * 53 + 11) % top.length];
    if (a.url !== b.url) out.push([a, b]);
  }
  return out;
}

// ---------------------------------------------------------------- reports

export type Fact = { label: string; pass: boolean; detail: string; criterion: string };
export type SubGrade = { label: string; value: number; note: string; criterion: string };

export type Report = {
  site: Site;
  grade: AiGrade;
  facts: Fact[];
  speed: number;
  subs: SubGrade[];
  improvements: { title: string; why: string; criterion: string }[];
  est: { rank: number; total: number; topPct: number };
  gradedOn: string;
};

const HOSTED = /\.(vercel\.app|netlify\.app|github\.io|framer\.website|web\.app|pages\.dev|onrender\.com|herokuapp\.com)$/;

const NOTES: Record<string, string[]> = {
  design: ["Layout feels unplanned; spacing and type sizes vary.", "Clean but generic; a template look.", "Consistent type and spacing, a clear visual idea.", "Polished, distinctive and consistent throughout."],
  fiveSecond: ["Hard to tell who this is or what they do.", "Name is clear, the role takes a scroll.", "Name and role are clear above the fold.", "Name, role and a reason to stay, all in one glance."],
  story: ["Projects are a list of names.", "Projects say what, not why.", "Most projects explain the problem and the result.", "Every project tells what, why and what changed."],
  writing: ["Typos and filler slow the reader.", "Readable, a little long-winded.", "Plain and specific.", "Tight, specific, sounds like a person."],
  memorability: ["Nothing sets it apart.", "One nice touch.", "A clear personality.", "You'd remember it tomorrow."],
};

const note = (key: string, v: number) => NOTES[key][Math.max(0, Math.min(3, v - 2))];

export function report(site: Site): Report {
  const grade = site.grade ?? sampleGrade(site.url);
  const h = (salt: string) => hashNum(site.url, salt);
  const broken = h("bl") < 0.35 ? 1 + Math.floor(h("bn") * 3) : 0;
  const projects = 4 + Math.floor(h("pr") * 5);
  const ownDomain = !HOSTED.test(new URL(site.url).hostname);
  const speed = 55 + Math.round(h("sp") * 44);
  const facts: Fact[] = [
    { label: "Resume linked", pass: h("cv") > 0.3, detail: h("cv") > 0.3 ? "PDF, opens" : "No resume link found", criterion: "resume" },
    { label: "GitHub linked", pass: h("gh") > 0.15, detail: h("gh") > 0.15 ? "Profile reachable" : "No GitHub link found", criterion: "github" },
    { label: "Project links work", pass: broken === 0, detail: broken === 0 ? `All ${projects} open` : `${broken} of ${projects} broken`, criterion: "links" },
    { label: "Own domain", pass: ownDomain, detail: ownDomain ? site.domain.split("/")[0] : "On a shared host", criterion: "domain" },
    { label: "Contact on page", pass: h("ct") > 0.2, detail: h("ct") > 0.2 ? "Email or form found" : "No way to reach you", criterion: "contact" },
    { label: "Phone speed", pass: speed >= 70, detail: `${speed}/100 on phones`, criterion: "speed" },
  ];
  const subs: SubGrade[] = [
    { label: "Design", value: grade.design, note: note("design", grade.design), criterion: "design" },
    { label: "First 5 seconds", value: grade.fiveSecond, note: note("fiveSecond", grade.fiveSecond), criterion: "five-second" },
    { label: "Project stories", value: grade.story, note: note("story", grade.story), criterion: "story" },
    { label: "Writing", value: grade.writing, note: note("writing", grade.writing), criterion: "writing" },
    { label: "Memorable", value: grade.memorability, note: note("memorability", grade.memorability), criterion: "memorable" },
  ];
  const improvements: Report["improvements"] = [];
  if (broken) improvements.push({ title: `Fix ${broken} broken project ${broken === 1 ? "link" : "links"}`, why: "A recruiter who clicks a dead demo rarely clicks the next one.", criterion: "links" });
  const weakest = [...subs].sort((a, b) => a.value - b.value);
  for (const s of weakest) {
    if (improvements.length >= 3) break;
    if (s.value >= 5) continue;
    const tips: Record<string, [string, string]> = {
      "Project stories": ["Tell the story of your top 3 projects", "One line each: the problem, what you built, what changed."],
      "First 5 seconds": ["Say who you are and what you want above the fold", "Name, role and the kind of work you want, before any scroll."],
      Design: ["Pick one type scale and one spacing step", "Most of the 'template look' is uneven sizes and gaps."],
      Writing: ["Cut the intro to two sentences", "Specific beats long: name a stack, a number, a result."],
      Memorable: ["Add one thing only you would put there", "A side project, a photo, a voice. Something to remember you by."],
    };
    const [title, why] = tips[s.label];
    improvements.push({ title, why, criterion: s.criterion });
  }
  if (improvements.length < 3 && speed < 85) improvements.push({ title: "Make it load faster on phones", why: `Phone speed is ${speed}; compress the hero image first.`, criterion: "speed" });
  if (improvements.length < 3 && !ownDomain) improvements.push({ title: "Put it on your own domain", why: "About $12 a year, and it reads as yours.", criterion: "domain" });
  return {
    site,
    grade,
    facts,
    speed,
    subs,
    improvements: improvements.slice(0, 3),
    est: estimate(grade),
    gradedOn: "Nov 8, 2026",
  };
}

/** The sample "your portfolio" for the visitor states: a real A-tier site. */
export function sampleVisitorSite(): Site {
  const pool = load().pool;
  const a = pool.filter((s) => s.grade!.tier === "A");
  return a[Math.floor(a.length * 0.6)] ?? pool[0];
}

// ---------------------------------------------------------------- stats, profile

/** Live numbers for the home stats card. Portfolios and graded are real. */
export function stats() {
  const c = load();
  return {
    portfolios: c.roster.length,
    graded: c.pool.length,
    gradesThisWeek: 35, // sample
    votesToday: 1284, // sample
  };
}

/** Where AI and people disagree most, among the top 200 merged. */
export function disagreements(limit = 3): Ranked[] {
  const sorted = leaderboard("merged")
    .slice(0, 200)
    .filter((r) => r.disagree)
    .sort((a, b) => Math.abs(b.aiRank - b.peopleRank) - Math.abs(a.aiRank - a.peopleRank));
  // Mix both directions (AI higher, people higher) and avoid repeated ranks.
  const out: Ranked[] = [];
  const seen = new Set<number>();
  const aiHigher = sorted.filter((r) => r.aiRank < r.peopleRank);
  const peopleHigher = sorted.filter((r) => r.peopleRank < r.aiRank);
  for (let i = 0; out.length < limit && i < sorted.length; i++) {
    for (const r of [peopleHigher[i], aiHigher[i]]) {
      if (r && out.length < limit && !seen.has(r.aiRank)) {
        seen.add(r.aiRank);
        out.push(r);
      }
    }
  }
  return out;
}

export const ROLES: { key: string; label: string; re: RegExp }[] = [
  { key: "fullstack", label: "Full stack", re: /full.?stack/i },
  { key: "frontend", label: "Frontend", re: /front.?end|web dev/i },
  { key: "backend", label: "Backend", re: /back.?end/i },
  { key: "ai", label: "AI / ML", re: /\bai\b|machine learning|\bml\b|data scien|llm/i },
  { key: "mobile", label: "Mobile", re: /mobile|android|ios|flutter|react native/i },
  { key: "design", label: "Design / UX", re: /design|ux|\bui\b/i },
];

type SubKey = "design" | "fiveSecond" | "story" | "writing" | "memorability";

/** Share of a pool with a lower value, counting ties as half. */
function betterThan(pool: Site[], key: SubKey, v: number): number {
  let below = 0;
  let same = 0;
  for (const s of pool) {
    const x = s.grade![key];
    if (x < v) below++;
    else if (x === v) same++;
  }
  return Math.round(((below + same / 2) / pool.length) * 100);
}

export type Standing = { label: string; criterion: string; value: number; vsAll: number; vsRole: number };

export function profile(site: Site) {
  const c = load();
  const g = site.grade ?? sampleGrade(site.url);
  const role = ROLES.find((r) => site.tagline && r.re.test(site.tagline)) ?? ROLES[0];
  let peers = c.pool.filter((s) => s.tagline && role.re.test(s.tagline));
  if (peers.length < 20) peers = c.pool;
  const keys: [SubKey, string, string][] = [
    ["design", "Design", "design"],
    ["fiveSecond", "First 5 seconds", "five-second"],
    ["story", "Project stories", "story"],
    ["writing", "Writing", "writing"],
    ["memorability", "Memorable", "memorable"],
  ];
  const standings: Standing[] = keys.map(([k, label, criterion]) => ({
    label,
    criterion,
    value: g[k],
    vsAll: betterThan(c.pool, k, g[k]),
    vsRole: betterThan(peers, k, g[k]),
  }));
  const merged = leaderboard("merged").find((r) => r.url === site.url);
  const now = merged?.rank ?? 200;
  // Sample: eight weekly merged ranks ending at today's.
  const history = [64, 51, 47, 40, 33, 22, 4, 0].map((d, i) => ({
    week: ["Sep 20", "Sep 27", "Oct 4", "Oct 11", "Oct 18", "Oct 25", "Nov 1", "Nov 8"][i],
    rank: now + d,
  }));
  return { grade: g, role: role.label, peers: peers.length, standings, history, total: c.pool.length };
}

const SUB_OF: Record<string, SubKey> = {
  design: "design",
  "five-second": "fiveSecond",
  story: "story",
  writing: "writing",
  memorable: "memorability",
};

/** The report's fixes with an estimated effect on rank (sample model). */
export function recommendations(site: Site) {
  const rep = report(site);
  return rep.improvements.map((m) => {
    const key = SUB_OF[m.criterion];
    if (key) {
      const better = { ...rep.grade, [key]: Math.min(5, rep.grade[key] + 1) };
      const pool = load().pool;
      const total = rosterCount();
      const above = (g: AiGrade) => pool.filter((x) => aiScore(x.grade!) > aiScore(g)).length;
      // Sample: people weigh some criteria more than the AI score does.
      const pull: Record<SubKey, number> = { design: 1.4, fiveSecond: 1.25, story: 1.15, writing: 0.8, memorability: 0.95 };
      const gain = Math.max(0, Math.round(((above(rep.grade) - above(better)) / pool.length) * total * pull[key]));
      return { ...m, effect: gain > 0 ? `about ${gain} places higher if ${(rep.subs.find((x) => x.criterion === m.criterion)?.label ?? m.criterion).toLowerCase()} goes up one grade` : "holds your place against climbers" };
    }
    return { ...m, effect: "turns a failed check into a pass, about 15 places higher" };
  });
}

/** Rounds for "Guess the rank": real sites spread across the merged board. */
export function guessRounds() {
  const board = leaderboard("merged");
  const at = [3, 41, 118, 260, 17, 402, 74, 560, 9, 190];
  return at
    .map((i) => board[Math.min(i, board.length - 1)])
    .map((r) => ({
      name: r.name,
      domain: r.domain,
      shot: r.shot,
      slug: r.slug,
      tagline: r.tagline,
      merged: r.rank,
      ai: r.aiRank,
      people: r.peopleRank,
      tier: r.grade!.tier,
    }));
}
