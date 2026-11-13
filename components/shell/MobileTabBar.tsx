"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BookOpen, Ellipsis, Gamepad2, LayoutGrid, Newspaper, Settings, ShieldCheck, Sparkles, Trophy, User, Vote, Wrench, X } from "lucide-react";
import { ROUTES, navKeyFor, type NavKey, type PrimaryAction } from "@/lib/nav";
import { useClientSession } from "@/lib/session-client";
import { useSignIn } from "@/components/SignInModal";
import { SHELL_SIGN_IN } from "@/components/shell/AccountMenu";
import { useBlogLive } from "@/components/shell/useBlogLive";

type Tab = { key: NavKey; href: string | null; label: string; Icon: typeof Trophy };

const TABS: Tab[] = [
  { key: "top", href: ROUTES.top, label: "Top", Icon: Trophy },
  { key: "play", href: ROUTES.play, label: "Play", Icon: Gamepad2 },
  { key: "grade", href: null, label: "Grade", Icon: Sparkles },
  { key: "browse", href: ROUTES.browse, label: "Browse", Icon: LayoutGrid },
];

const tab =
  "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-mute transition aria-[current=page]:text-ink";

/** Phones and tablets: Top, Play, Grade, Browse and More along the bottom. */
export function MobileTabBar({ action }: { action: PrimaryAction | null }) {
  const current = navKeyFor(usePathname() ?? "/");
  const session = useClientSession();
  const openSignIn = useSignIn();
  const [more, setMore] = useState(false);
  const sheet = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = sheet.current;
    if (!d) return;
    if (more && !d.open) d.showModal();
    if (!more && d.open) d.close();
  }, [more]);

  const signedIn = session !== "loading" && session !== null;
  const blogLive = useBlogLive();
  const links: { href: string | null; label: string; Icon: typeof Trophy; signIn?: boolean }[] = [
    { href: blogLive ? ROUTES.blog : null, label: "Blog", Icon: Newspaper },
    { href: ROUTES.tools, label: "Free tools", Icon: Wrench },
    { href: ROUTES.polls, label: "Polls", Icon: Vote },
    { href: ROUTES.about, label: ROUTES.about === "/how" ? "How it works" : "About", Icon: BookOpen },
    signedIn ? { href: ROUTES.profile, label: "Account", Icon: User } : { href: "#signin", label: "Sign in", Icon: User, signIn: true },
    { href: ROUTES.settings, label: "Settings", Icon: Settings },
    // The admin's own account only (display; the admin pages check on the server).
    ...(signedIn && session.isAdmin ? [{ href: "/admin", label: "Admin", Icon: ShieldCheck }] : []),
  ];

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-edge bg-bg/92 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <div className="mx-auto flex max-w-lg">
          {TABS.map(({ key, href, label, Icon }) => {
            if (key === "grade") {
              if (!action) return null;
              return (
                <a key={key} href={action.href} aria-current={current === "grade" ? "page" : undefined} className={tab}>
                  <span className={`grid h-7 w-11 place-items-center rounded-full ${action.done ? "bg-accent-soft text-accent" : "bg-fill text-on-fill"}`}>
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className={action.done ? "text-accent" : "text-ink"}>{action.done ? "Yours" : label}</span>
                </a>
              );
            }
            if (!href) return null;
            return (
              <a key={key} href={href} aria-current={current === key ? "page" : undefined} className={tab}>
                <Icon className="h-5 w-5" aria-hidden />
                {label}
              </a>
            );
          })}
          <button
            type="button"
            onClick={() => setMore(true)}
            aria-haspopup="dialog"
            aria-expanded={more}
            aria-current={current === "blog" ? "page" : undefined}
            className={tab}
          >
            <Ellipsis className="h-5 w-5" aria-hidden />
            More
          </button>
        </div>
      </nav>

      <dialog
        ref={sheet}
        aria-label="More"
        onClose={() => setMore(false)}
        onClick={(e) => e.target === e.currentTarget && setMore(false)}
        className="sheet mb-0 mt-auto w-full max-w-none bg-transparent p-0 text-ink lg:hidden"
      >
        <div className="mx-auto max-w-lg rounded-t-2xl border border-b-0 border-edge bg-card px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">More</p>
            <button
              type="button"
              onClick={() => setMore(false)}
              aria-label="Close"
              className="grid h-11 w-11 place-items-center rounded-lg text-mute hover:bg-raised"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <ul className="grid grid-cols-1 gap-1">
            {links
              .filter((l): l is typeof l & { href: string } => l.href !== null)
              .map(({ href, label, Icon, signIn }) => {
                const row = "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] hover:bg-raised";
                const body = (
                  <>
                    <Icon className="h-5 w-5 text-mute" aria-hidden />
                    {label}
                  </>
                );
                return (
                  <li key={label}>
                    {signIn ? (
                      <button
                        type="button"
                        className={row}
                        onClick={() => {
                          setMore(false);
                          openSignIn(SHELL_SIGN_IN);
                        }}
                      >
                        {body}
                      </button>
                    ) : (
                      <a href={href} className={row}>
                        {body}
                      </a>
                    )}
                  </li>
                );
              })}
          </ul>
        </div>
      </dialog>
    </>
  );
}
