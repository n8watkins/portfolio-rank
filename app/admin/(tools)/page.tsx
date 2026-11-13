import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Gauge, ImageIcon, ListChecks, Mail, Newspaper, ShieldCheck, Vote } from "lucide-react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { requireAdmin } from "@/lib/admin";
import { adminOverview } from "@/lib/admin/overview";

// /admin: the overview. One card per admin page (usage, images, blog drafts,
// polls), each with what the page is for and one or two headline numbers
// from lib/admin/overview.ts; the blog card also links its guidelines and,
// when this deploy has it, the newsletter. Only the admin sees it; anyone
// else gets the same 404 as every other admin page, so the address says
// nothing.
export const dynamic = "force-dynamic";
export const metadata = { title: "Admin - PortfolioRank", robots: { index: false, follow: false } };

const n = (v: number) => v.toLocaleString("en-US");

type SubLink = { href: string; label: string; icon: React.ReactNode; note?: string };
type Stat = { value: string; label: string; /** Something waiting for the owner: drawn in the accent colour. */ attention?: boolean };

function Card({
  href,
  title,
  icon,
  description,
  stats,
  links,
}: {
  href: string;
  title: string;
  icon: React.ReactNode;
  description: string;
  stats: Stat[];
  links?: SubLink[];
}) {
  const id = `admin-card-${href.split("/").pop()}`;
  return (
    // The heading's link covers the card; the sub-links sit above it.
    <section aria-labelledby={id} className="card card-hover group relative flex flex-col p-5 sm:p-6" data-admin-card={href}>
      <div className="flex items-start gap-3">
        <span className="icon-tile h-9 w-9 shrink-0">{icon}</span>
        <h2 id={id} className="min-w-0 flex-1 pt-1 text-lg font-bold leading-tight tracking-tight">
          <Link href={href} className="after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent">
            {title}
          </Link>
        </h2>
        <ArrowRight className="nudge mt-1.5 h-4 w-4 shrink-0 text-mute" aria-hidden />
      </div>
      <p className="mt-2 text-sm text-mute text-pretty">{description}</p>
      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3">
        {stats.map((s) => (
          // The number reads first; the label is the term, so it comes first in the markup.
          <div key={s.label} className="flex min-w-0 flex-col-reverse justify-end">
            <dt className="mt-1.5 text-xs text-mute">{s.label}</dt>
            <dd className={`text-2xl font-bold leading-none tabular-nums ${s.attention ? "text-accent" : ""}`}>{s.value}</dd>
          </div>
        ))}
      </dl>
      {links && links.length > 0 && (
        <ul className="relative z-10 -mx-2 mt-4 grid gap-0.5 border-t border-edge pt-3">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-mute hover:bg-raised hover:text-ink">
                <span className="shrink-0 [&>svg]:h-4 [&>svg]:w-4">{l.icon}</span>
                <span>{l.label}</span>
                {l.note && <span className="ml-auto truncate pl-2 text-xs font-normal tabular-nums">{l.note}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function AdminIndex() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  const o = await adminOverview();
  const dash = "-";
  const blogLinks: SubLink[] = [{ href: "/admin/blog/guidelines", label: "Editor's guidelines", icon: <ListChecks aria-hidden /> }];
  if (o.newsletter) {
    blogLinks.push({
      href: "/admin/blog/newsletter",
      label: "Newsletter",
      icon: <Mail aria-hidden />,
      note: `${n(o.newsletter.confirmed)} ${o.newsletter.confirmed === 1 ? "subscriber" : "subscribers"}`,
    });
  }

  return (
    <>
      <AdminHeader title="Admin">Everything that runs the site, at a glance. Open a card for the page behind it.</AdminHeader>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:items-start" data-admin-overview>
        <Card
          href="/admin/usage"
          title="Usage"
          icon={<Gauge className="h-[18px] w-[18px]" aria-hidden />}
          description="What the site spends of its free allowances: Gemini, queued grades, images and search."
          stats={[
            { value: n(o.gemini.used), label: "Gemini requests today" },
            { value: o.gemini.quota > 0 ? n(o.gemini.quota) : dash, label: "daily allowance" },
          ]}
          links={[{ href: "/admin/limits", label: "Every free limit", icon: <ShieldCheck aria-hidden />, note: "Turso, R2, Workers and more" }]}
        />
        <Card
          href="/admin/images"
          title="Images"
          icon={<ImageIcon className="h-[18px] w-[18px]" aria-hidden />}
          description="The blog's illustration library: review new images and keep the good ones."
          stats={[
            { value: o.images ? n(o.images.pending) : dash, label: "waiting for review", attention: (o.images?.pending ?? 0) > 0 },
            { value: o.images ? n(o.images.approved) : dash, label: "approved" },
          ]}
        />
        <Card
          href="/admin/blog"
          title="Blog drafts"
          icon={<Newspaper className="h-[18px] w-[18px]" aria-hidden />}
          description="The content engine's drafts to review and publish, and the automation you control."
          stats={[
            { value: o.blog ? n(o.blog.drafts) : dash, label: o.blog?.drafts === 1 ? "draft waiting" : "drafts waiting", attention: (o.blog?.drafts ?? 0) > 0 },
            { value: o.blog ? n(o.blog.published) : dash, label: "published" },
          ]}
          links={blogLinks}
        />
        <Card
          href="/admin/polls"
          title="Polls"
          icon={<Vote className="h-[18px] w-[18px]" aria-hidden />}
          description="This week's poll and the scheduled ones, with options visitors can't see yet."
          stats={[
            { value: o.polls ? n(o.polls.open) : dash, label: "open now" },
            { value: o.polls ? n(o.polls.upcoming) : dash, label: "scheduled" },
          ]}
        />
      </div>
    </>
  );
}
