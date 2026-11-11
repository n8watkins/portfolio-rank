"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import { History, LogOut, Settings, Sparkles, User } from "lucide-react";
import { useSignIn } from "@/components/SignInModal";
import { ROUTES, type PrimaryAction } from "@/lib/nav";
import { useClientSession, type ClientSession } from "@/lib/session-client";

/** The account's picture, or its first letter on amber. */
export function Avatar({ user, className = "h-9 w-9 text-sm" }: { user: ClientSession; className?: string }) {
  if (user.image)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={user.image} alt="" width={36} height={36} className={`rounded-full bg-raised object-cover ${className}`} />
    );
  return (
    <span aria-hidden className={`grid place-items-center rounded-full bg-fill font-bold text-on-fill ${className}`}>
      {(user.name || user.login).slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * Signed in: an avatar that opens a menu (WAI-ARIA menu button: arrow keys,
 * Home and End, Escape returns focus, a click outside closes). Signed out:
 * Sign in, which opens the site's one sign-in dialog.
 */
export function AccountMenu({ action }: { action: PrimaryAction | null }) {
  const session = useClientSession();
  const openSignIn = useSignIn();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    items()[0]?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      } else if (e.key === "Tab") {
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        list[(i + 1) % list.length]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        list[(i - 1 + list.length) % list.length]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        list[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        list[list.length - 1]?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Hold the button's place while the session loads, so nothing shifts.
  if (session === "loading") return <span aria-hidden className="block h-9 w-[4.5rem] shrink-0 rounded-lg bg-raised" />;

  if (!session) {
    return (
      <button
        type="button"
        onClick={() => openSignIn({ title: "Sign in to PortfolioRank", skipLabel: "Not now" })}
        className="h-9 shrink-0 whitespace-nowrap rounded-lg border border-edge px-3 text-sm font-semibold transition hover:border-mute"
      >
        Sign in
      </button>
    );
  }

  const item =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none transition hover:bg-raised focus-visible:bg-raised";
  const display = session.name || session.login;
  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "account-menu" : undefined}
        aria-label={`Account: ${display}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="grid h-9 w-9 place-items-center rounded-full transition hover:opacity-90"
      >
        <Avatar user={session} />
      </button>
      {open && (
        <div
          ref={menu}
          id="account-menu"
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-11 z-30 w-60 rounded-xl border border-edge bg-card p-1.5 shadow-xl shadow-black/20"
        >
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="truncate text-sm font-semibold">{display}</p>
            <p className="truncate text-xs text-mute">{session.email ?? `@${session.login}`}</p>
          </div>
          <div className="my-1 h-px bg-edge" />
          {action && (
            <a role="menuitem" href={action.href} className={item}>
              <Sparkles className="h-4 w-4 text-mute" aria-hidden /> {action.done ? action.label : "Grade your portfolio"}
            </a>
          )}
          {ROUTES.profile && (
            <a role="menuitem" href={ROUTES.profile} className={item}>
              <User className="h-4 w-4 text-mute" aria-hidden /> Profile, likes and lists
            </a>
          )}
          {ROUTES.votes && (
            <a role="menuitem" href={ROUTES.votes} className={item}>
              <History className="h-4 w-4 text-mute" aria-hidden /> My votes
            </a>
          )}
          {ROUTES.settings && (
            <a role="menuitem" href={ROUTES.settings} className={item}>
              <Settings className="h-4 w-4 text-mute" aria-hidden /> Settings
            </a>
          )}
          <div className="my-1 h-px bg-edge" />
          <button role="menuitem" type="button" className={`${item} text-down`} onClick={() => signOut({ callbackUrl: "/" })}>
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
