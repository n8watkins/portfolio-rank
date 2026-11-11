// Where every destination in the shell lives today. The header, footer, phone
// tab bar and More sheet all link through ROUTES, so a page lane ships its
// page by setting its route here; null hides every link to a page that does
// not exist yet, so the live site never links to a 404.

export const ROUTES: Record<
  | "top"
  | "play"
  | "faceoff"
  | "guess"
  | "browse"
  | "blog"
  | "polls"
  | "about"
  | "grading"
  | "grade"
  | "me"
  | "removed"
  | "profile"
  | "votes"
  | "settings",
  string | null
> = {
  top: "/top",
  // "/play" when the Play page ships (Face-off and Guess the percentile).
  play: "/rank",
  faceoff: "/rank",
  guess: null, // "/play?mode=guess"
  browse: "/browse",
  blog: null, // "/blog"
  polls: null, // "/polls"
  // "/about" and "/about#grading" when the about page ships.
  about: "/how",
  grading: "/how",
  // The grade pages, while "grade my portfolio" is on (GRADER_ENABLED, read
  // at build time by next.config.ts so server and browser agree).
  grade: process.env.NEXT_PUBLIC_GRADER_ENABLED === "true" ? "/grade" : null,
  me: "/me",
  removed: "/removed",
  profile: "/profile",
  votes: "/votes",
  settings: "/settings",
};

/** Which top-level destination a path belongs to (for aria-current). */
export type NavKey = "home" | "top" | "play" | "browse" | "blog" | "grade" | "other";

export function navKeyFor(pathname: string): NavKey {
  if (pathname === "/") return "home";
  const first = "/" + (pathname.split("/")[1] ?? "");
  switch (first) {
    case "/top":
      return "top";
    case "/rank":
    case "/play":
      return "play";
    case "/browse":
      return "browse";
    case "/blog":
      return "blog";
    case "/grade":
    case "/me":
      return "grade";
    default:
      return "other";
  }
}

export type NavItem = { key: NavKey; href: string; label: string };

const only = <T extends { href: string | null }>(items: T[]) =>
  items.filter((i): i is T & { href: string } => i.href !== null);

/** The desktop header's destinations (owner, redesign preview). */
export const NAV: NavItem[] = only([
  { key: "top" as const, href: ROUTES.top, label: "Leaderboard" },
  { key: "play" as const, href: ROUTES.play, label: "Play" },
  { key: "browse" as const, href: ROUTES.browse, label: "Browse" },
  { key: "blog" as const, href: ROUTES.blog, label: "Blog" },
]);

/** What the visitor has done, as far as the shell needs to know. */
export type VisitorState = {
  /** A grade is queued or running for this visitor. */
  queued?: boolean;
  /** This visitor has a finished report or a claimed listed portfolio. */
  graded?: boolean;
};

export type PrimaryAction = { href: string; label: string; done: boolean };

/**
 * The one highlighted action: "Grade yours", or "Your portfolio" (or "Your
 * report" while a grade runs) once that is done. Null while the grade pages
 * are not live.
 */
export function primaryAction(v: VisitorState = {}): PrimaryAction | null {
  if (v.queued && ROUTES.me) return { href: ROUTES.me, label: "Your report", done: true };
  if (v.graded && ROUTES.me) return { href: ROUTES.me, label: "Your portfolio", done: true };
  if (ROUTES.grade) return { href: ROUTES.grade, label: "Grade yours", done: false };
  return null;
}

export type FooterLink = { href: string; label: string; ext?: boolean };
