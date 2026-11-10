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
};

export const COOKIE = "pr-preview-state";

function isState(v: unknown): v is VisitorState {
  return typeof v === "string" && (STATES as readonly string[]).includes(v);
}

/** ?state= wins (and PreviewBar remembers it in a cookie), else the cookie. */
export async function visitor(params?: { state?: string | string[] }): Promise<Visitor> {
  const q = Array.isArray(params?.state) ? params?.state[0] : params?.state;
  const c = (await cookies()).get(COOKIE)?.value;
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
  };
}
