import type { QuickFacts } from "@/lib/grader/quick";

// The portfolio checklist (app/api/tools/checklist): the free code checks of
// "grade my portfolio" (lib/grader/quick.ts, saved under the grader's own
// "grader:quick:<site>" key), plus HTTPS, each with a plain fix.

export type ChecklistItem = {
  id: string;
  label: string;
  /** true passed, false failed, null couldn't tell (the page renders it with JavaScript, or nothing to check). */
  pass: boolean | null;
  /** What was found, in a few words. */
  found: string;
  /** How to fix it; shown when it failed or couldn't be told. */
  tip: string;
};

const TIPS: Record<string, { label: string; tip: string }> = {
  https: { label: "Served over HTTPS", tip: "Turn on HTTPS at your host (free on Vercel, Netlify, GitHub Pages and Cloudflare) and redirect http:// to it. Browsers mark plain http as not secure." },
  resume: { label: "Resume link", tip: "Link a resume or CV (a PDF or a page) from the home page, labeled \"Resume\". It's the first thing many recruiters look for." },
  github: { label: "GitHub link", tip: "Link your GitHub profile from the home page, so people can see your code." },
  contact: { label: "A way to contact you", tip: "Add a mailto: link, a contact form or a LinkedIn link. If nobody can reach you, the portfolio can't get you hired." },
  project_links: { label: "Project links load", tip: "Fix or remove project and demo links that answer with an error. A dead demo reads as an abandoned project." },
  own_domain: { label: "Your own domain", tip: "A domain like yourname.dev costs about $10 to $15 a year and looks more serious than a vercel.app or github.io address. Point it at the same host." },
  fresh_footer: { label: "Footer year is current", tip: "Update the © year in your footer, or print it from the current date. An old year makes the site look unmaintained." },
  original: { label: "Not an unedited template", tip: "Your page matches a well-known template. Make the layout, colors and copy your own so it doesn't look like hundreds of others." },
};

/** The checklist rows for a free-checks result. Pure: the tests call it with plain objects. */
export function checklistItems(q: QuickFacts, now = new Date()): ChecklistItem[] {
  const facts = (q.facts ?? {}) as Record<string, unknown>;
  const checks = q.checks ?? {};
  const links = facts.project_links as { checked?: number; ok?: number; broken?: number; blocked?: number } | undefined;
  const year = typeof facts.footer_year === "number" ? facts.footer_year : null;
  const host = (() => {
    try {
      return new URL(q.finalUrl ?? "").hostname;
    } catch {
      return "";
    }
  })();
  const https = q.finalUrl ? q.finalUrl.startsWith("https://") : null;
  const row = (id: string, pass: boolean | null, found: string): ChecklistItem => ({ id, label: TIPS[id].label, pass, found, tip: TIPS[id].tip });
  const said = (v: boolean | null | undefined, yes: string, no: string, unknown = "Couldn't tell from the page's HTML") => (v == null ? unknown : v ? yes : no);
  return [
    row("https", https, said(https, "Yes", "No, it ends on http://")),
    row("resume", checks.resume ?? null, said(checks.resume, "Found a resume link", "No resume or CV link found")),
    row("github", checks.github ?? null, said(checks.github, "Found a GitHub link", "No GitHub link found")),
    row("contact", checks.contact ?? null, said(checks.contact, "Found a way to reach you", "No email, form or LinkedIn link found")),
    row(
      "project_links",
      checks.project_links ?? null,
      links?.checked ? `${links.checked} checked, ${links.broken ?? 0} broken${links.blocked ? `, ${links.blocked} wouldn't let us check` : ""}` : "No project links to check"
    ),
    row("own_domain", checks.own_domain ?? null, said(checks.own_domain, host || "Yes", host ? `${host} is a free hosting address` : "No")),
    row("fresh_footer", checks.fresh_footer ?? null, year ? `© ${year}${year < now.getUTCFullYear() ? "" : " (current)"}` : "No year in the footer"),
    row("original", checks.original ?? null, said(checks.original, "Doesn't match a known template", "Matches a known template")),
  ];
}
