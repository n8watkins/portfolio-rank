// Daily caps on the free tools (/tools), so they never cost money: every
// check that does paid-for-if-overused work (a PageSpeed run, a fetch of
// someone's site) reserves one unit of the visitor's, the network's, the
// IPv6 /48's and the site-wide counter first, all or none, in the
// grade_caps table (lib/grader/caps.mjs reserveCaps, same keys with a
// "tools:<tool>:" scope prefix, pruned with the grader's counters). Days are
// midnight to midnight Pacific, which is also when Google's PageSpeed quota
// resets. Past any cap the request is refused, never queued.
//
// PageSpeed: our key has 25,000 runs a day for free and no billing account,
// so going over stops it rather than charging. The nightly pipeline gets
// most of that: a speed check is two runs (mobile and desktop), so the
// site-wide cap of 250 checks is at most 500 runs a day for the tools.
import { quotaDay } from "../../pipeline/quota-day.mjs";

/** @typedef {{ visitor: number, network: number, network48: number, site: number }} ToolCaps */

/** @type {Record<"speed" | "page", ToolCaps>} */
export const TOOL_CAPS = {
  // Speed and Lighthouse check: 2 PageSpeed runs each.
  speed: { visitor: 10, network: 20, network48: 40, site: 250 },
  // Share preview and the portfolio checklist: one capped fetch of the page.
  page: { visitor: 30, network: 60, network48: 120, site: 3000 },
};

/** PageSpeed runs one speed check spends (mobile and desktop). */
export const PSI_RUNS_PER_CHECK = 2;

/**
 * TOOL_CAPS with a TOOLS_CAPS JSON override (a Worker variable), e.g.
 * {"speed":{"site":100}}. Values can only be lowered: a typo can never open
 * the tools past the defaults, which keep PageSpeed inside its free quota.
 * @param {string | undefined} [raw]
 */
export function toolCaps(raw = globalThis.process?.env?.TOOLS_CAPS) {
  /** @type {Record<string, ToolCaps>} */
  const out = { speed: { ...TOOL_CAPS.speed }, page: { ...TOOL_CAPS.page } };
  let over = {};
  try {
    over = raw ? JSON.parse(raw) : {};
  } catch {
    return out;
  }
  for (const tool of Object.keys(out)) {
    for (const scope of /** @type {(keyof ToolCaps)[]} */ (Object.keys(out[tool]))) {
      const v = over?.[tool]?.[scope];
      if (v === null || v === "" || !Number.isFinite(Number(v))) continue;
      out[tool][scope] = Math.min(out[tool][scope], Math.max(0, Math.floor(Number(v))));
    }
  }
  return out;
}

const key = (day, tool, scope, id) => `${day}|tools:${tool}:${scope}|${id}`;

/**
 * Reserves one check of `tool` for the visitor, the network, its /48 and
 * the site, all or none. Returns { ok: true, day } or
 * { ok: false, scope, day, resetAt }.
 *
 * @param {any} db
 * @param {{ tool: "speed" | "page", visitor: string, network?: string, network48?: string, caps?: Record<string, ToolCaps>, now?: Date }} o
 */
export async function reserveTool(db, { tool, visitor, network = "", network48 = "", caps = toolCaps(), now = new Date() }) {
  const c = caps[tool];
  const q = quotaDay(now);
  const day = q.day;
  const wanted = /** @type {[string, string, number][]} */ ([
    ["visitor", visitor, c.visitor],
    ["network", network, c.network],
    ["network48", network48, c.network48],
    ["site", "all", c.site],
  ]).filter(([, id]) => id);
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = await db.transaction("write");
      try {
        for (const [scope, id, cap] of wanted) {
          const r = await tx.execute({
            sql: `INSERT INTO grade_caps (k, day, n) VALUES (?, ?, 1)
                  ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n`,
            args: [key(day, tool, scope, id), day],
          });
          if (Number(r.rows[0]?.n ?? 1) > cap) {
            await tx.rollback();
            return { ok: false, scope, day, resetAt: q.end.toISOString() };
          }
        }
        await tx.commit();
        return { ok: true, day };
      } finally {
        tx.close();
      }
    } catch (e) {
      // Concurrent write transactions can meet a held lock; nothing was counted, so try again.
      if (attempt >= 4 || !/SQLITE_BUSY|database is locked/i.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1) + Math.random() * 25));
    }
  }
}

/** How many checks of `tool` the site has used on `day` (admin and tests). */
export async function toolUsed(db, { tool, day }) {
  const r = await db.execute({ sql: "SELECT n FROM grade_caps WHERE k = ?", args: [key(day, tool, "site", "all")] });
  return Number(r.rows[0]?.n ?? 0);
}
