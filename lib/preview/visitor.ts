import { cookies } from "next/headers";

// Preview-only visitor states. The real app would know these from the
// session, a browser-local "graded here" record and the grade queue.
export const STATES = ["first", "returning", "listed", "unlisted", "queued"] as const;
export type VisitorState = (typeof STATES)[number];

export const STATE_LABELS: Record<VisitorState, string> = {
  first: "First visit",
  returning: "Graded before, signed out",
  listed: "Signed in, on the leaderboard",
  unlisted: "Signed in, graded, not listed",
  queued: "Report in the queue",
};

export type Visitor = {
  state: VisitorState;
  signedIn: boolean;
  /** Has a grade (finished) to show as "Your portfolio". */
  graded: boolean;
  listed: boolean;
  queued: boolean;
  subscribed: boolean;
  /** Has voted before, so the practice intro stays hidden. */
  voted: boolean;
  /** Visiting from the UK, the EU/EEA or Switzerland: AI grading is off. */
  blocked: boolean;
  /** The country the notice names (preview: always the United Kingdom). */
  country: string | null;
};

export const REGION_COOKIE = "pr-preview-region";
export const BLOCKED_REASON =
  "AI grading is off in the UK, the EU/EEA and Switzerland: PortfolioRank runs on Google Gemini's free tier, which Google doesn't allow for apps used in these regions.";

export const COOKIE = "pr-preview-state";

function isState(v: unknown): v is VisitorState {
  return typeof v === "string" && (STATES as readonly string[]).includes(v);
}

/** ?state= wins (and PreviewBar remembers it in a cookie), else the cookie. */
export async function visitor(params?: { state?: string | string[]; region?: string | string[] }): Promise<Visitor> {
  const q = Array.isArray(params?.state) ? params?.state[0] : params?.state;
  const jar = await cookies();
  const c = jar.get(COOKIE)?.value;
  const rq = Array.isArray(params?.region) ? params?.region[0] : params?.region;
  const region = rq === "blocked" || rq === "open" ? rq : jar.get(REGION_COOKIE)?.value;
  const blocked = region === "blocked";
  const state: VisitorState = isState(q) ? q : isState(c) ? c : "first";
  const signedIn = state === "listed" || state === "unlisted";
  return {
    state,
    signedIn,
    graded: state === "returning" || state === "listed" || state === "unlisted",
    listed: state === "listed",
    queued: state === "queued",
    subscribed: state === "listed",
    voted: state !== "first",
    blocked,
    country: blocked ? "the United Kingdom" : null,
  };
}
