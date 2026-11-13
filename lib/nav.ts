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
  | "add"
  | "me"
  | "removed"
  | "profile"
  | "votes"
  | "settings",
  string | null
> = {
  top: "/top",
  play: "/play",
  faceoff: "/play",
  // "/play?mode=guess" once GAMES_V2 is on in production: until then the
  // quiz is hidden and its APIs answer 404 (lib/games/server.ts).
  guess: null,
  browse: "/browse",
  // The blog's pages always exist; the shell shows its links only once a
  // post is published (components/shell/useBlogLive.ts).
  blog: "/blog",
  polls: "/polls",
  // "/about" when the about page ships.
  about: "/how",
  grading: "/grading",
  // The grade pages, while "grade my portfolio" is on (GRADER_ENABLED, read
  // at build time by next.config.ts so server and browser agree).
  grade: process.env.NEXT_PUBLIC_GRADER_ENABLED === "true" ? "/grade" : null,
  // "Add your portfolio": every check at once, then the profile; while
  // TOOLS_ENABLED is on (inlined the same way). It replaces "Grade yours" and
  // the free tools in the shell (owner, 2026-11-12).
  add: process.env.NEXT_PUBLIC_TOOLS_ENABLED === "true" ? "/add" : null,
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
    case "/add":
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
// With "Add your portfolio" on: Play, Top and Blog, and the add button
// beside them (owner, 2026-11-12); Browse moves to the footer and More.
export const NAV: NavItem[] = only(
  ROUTES.add
    ? [
        { key: "play" as const, href: ROUTES.play, label: "Play" },
        { key: "top" as const, href: ROUTES.top, label: "Top" },
        { key: "blog" as const, href: ROUTES.blog, label: "Blog" },
      ]
    : [
        { key: "top" as const, href: ROUTES.top, label: "Leaderboard" },
        { key: "play" as const, href: ROUTES.play, label: "Play" },
        { key: "browse" as const, href: ROUTES.browse, label: "Browse" },
        { key: "blog" as const, href: ROUTES.blog, label: "Blog" },
      ]
);

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
  if (ROUTES.add) return { href: ROUTES.add, label: "Add your portfolio", done: false };
  if (ROUTES.grade) return { href: ROUTES.grade, label: "Grade yours", done: false };
  return null;
}

export type FooterLink = { href: string; label: string; ext?: boolean };
