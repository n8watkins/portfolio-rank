// Polls for the preview: one active poll and the past series. Questions and
// counts are sample data; the screenshots are real roster sites.

import { leaderboard, type Site } from "@/lib/preview/data";

export type PollOption = { label: string; votes: number; site?: Pick<Site, "name" | "domain" | "shot" | "slug"> };
export type Poll = {
  id: string;
  question: string;
  detail: string;
  /** Which part of the page to look at, for screenshot polls. */
  kind: "hero" | "text";
  options: PollOption[];
  closed?: string;
  opened: string;
};

function pick(rank: number) {
  const r = leaderboard("merged")[rank];
  return { name: r.name, domain: r.domain, shot: r.shot, slug: r.slug };
}

export function polls(): { active: Poll; past: Poll[] } {
  const active: Poll = {
    id: "hero-2026-11-10",
    question: "Which hero section is better?",
    detail: "Look at the first screen only: who it is, what they do, and whether you want to scroll.",
    kind: "hero",
    opened: "Nov 10, 2026",
    options: [
      { label: "Left", votes: 412, site: pick(2) },
      { label: "Right", votes: 297, site: pick(7) },
    ],
  };
  const past: Poll[] = [
    {
      id: "hero-2026-11-03",
      question: "Which hero section is better?",
      detail: "Week 45.",
      kind: "hero",
      opened: "Nov 3",
      closed: "Nov 9, 2026",
      options: [
        { label: "Left", votes: 538, site: pick(0) },
        { label: "Right", votes: 611, site: pick(5) },
      ],
    },
    {
      id: "photo-2026-10-27",
      question: "Should your photo be on the first screen?",
      detail: "Week 44.",
      kind: "text",
      opened: "Oct 27",
      closed: "Nov 2, 2026",
      options: [
        { label: "Yes, it builds trust", votes: 702 },
        { label: "No, lead with the work", votes: 455 },
        { label: "Doesn't matter", votes: 131 },
      ],
    },
    {
      id: "hero-2026-10-20",
      question: "Which hero section is better?",
      detail: "Week 43.",
      kind: "hero",
      opened: "Oct 20",
      closed: "Oct 26, 2026",
      options: [
        { label: "Left", votes: 344, site: pick(11) },
        { label: "Right", votes: 349, site: pick(3) },
      ],
    },
    {
      id: "theme-2026-10-13",
      question: "Dark or light portfolio?",
      detail: "Week 42.",
      kind: "text",
      opened: "Oct 13",
      closed: "Oct 19, 2026",
      options: [
        { label: "Dark", votes: 811 },
        { label: "Light", votes: 520 },
      ],
    },
    {
      id: "hero-2026-10-06",
      question: "Which hero section is better?",
      detail: "Week 41.",
      kind: "hero",
      opened: "Oct 6",
      closed: "Oct 12, 2026",
      options: [
        { label: "Left", votes: 290, site: pick(9) },
        { label: "Right", votes: 466, site: pick(1) },
      ],
    },
  ];
  return { active, past };
}

export const totalVotes = (p: Poll) => p.options.reduce((n, o) => n + o.votes, 0);
export const pct = (p: Poll, o: PollOption) => Math.round((o.votes / totalVotes(p)) * 100);
