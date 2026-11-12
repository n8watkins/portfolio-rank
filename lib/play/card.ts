import { db, ensureSchema } from "@/lib/db";
import { factLines, gradedPool, judgmentLines } from "@/lib/grader/report.mjs";
import { hiringGroups, placeIn } from "@/lib/grader/present.mjs";

// What the games show about a portfolio beside its screenshot: the public
// grade (only the top tiers get a letter and a "top N%", as on the portfolio
// page, so no one gets a public "D"), the roles the page claims, the hiring
// manager's three questions as a one-word answer each, and its face-off
// record. Public data only: nothing here depends on who is looking.
//
// Two shapes: `PlayCard` rides along with every face-off pair (/api/rank),
// `PlayDetails` adds what the inline Details panel opens (/api/play/card).

const PUBLIC_TIERS = new Set(["S", "A", "B"]);

export type CheckState = "ok" | "fix" | "unknown";
export type PlayCard = {
  /** Graded at all (the tier itself may stay private). */
  graded: boolean;
  /** S, A or B; null for an ungraded site, a lower tier or a hidden grade. */
  tier: string | null;
  /** "Top N%" among graded portfolios, shown with a public tier only. */
  topPct: number | null;
  roles: string[];
  /** The hiring manager's three questions (lib/grader/present.mjs FACT_GROUPS). */
  checks: { key: string; title: string; state: CheckState; toFix: string[] }[];
  votes: number;
  wins: number;
};
export type PlayDetails = PlayCard & {
  groups: ReturnType<typeof hiringGroups>;
  judgments: { id: string; label: string; score: number | null; note: string }[];
  model: string | null;
  /** The listed portfolio's share card (app/p/[slug]/opengraph-image). */
  shareImage: string;
  profile: string;
};

const parse = (v: unknown): Record<string, unknown> | null => {
  if (typeof v !== "string" || !v) return null;
  try {
    const g = JSON.parse(v);
    return g && typeof g === "object" ? g : null;
  } catch {
    return null;
  }
};

type Row = { url: string; grade: Record<string, unknown> | null; hidden: boolean; votes: number; wins: number };

async function rows(urls: string[]): Promise<Map<string, Row>> {
  await ensureSchema();
  const marks = urls.map(() => "?").join(",");
  const [p, o, r, w] = await db().batch(
    [
      { sql: `SELECT url, ai_rubric FROM portfolios WHERE url IN (${marks})`, args: urls },
      { sql: `SELECT url, hide_grade FROM portfolio_owner WHERE url IN (${marks})`, args: urls },
      { sql: `SELECT url, votes FROM ratings WHERE url IN (${marks})`, args: urls },
      // Indexed on (winner, id): a count per site, never a scan of the log.
      { sql: `SELECT winner AS url, COUNT(*) AS n FROM votes WHERE winner IN (${marks}) GROUP BY winner`, args: urls },
    ],
    "read"
  );
  const by = <T>(rs: typeof p, f: (row: (typeof p.rows)[number]) => T) => new Map(rs.rows.map((x) => [String(x.url), f(x)]));
  const grades = by(p, (x) => parse(x.ai_rubric));
  const hidden = by(o, (x) => Number(x.hide_grade ?? 0) === 1);
  const votes = by(r, (x) => Number(x.votes ?? 0));
  const wins = by(w, (x) => Number(x.n ?? 0));
  return new Map(
    urls.map((u) => [u, { url: u, grade: grades.get(u) ?? null, hidden: hidden.get(u) ?? false, votes: votes.get(u) ?? 0, wins: wins.get(u) ?? 0 }])
  );
}

function cardOf(row: Row, pool: { url: string; mu: number }[]): PlayCard {
  const g = row.hidden ? null : row.grade;
  const tierRaw = typeof g?.tier === "string" ? g.tier.toUpperCase() : null;
  const graded = Boolean(tierRaw);
  const tier = tierRaw && PUBLIC_TIERS.has(tierRaw) ? tierRaw : null;
  const place = tier ? placeIn(pool, row.url) : null;
  const groups = g ? hiringGroups(factLines(g)) : [];
  return {
    graded,
    tier,
    topPct: place?.topPct ?? null,
    roles: Array.isArray(g?.roles) ? (g.roles as unknown[]).map(String).slice(0, 3) : [],
    checks: groups.map((x) => ({
      key: x.key,
      title: x.title,
      state: x.missing.length ? "fix" : x.ok.length ? "ok" : "unknown",
      toFix: x.missing.map((f) => f.short),
    })),
    votes: Math.max(row.votes, row.wins),
    wins: row.wins,
  };
}

/** The card summary for a face-off pair (one batched read plus the hourly graded pool). */
export async function playCards(urls: string[]): Promise<Map<string, PlayCard>> {
  const [rs, pool] = await Promise.all([rows(urls), gradedPool(db()).catch(() => [])]);
  return new Map(urls.map((u) => [u, cardOf(rs.get(u)!, pool)]));
}

/** Everything the inline Details panel shows for one listed portfolio. */
export async function playDetails(url: string): Promise<PlayDetails> {
  const [rs, pool] = await Promise.all([rows([url]), gradedPool(db()).catch(() => [])]);
  const row = rs.get(url)!;
  const g = row.hidden ? null : row.grade;
  const slug = encodeURIComponent(url);
  return {
    ...cardOf(row, pool),
    groups: g ? hiringGroups(factLines(g)) : [],
    judgments: g ? judgmentLines(g) : [],
    model: typeof g?.model === "string" ? g.model : null,
    shareImage: `/p/${slug}/opengraph-image`,
    profile: `/p/${slug}`,
  };
}
