// The free tools, in the order the hub shows them. A tool that isn't built
// yet has live: false: the hub shows it as coming and nothing links to it.

export type ToolId = "speed" | "share" | "checklist";

export type Tool = {
  id: ToolId;
  href: string;
  name: string;
  /** In "Open the ..." links. */
  short: string;
  /** One line for the hub's card. */
  blurb: string;
  live: boolean;
};

export const TOOLS: Tool[] = [
  {
    id: "speed",
    href: "/tools/speed",
    name: "Speed and Lighthouse check",
    short: "speed check",
    blurb: "Lighthouse scores for phones and desktops, Core Web Vitals in plain words, and the fixes that matter most.",
    live: true,
  },
  {
    id: "share",
    href: "/tools/share-preview",
    name: "Share preview checker",
    short: "share preview checker",
    blurb: "See the card a recruiter sees when your link is pasted into LinkedIn, Slack or X, and how to fix it.",
    live: true,
  },
  {
    id: "checklist",
    href: "/tools/portfolio-checklist",
    name: "Portfolio checklist",
    short: "checklist",
    blurb: "Resume, GitHub, contact, working project links, your own domain, HTTPS and more, checked in seconds.",
    live: true,
  },
];

export const liveTools = () => TOOLS.filter((t) => t.live);
