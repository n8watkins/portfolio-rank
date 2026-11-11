import { cached } from "@/lib/cache";
import { db } from "@/lib/db";
import { readCapped, safeFetch } from "@/lib/safefetch";

// The network side of claims (lib/games/claims.mjs has the rules): the
// portfolio's home page, the GitHub profile (cached a day) and the
// template the capture found.

const PAGE_MAX_BYTES = 1_000_000;

/** The portfolio's home page as fetched now ({ html, finalUrl }), or null. */
export async function fetchPage(url: string): Promise<{ html: string; finalUrl: string } | null> {
  const got = await safeFetch(url, { timeoutMs: 8000 });
  if (!got || !got.res.ok) {
    await got?.res.body?.cancel().catch(() => {});
    return null;
  }
  return { html: await readCapped(got.res, PAGE_MAX_BYTES), finalUrl: got.finalUrl };
}

type Profile = { id: number; login: string; blog: string | null } | { error: string };

/**
 * The GitHub user behind a session (by numeric id, so a renamed login still
 * matches), from the GitHub API, cached a day (an error for 10 minutes).
 * GITHUB_API_TOKEN, when set, raises the API's rate limit.
 */
export async function githubProfile(numericId: string): Promise<{ id: number; login: string; blog: string | null } | null> {
  if (!/^\d{1,12}$/.test(numericId)) return null;
  const p = await cached<Profile>(
    "github-user",
    numericId,
    { ttlMs: 24 * 60 * 60 * 1000, isFailure: (d) => "error" in d, failureTtlMs: 10 * 60 * 1000 },
    async () => {
      try {
        const token = process.env.GITHUB_API_TOKEN;
        const res = await fetch(`https://api.github.com/user/${numericId}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "PortfolioRank", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { error: `http_${res.status}` };
        const u = (await res.json()) as { id?: number; login?: string; blog?: string | null };
        if (typeof u.id !== "number" || typeof u.login !== "string") return { error: "bad_response" };
        return { id: u.id, login: u.login, blog: u.blog || null };
      } catch {
        return { error: "unreachable" };
      }
    }
  );
  return "error" in p ? null : { id: p.id, login: p.login, blog: p.blog };
}

/** The template the capture found the site built from (facts in its grade), or null. */
export async function templateOf(url: string): Promise<string | null> {
  const r = (
    await db().execute({
      sql: "SELECT json_extract(ai_rubric, '$.facts.template') AS t FROM portfolios WHERE url = ? AND json_valid(ai_rubric)",
      args: [url],
    })
  ).rows[0];
  return r?.t == null ? null : String(r.t);
}
