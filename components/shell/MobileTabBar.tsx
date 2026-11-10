"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen, Ellipsis, LayoutGrid, Newspaper, Settings, Sparkles, Swords, Trophy, User, Vote, X } from "lucide-react";
import type { NavKey } from "@/components/shell/nav";
import { useTheme, type Theme } from "@/components/shell/ThemeToggle";
import { MockSignIn } from "@/components/shell/MockSignIn";

const TABS: { key: NavKey; href: string; label: string; Icon: typeof Trophy }[] = [
  { key: "top", href: "/top", label: "Top", Icon: Trophy },
  { key: "rank", href: "/rank", label: "Face-off", Icon: Swords },
  { key: "grade", href: "", label: "Grade", Icon: Sparkles },
  { key: "browse", href: "/browse", label: "Browse", Icon: LayoutGrid },
];

/** Phones and tablets: Top, Face-off, Grade, Browse, More. */
export function MobileTabBar({
  current,
  action,
  signedIn,
}: {
  current: NavKey;
  action: { href: string; label: string; done: boolean };
  signedIn: boolean;
}) {
  const [more, setMore] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const sheet = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    const d = sheet.current;
    if (!d) return;
    if (more && !d.open) d.showModal();
    if (!more && d.open) d.close();
  }, [more]);

  const tab =
    "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-mute transition aria-[current=page]:text-ink";
  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-edge bg-bg/92 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <div className="mx-auto flex max-w-lg">
          {TABS.map(({ key, href, label, Icon }) =>
            key === "grade" ? (
              <a key={key} href={action.href} aria-current={current === "grade" ? "page" : undefined} className={tab}>
                <span className={`grid grid-cols-1 h-7 w-11 place-items-center rounded-full ${action.done ? "bg-accent-soft text-accent" : "bg-fill text-on-fill"}`}>
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className={action.done ? "text-accent" : "text-ink"}>{action.done ? "Yours" : label}</span>
              </a>
            ) : (
              <a key={key} href={href} aria-current={current === key ? "page" : undefined} className={tab}>
                <Icon className="h-5 w-5" aria-hidden />
                {label}
              </a>
            )
          )}
          <button
            type="button"
            onClick={() => setMore(true)}
            aria-haspopup="dialog"
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
            <button type="button" onClick={() => setMore(false)} aria-label="Close" className="grid grid-cols-1 h-11 w-11 place-items-center rounded-lg text-mute hover:bg-raised">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <ul className="grid grid-cols-1 gap-1">
            {[
              { href: "/blog", label: "Blog", Icon: Newspaper },
              { href: "/polls", label: "Polls", Icon: Vote },
              { href: "/how", label: "How grading works", Icon: BookOpen },
              { href: signedIn ? "/profile" : "#signin", label: signedIn ? "Account" : "Sign in", Icon: User },
              { href: "/settings", label: "Settings", Icon: Settings },
            ].map(({ href, label, Icon }) => (
              <li key={label}>
                <a
                  href={href}
                  onClick={(e) => {
                    if (href !== "#signin") return;
                    e.preventDefault();
                    setMore(false);
                    setSignIn(true);
                  }}
                  className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-[15px] hover:bg-raised"
                >
                  <Icon className="h-5 w-5 text-mute" aria-hidden />
                  {label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-edge pt-3">
            <p id="theme-label" className="mb-2 px-1 text-xs font-medium text-mute">
              Theme
            </p>
            <div role="radiogroup" aria-labelledby="theme-label" className="grid grid-cols-3 gap-1 rounded-lg bg-raised p-1">
              {(["system", "light", "dark"] as Theme[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={theme === t}
                  onClick={() => setTheme(t)}
                  className="h-10 rounded-md text-sm font-medium capitalize text-mute aria-checked:bg-card aria-checked:text-ink aria-checked:shadow-sm"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </dialog>
      <MockSignIn open={signIn} onClose={() => setSignIn(false)} />
    </>
  );
}
