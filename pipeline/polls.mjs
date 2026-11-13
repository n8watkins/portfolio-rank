// Polls for the end-of-day run (owner decision 2026-11-10, docs/DECISIONS.md
// "Polls"; AUTOMATION.md "Polls"). Two parts:
//
//   schedulePolls   free, every night (pipeline/night.mjs planNight): makes
//                   sure this week, and next week when it starts before the
//                   next run, have a poll. When nothing was written ahead it
//                   makes one by code alone, without Gemini: a "which hero
//                   section is better" poll between two top-graded sites, or
//                   an evergreen text poll. Also prunes old vote rows.
//   pollsContent    the Content stage's poll job (pipeline/night.mjs
//                   handlers.content): when fewer than AHEAD_WEEKS future
//                   weeks have a poll, one Gemini request (3.5 Flash-Lite,
//                   the night's client) writes a few candidates from
//                   PortfolioRank's aggregate data; code validates them and
//                   gives each accepted one the next free week.
//
// Limits: one generation a night, at most WEEKLY_REQUESTS Gemini requests
// in any 7 days (retries included), counted in poll_generations. Topics are
// positive and about portfolios and the developer job market; Gemini never
// sees or names a person or a site, and code picks the screenshots (only
// sites graded S or A, so a low scorer is never shown).
import { ensurePollsSchema } from "../lib/polls/schema.mjs";
import { nextWeek, pollWeek } from "../lib/polls/week.mjs";
import { prunePolls } from "../lib/polls/store.mjs";
import { ACTIVE, NOT_PORTFOLIO } from "./roster.mjs";
import { PRIMARY_MODEL } from "./gemini.mjs";

export { ensurePollsSchema };

/** Gemini requests poll generation may use in any 7 days. */
export const WEEKLY_REQUESTS = 2;
/** Generate when fewer than this many future weeks have a poll. */
export const AHEAD_WEEKS = 2;
/** Candidates asked for, and the most accepted from one request. */
export const CANDIDATES = 4;
export const ACCEPT_MAX = 3;
/** A site shown in a hero poll is not shown again for this many weeks. */
export const SITE_COOLDOWN_WEEKS = 12;
/** Polls are scheduled at most this many weeks ahead. */
export const MAX_WEEKS_AHEAD = 8;
/**
 * Only sites the AI graded this well are ever shown in a poll: Gemini's own
 * letter S or A (the report card's grade). Not the tier: that comes from
 * face-offs (lib/tiers.mjs) and starts at B for everyone.
 */
export const SHOWN_GRADES = ["S", "A"];

export const TOPICS = [
  "hero section",
  "projects",
  "about and photo",
  "resume and contact",
  "design and theme",
  "motion and interaction",
  "tech stack",
  "writing and case studies",
  "job search",
  "hiring and recruiters",
];

export const HERO_QUESTION = "Which hero section is better?";
export const HERO_DETAIL = "Look at the first screen only: who it is, what they do, and whether you want to scroll.";

/** Code-written polls for weeks nothing else filled, used in order, each once. */
export const EVERGREEN = [
  { topic: "resume and contact", question: "Should a developer portfolio link a resume?", detail: "A PDF, a page, or nothing at all.", options: ["Yes, always", "Only on request", "No, the work speaks"] },
  { topic: "about and photo", question: "Should your photo be on the first screen?", detail: "A face up front, or the work first.", options: ["Yes, it builds trust", "No, lead with the work", "Doesn't matter"] },
  { topic: "design and theme", question: "Dark or light portfolio?", detail: "What you would pick for your own site.", options: ["Dark", "Light", "Follow the system setting"] },
  { topic: "projects", question: "How many projects should a portfolio show?", detail: "Quality against range.", options: ["1 to 3", "4 to 6", "7 or more"] },
  { topic: "writing and case studies", question: "What makes a project stand out most?", detail: "When you open a project on someone's portfolio.", options: ["A live demo", "A short case study", "Clean source code", "Real users or results"] },
  { topic: "hiring and recruiters", question: "What should a recruiter see first?", detail: "The first five seconds on the page.", options: ["Role and skills", "Best project", "Where they worked", "How to contact"] },
];

const NEGATIVE = /\b(worst|ugly|bad|terrible|awful|boring|lazy|amateur|cringe|fail(s|ed|ing)?|hate|lowest|bottom|loser|embarrass\w*|rank(ed)? last|low[- ]scor\w*)\b/i;
const CONTACT_OR_LINK = /https?:|www\.|@|\.(com|dev|io|me|app|net|org)\b/i;

const iso = (ms) => new Date(ms).toISOString();
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2));

/** True when two questions say nearly the same thing (word overlap). */
export function similarQuestions(a, b) {
  if (norm(a) === norm(b)) return true;
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size) >= 0.8 && both / Math.max(x.size, y.size) >= 0.6;
}

// A small seeded generator, so a night's picks can be replayed.
function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(list, seed) {
  const r = rng(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// What is already scheduled
// ---------------------------------------------------------------------------

/** Every poll (any status), newest first, with its options' sites. */
export async function knownPolls(db) {
  const polls = (await db.execute("SELECT id, kind, question, opens_at, status, source FROM polls ORDER BY opens_at DESC LIMIT 200")).rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    question: String(r.question),
    opensAt: String(r.opens_at),
    status: String(r.status),
    source: String(r.source),
  }));
  const ids = polls.map((p) => p.id);
  const sites = new Map(ids.map((id) => [id, []]));
  if (ids.length) {
    const rows = (await db.execute({ sql: `SELECT poll_id, portfolio_url FROM poll_options WHERE portfolio_url IS NOT NULL AND poll_id IN (${ids.map(() => "?").join(",")})`, args: ids })).rows;
    for (const r of rows) sites.get(String(r.poll_id))?.push(String(r.portfolio_url));
  }
  return polls.map((p) => ({ ...p, sites: sites.get(p.id) ?? [] }));
}

/** Upcoming weeks (after the current one) that have a poll. */
function futureWeeks(known, now) {
  const current = pollWeek(new Date(now));
  return known.filter((p) => p.opensAt >= iso(current.closesAt.getTime())).length;
}

/** The next `n` weeks from the current one with no poll at all (a withdrawn one keeps its week). */
function freeWeeks(known, now, n) {
  const taken = new Set(known.map((p) => p.id));
  const out = [];
  let w = pollWeek(new Date(now));
  for (let i = 0; i <= MAX_WEEKS_AHEAD && out.length < n; i++, w = nextWeek(w)) if (!taken.has(w.id)) out.push(w);
  return out;
}

/** Writes one poll and its options; a week already taken is left alone. Returns true when written. */
export async function insertPoll(db, { week, kind, topic = null, question, detail = "", options, source, generationId = null, now }) {
  const res = await db.batch(
    [
      {
        sql: `INSERT INTO polls (id, kind, question, detail, topic, opens_at, closes_at, status, source, generation_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        args: [week.id, kind, question, detail, topic, iso(week.opensAt.getTime()), iso(week.closesAt.getTime()), source, generationId, iso(now)],
      },
      // Options only for the poll this call wrote, never added to another.
      ...options.map((o, idx) => ({
        sql: `INSERT INTO poll_options (poll_id, idx, label, portfolio_url)
              SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM polls WHERE id = ? AND created_at = ? AND source = ? AND question = ?)
              ON CONFLICT(poll_id, idx) DO NOTHING`,
        args: [week.id, idx, o.label, o.url ?? null, week.id, iso(now), source, question],
      })),
    ],
    "write"
  );
  return res[0].rowsAffected === 1;
}

// ---------------------------------------------------------------------------
// The sites a hero poll may show
// ---------------------------------------------------------------------------

/** Live, listed, captured sites graded S or A, that no recent hero poll showed. */
export async function heroCandidates(db, { known, now }) {
  const cutoff = iso(now - SITE_COOLDOWN_WEEKS * 7 * 86400000);
  const recent = new Set(known.filter((p) => p.opensAt >= cutoff).flatMap((p) => p.sites));
  const rows = (
    await db.execute(
      `SELECT url, shot_key FROM portfolios p
       WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND ${ACTIVE("p")} AND NOT ${NOT_PORTFOLIO("p")}
         AND json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.tier') IN (${SHOWN_GRADES.map((t) => `'${t}'`).join(",")})
       ORDER BY p.url`
    )
  ).rows;
  return rows.map((r) => ({ url: String(r.url), shotKey: String(r.shot_key) })).filter((s) => !recent.has(s.url));
}

/**
 * Two sites for a hero poll whose screenshots exist (ctx.image), never a
 * pair shown before and never one in `exclude`. Returns [a, b] or null.
 */
export async function pickPair(ctx, pool, { seed, exclude = new Set(), maxChecks = 10 }) {
  const ok = [];
  let checks = 0;
  for (const s of shuffle(pool, seed)) {
    if (exclude.has(s.url)) continue;
    if (checks++ >= maxChecks) break;
    const img = await ctx.image(s.shotKey);
    if (!img || img === "missing") continue;
    ok.push(s);
    if (ok.length === 2) return ok;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The free part: a poll every week
// ---------------------------------------------------------------------------

/**
 * Every night, before the AI stages: this week has a poll, and so does next
 * week when it starts before tomorrow's run. Made by code when nothing was
 * scheduled ahead. Then prunes old vote rows. Returns what it did.
 */
export async function schedulePolls(ctx) {
  const { db } = ctx;
  const now = ctx.now();
  await ensurePollsSchema(db);
  const known = await knownPolls(db);
  const taken = new Set(known.map((p) => p.id));
  const due = [pollWeek(new Date(now))];
  const next = nextWeek(due[0]);
  if (next.opensAt.getTime() - now < 26 * 3600000) due.push(next);
  const made = [];
  for (const week of due.filter((w) => !taken.has(w.id))) {
    const poll = await codePoll(ctx, { known, week, now });
    if (poll && (await insertPoll(db, { ...poll, week, source: "code", now }))) {
      made.push(`${week.id} (${poll.kind})`);
      known.unshift({ id: week.id, kind: poll.kind, question: poll.question, opensAt: iso(week.opensAt.getTime()), status: "scheduled", source: "code", sites: poll.options.flatMap((o) => (o.url ? [o.url] : [])) });
    }
  }
  const pruned = await prunePolls(db, { now: new Date(now) });
  return { made, pruned };
}

// A hero poll when two good sites with screenshots are free, else the next
// evergreen question not asked yet; null when both are used up.
async function codePoll(ctx, { known, week, now }) {
  const pool = await heroCandidates(ctx.db, { known, now });
  const lastHero = known.find((p) => p.status === "scheduled")?.kind === "hero";
  const pair = lastHero ? null : await pickPair(ctx, pool, { seed: `code:${week.id}` });
  if (pair) return { kind: "hero", topic: "hero section", question: HERO_QUESTION, detail: HERO_DETAIL, options: [{ label: "Left", url: pair[0].url }, { label: "Right", url: pair[1].url }] };
  const fresh = EVERGREEN.find((e) => !known.some((p) => similarQuestions(p.question, e.question)));
  if (fresh) return { kind: "text", topic: fresh.topic, question: fresh.question, detail: fresh.detail, options: fresh.options.map((label) => ({ label })) };
  const again = lastHero ? await pickPair(ctx, pool, { seed: `code:${week.id}` }) : null;
  return again ? { kind: "hero", topic: "hero section", question: HERO_QUESTION, detail: HERO_DETAIL, options: [{ label: "Left", url: again[0].url }, { label: "Right", url: again[1].url }] } : null;
}

// ---------------------------------------------------------------------------
// The Gemini part: candidates from the data
// ---------------------------------------------------------------------------

/** Aggregate facts about the graded list, as percentages. Never a name or a site. */
export async function dataDigest(db) {
  const r = (
    await db.execute(
      `SELECT COUNT(*) AS graded,
              SUM(json_extract(ai_rubric, '$.tier') IN (${SHOWN_GRADES.map((t) => `'${t}'`).join(",")})) AS top,
              SUM(COALESCE(json_extract(facts, '$.signals.resume'), 0) = 1) AS resume,
              SUM(COALESCE(json_extract(facts, '$.signals.github'), 0) = 1) AS github,
              SUM(COALESCE(json_extract(facts, '$.signals.about'), 0) = 1) AS about,
              SUM(COALESCE(json_extract(facts, '$.contact'), 0) = 1) AS contact,
              SUM(COALESCE(json_extract(facts, '$.own_domain'), 0) = 1) AS own_domain,
              SUM(COALESCE(json_extract(facts, '$.motion'), 0) = 1) AS motion,
              SUM(json_valid(facts)) AS measured
       FROM portfolios p
       WHERE p.status = 'live' AND ${ACTIVE("p")} AND json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.tier') IS NOT NULL`
    )
  ).rows[0];
  const n = (k) => Number(r?.[k] ?? 0);
  const pct = (k, of) => (n(of) ? Math.round((n(k) * 100) / n(of)) : null);
  return {
    graded: n("graded"),
    topTierPercent: pct("top", "graded"),
    ofMeasured: n("measured"),
    resumeLinkPercent: pct("resume", "measured"),
    githubLinkPercent: pct("github", "measured"),
    aboutSectionPercent: pct("about", "measured"),
    contactPercent: pct("contact", "measured"),
    ownDomainPercent: pct("own_domain", "measured"),
    motionPercent: pct("motion", "measured"),
  };
}

export const SYSTEM_INSTRUCTION = [
  "You write short weekly polls for PortfolioRank, a site that ranks developer portfolio websites.",
  "Visitors vote; the results are compared with the AI's grades and written up in posts.",
  "Rules:",
  "- Topics: developer portfolios (what makes one good) and the developer job market. Nothing else.",
  "- Positive and curious in tone. Never mock, shame or criticise anyone; no words like worst, ugly, bad or boring.",
  "- Never name or describe a person, company or website, and never write a link, a handle or an email address.",
  "- Each question is one short sentence ending with a question mark, under 90 characters.",
  "- detail is one short sentence under 120 characters telling voters what to consider.",
  `- kind "text": 2 to 4 options, each under 40 characters, distinct, covering the reasonable answers.`,
  `- kind "hero": the site shows two real portfolio screenshots side by side and asks which is better; write the question about the first screen (the hero section) only, and leave options empty. The site chooses the screenshots.`,
  "- Use the data only as inspiration; do not quote numbers you were not given, and do not repeat any question listed as already asked.",
].join("\n");

export const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    polls: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          kind: { type: "STRING", enum: ["text", "hero"] },
          topic: { type: "STRING", enum: TOPICS },
          question: { type: "STRING" },
          detail: { type: "STRING" },
          options: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["kind", "topic", "question", "detail", "options"],
        propertyOrdering: ["kind", "topic", "question", "detail", "options"],
      },
    },
  },
  required: ["polls"],
};

/** The one request: aggregate data, the questions already asked, how many to write. */
export function buildPollRequest({ digest, asked, count = CANDIDATES, heroAllowed = true }) {
  const text = [
    `Write ${count} candidate polls${heroAllowed ? ", at most one of them of kind \"hero\"" : ", all of kind \"text\""}.`,
    "",
    "PortfolioRank data (aggregate, for inspiration):",
    JSON.stringify(digest),
    "",
    "Already asked (do not repeat or rephrase these):",
    ...(asked.length ? asked.map((q) => `- ${q}`) : ["- (none yet)"]),
  ].join("\n");
  return {
    parts: [{ text }],
    schema: RESPONSE_SCHEMA,
    options: { systemInstruction: SYSTEM_INSTRUCTION, thinkingLevel: "minimal", maxOutputTokens: 2048, temperature: 0.9 },
  };
}

/**
 * Checks Gemini's candidates by code. Returns { accepted, rejected } where
 * each rejected entry says why. `names` are the roster's names and domains,
 * none of which may appear. Hero candidates get their sites later.
 */
export function validateCandidates(raw, { asked = [], names = [] } = {}) {
  let parsed = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { accepted: [], rejected: [{ question: null, reason: "not JSON" }] };
    }
  }
  const list = Array.isArray(parsed?.polls) ? parsed.polls : [];
  const accepted = [];
  const rejected = [];
  const seen = [...asked];
  const lowerNames = names.map((n) => String(n).toLowerCase()).filter((n) => n.length >= 6);
  for (const c of list.slice(0, 12)) {
    const question = String(c?.question ?? "").trim();
    const detail = String(c?.detail ?? "").trim();
    const kind = c?.kind === "hero" ? "hero" : c?.kind === "text" ? "text" : null;
    const topic = TOPICS.includes(c?.topic) ? c.topic : null;
    const options = Array.isArray(c?.options) ? c.options.map((o) => String(o ?? "").trim()) : [];
    const all = [question, detail, ...options].join(" \n ");
    const reason =
      !kind ? "unknown kind"
      : !topic ? "unknown topic"
      : question.length < 10 || question.length > 100 || !question.endsWith("?") ? "question must be 10 to 100 characters and end with ?"
      : detail.length > 160 ? "detail too long"
      : NEGATIVE.test(all) ? "negative wording"
      : CONTACT_OR_LINK.test(all) ? "a link, handle or address"
      : lowerNames.some((n) => all.toLowerCase().includes(n)) ? "names a person or site"
      : kind === "text" && (options.length < 2 || options.length > 4) ? "a text poll needs 2 to 4 options"
      : kind === "text" && options.some((o) => !o || o.length > 40) ? "an option is empty or too long"
      : kind === "text" && new Set(options.map(norm)).size !== options.length ? "duplicate options"
      : seen.some((q) => similarQuestions(q, question)) && kind === "text" ? "duplicate question"
      : null;
    if (reason) {
      rejected.push({ question: question.slice(0, 120) || null, reason });
      continue;
    }
    if (kind === "hero" && accepted.some((a) => a.kind === "hero")) {
      rejected.push({ question, reason: "one hero poll per batch" });
      continue;
    }
    seen.push(question);
    accepted.push({ kind, topic, question, detail, options: kind === "text" ? options.map((label) => ({ label })) : [] });
  }
  return { accepted, rejected };
}

async function weeklyRequests(db, now) {
  const r = (await db.execute({ sql: "SELECT COALESCE(SUM(requests), 0) AS n, MAX(at) AS last FROM poll_generations WHERE at > ?", args: [iso(now - 7 * 86400000)] })).rows[0];
  return { used: Number(r?.n ?? 0), last: r?.last == null ? null : String(r.last) };
}

/** 1 when tonight should write polls, else 0 (with the reason in `why`). */
export async function generationNeeded(ctx) {
  const { db } = ctx;
  const now = ctx.now();
  await ensurePollsSchema(db);
  const known = await knownPolls(db);
  if (futureWeeks(known, now) >= AHEAD_WEEKS) return { n: 0, why: `${AHEAD_WEEKS}+ weeks already scheduled` };
  if (!freeWeeks(known, now, 1).length) return { n: 0, why: "no free week" };
  const { used, last } = await weeklyRequests(db, now);
  if (used >= WEEKLY_REQUESTS) return { n: 0, why: `weekly cap (${used} of ${WEEKLY_REQUESTS} requests in 7 days)` };
  if (last && Date.parse(last) > now - 12 * 3600000) return { n: 0, why: "already tried tonight" };
  return { n: 1, why: "" };
}

/**
 * One generation: one Gemini request, validation, scheduling, and a
 * poll_generations row whatever happens. Throws Gemini errors (after
 * recording them) so the stage counts the failure.
 */
export async function generatePolls(ctx, gemini, { night }) {
  const { db } = ctx;
  const now = ctx.now();
  const known = await knownPolls(db);
  const asked = known.map((p) => p.question);
  const digest = await dataDigest(db);
  const pool = await heroCandidates(db, { known, now });
  const request = buildPollRequest({ digest, asked, heroAllowed: pool.length >= 2 });
  const spent = () => Object.values(gemini.requests).reduce((a, b) => a + b, 0);
  const before = spent();
  const record = async (status, extra) => {
    const res = await db.execute({
      sql: `INSERT INTO poll_generations (night, at, model, requests, proposed, accepted, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [night, iso(now), PRIMARY_MODEL, Math.max(1, spent() - before), extra.proposed ?? 0, extra.accepted ?? 0, status, JSON.stringify(extra.detail ?? {})],
    });
    return Number(res.rows[0].id);
  };
  let answer;
  try {
    const out = await gemini.generate(request.parts, request.schema, request.options);
    if (out.model !== PRIMARY_MODEL) throw new Error(`answered by ${out.model}, not ${PRIMARY_MODEL}`);
    answer = out.result;
  } catch (e) {
    await record("failed", { detail: { error: String(e?.message ?? e).slice(0, 200) } });
    throw e;
  }

  const names = (await db.execute("SELECT name, url FROM portfolios WHERE name IS NOT NULL")).rows.flatMap((r) => {
    const host = (() => {
      try {
        return new URL(String(r.url)).hostname.replace(/^www\./, "");
      } catch {
        return null;
      }
    })();
    return [String(r.name), ...(host ? [host] : [])];
  });
  const { accepted, rejected } = validateCandidates(answer, { asked, names });
  const proposed = accepted.length + rejected.length;

  // Hero candidates get two screenshots that exist, or are dropped.
  const used = new Set();
  const ready = [];
  for (const c of accepted) {
    if (ready.length >= ACCEPT_MAX) break;
    if (c.kind === "hero") {
      const pair = await pickPair(ctx, pool, { seed: `gen:${night}`, exclude: used });
      if (!pair) {
        rejected.push({ question: c.question, reason: "no two screenshots available" });
        continue;
      }
      pair.forEach((s) => used.add(s.url));
      ready.push({ ...c, options: [{ label: "Left", url: pair[0].url }, { label: "Right", url: pair[1].url }] });
    } else ready.push(c);
  }
  const weeks = freeWeeks(known, now, ready.length);
  const id = await record(ready.length ? "ok" : "rejected", { proposed, accepted: Math.min(ready.length, weeks.length), detail: { rejected } });
  const scheduled = [];
  for (let i = 0; i < Math.min(ready.length, weeks.length); i++) {
    if (await insertPoll(db, { ...ready[i], week: weeks[i], source: "gemini", generationId: id, now })) scheduled.push(weeks[i].id);
  }
  ctx.log(`Polls: ${proposed} proposed, ${scheduled.length} scheduled (${scheduled.join(", ") || "none"}), ${rejected.length} rejected${rejected.length ? `: ${rejected.map((r) => r.reason).join("; ")}` : ""}`);
  return { proposed, scheduled, rejected };
}

/**
 * The Content stage's poll job, in the shape pipeline/night.mjs expects of a
 * stage handler. The content engine's posts will join this stage later.
 */
export const pollsContent = {
  parkable: false,
  count: async (ctx) => (await generationNeeded(ctx)).n,
  next: async (ctx, stage) => {
    if (stage.pollsDone) return [];
    const need = await generationNeeded(ctx);
    if (!need.n) return [];
    return [{ id: `polls:${stage.night}` }];
  },
  advance: (stage) => {
    stage.pollsDone = true;
  },
  run: async (ctx, gemini, _item, stage) => {
    await generatePolls(ctx, gemini, { night: stage.night });
    return "ok";
  },
};
