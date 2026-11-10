import { readFileSync } from "fs";
import path from "path";

// Blog for the preview: the one real draft (docs/content/drafts), read in the
// shape of docs/content/POST_TEMPLATE.md, plus two clearly marked sample posts
// so the index and home have something to list.

export type Block =
  | { t: "p"; text: string }
  | { t: "h"; text: string }
  | { t: "quote"; title: string; text: string }
  | { t: "ol"; items: string[] }
  | { t: "image"; n: number; label: string; alt?: string; kind?: string }
  | { t: "cta"; text: string }
  | { t: "shots" };

export type Post = {
  slug: string;
  title: string;
  subtitle: string;
  tags: string[];
  tldr: string[];
  date: string;
  minutes: number;
  status: "draft" | "sample";
  blocks: Block[];
};

function parseDraft(file: string, slug: string, date: string): Post {
  const md = readFileSync(file, "utf8");
  const [body, slots = ""] = md.split(/\n---\n/);
  const meta = (k: string) => body.match(new RegExp(`\\*\\*${k}:\\*\\* (.+)`))?.[1]?.trim() ?? "";
  const tldr = [...body.matchAll(/^> - (.+)$/gm)].map((m) => m[1]);
  // Image slot specs (alt text and kind) live after the --- line.
  const alts = new Map<number, { alt: string; kind: string }>();
  for (const m of slots.matchAll(/#### IMAGE (\d+):[^\n]*\n([\s\S]*?)(?=\n#### |$)/g)) {
    alts.set(Number(m[1]), {
      alt: m[2].match(/\*\*Alt text:\*\* (.+)/)?.[1] ?? "",
      kind: m[2].match(/\*\*Kind:\*\* (.+)/)?.[1] ?? "",
    });
  }
  const start = body.indexOf("[IMAGE 1");
  const lines = body.slice(start).split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith("<!--")) {
      flush();
      continue;
    }
    const img = l.match(/^\[IMAGE (\d+): (.+)\]$/);
    if (img) {
      flush();
      const n = Number(img[1]);
      blocks.push({ t: "image", n, label: img[2], ...alts.get(n) });
    } else if (l.startsWith("### ")) {
      flush();
      blocks.push({ t: "h", text: l.slice(4) });
    } else if (l.startsWith("> **")) {
      flush();
      const title = l.replace(/^> \*\*(.+)\*\*$/, "$1");
      const text = (lines[i + 1] ?? "").replace(/^> /, "").trim();
      i++;
      blocks.push({ t: "quote", title, text });
    } else if (/^\d+\. /.test(l)) {
      flush();
      const items = [l.replace(/^\d+\. /, "")];
      while (/^\d+\. /.test(lines[i + 1]?.trim() ?? "")) items.push(lines[++i].trim().replace(/^\d+\. /, ""));
      blocks.push({ t: "ol", items });
    } else if (l.startsWith("**") && l.includes("->")) {
      flush();
      blocks.push({ t: "cta", text: l.replace(/\*\*/g, "").replace(/ -> <link>/, "") });
    } else {
      // One sentence per line in the source: join into paragraphs.
      para.push(l);
    }
  }
  flush();
  const words = blocks.reduce((n, b) => n + ("text" in b ? b.text.split(/\s+/).length : 0), 0);
  return {
    slug,
    title: meta("Title"),
    subtitle: meta("Subtitle"),
    tags: meta("Tags").split(",").map((t) => t.trim()),
    tldr,
    date,
    minutes: Math.max(1, Math.round(words / 220)),
    status: "draft",
    blocks,
  };
}

const SAMPLES: Post[] = [
  {
    slug: "what-the-top-ten-percent-do",
    title: "What the top 10% of 2,103 portfolios do differently",
    subtitle: "Five habits that show up again and again at the top of the leaderboard.",
    tags: ["reports"],
    tldr: ["A sample post so the index has more than one entry."],
    date: "Nov 3, 2026",
    minutes: 4,
    status: "sample",
    blocks: [
      { t: "p", text: "Sample post: this report doesn't exist yet. It shows how a data report would sit in the blog index and on home, with real screenshots where the template asks for them." },
      { t: "h", text: "The top three, side by side" },
      { t: "shots" },
      { t: "p", text: "The finished report would compare the measured facts and AI grades of the top 10% with everyone else." },
    ],
  },
  {
    slug: "where-ai-and-people-disagree",
    title: "Where AI and people disagree most",
    subtitle: "The portfolios Gemini loves and voters skip, and the other way round.",
    tags: ["model-watch"],
    tldr: ["A sample post so the index has more than one entry."],
    date: "Oct 27, 2026",
    minutes: 5,
    status: "sample",
    blocks: [{ t: "p", text: "Sample post: this comparison needs the People ranking, which doesn't exist yet." }],
  },
];

let cache: Post[] | null = null;

export function posts(): Post[] {
  if (!cache) {
    const draft = parseDraft(
      path.join(process.cwd(), "docs/content/drafts/2026-11-green-checks-zero-work.md"),
      "green-checks-zero-work",
      "Nov 10, 2026"
    );
    cache = [draft, ...SAMPLES];
  }
  return cache;
}

export const postBySlug = (slug: string) => posts().find((p) => p.slug === slug);

export const TAG_LABEL: Record<string, string> = {
  "build-in-public": "Build in public",
  postmortem: "Postmortem",
  "github-actions": "GitHub Actions",
  reports: "Reports",
  "model-watch": "Model watch",
};
