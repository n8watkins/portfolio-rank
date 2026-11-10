"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut, Settings, Sparkles, User } from "lucide-react";
import { MockSignIn } from "@/components/shell/MockSignIn";

/** Signed in: an avatar that opens a menu. Signed out: Sign in. */
export function AccountMenu({
  signedIn,
  name,
  yourHref,
  yourLabel,
}: {
  signedIn: boolean;
  name: string;
  yourHref: string;
  yourLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [signIn, setSignIn] = useState(false);
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

  if (!signedIn) {
    return (
      <>
        <button
          type="button"
          onClick={() => setSignIn(true)}
          className="h-9 rounded-lg border border-edge px-3 text-sm font-semibold transition hover:border-mute"
        >
          Sign in
        </button>
        <MockSignIn open={signIn} onClose={() => setSignIn(false)} />
      </>
    );
  }

  const item =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none transition hover:bg-raised focus-visible:bg-raised";
  return (
    <div ref={wrap} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        onClick={() => setOpen((o) => !o)}
        className="grid grid-cols-1 h-9 w-9 place-items-center rounded-full bg-fill text-sm font-bold text-on-fill ring-offset-2 ring-offset-bg transition hover:opacity-90"
      >
        {name.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-11 z-30 w-60 rounded-xl border border-edge bg-card p-1.5 shadow-xl shadow-black/20"
        >
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="truncate text-xs text-mute">you@example.com</p>
          </div>
          <div className="my-1 h-px bg-edge" />
          <a role="menuitem" href={yourHref} className={item}>
            <Sparkles className="h-4 w-4 text-mute" aria-hidden /> {yourLabel}
          </a>
          <a role="menuitem" href="/profile" className={item}>
            <User className="h-4 w-4 text-mute" aria-hidden /> Votes and lists
          </a>
          <a role="menuitem" href="/settings" className={item}>
            <Settings className="h-4 w-4 text-mute" aria-hidden /> Settings
          </a>
          <div className="my-1 h-px bg-edge" />
          <button role="menuitem" type="button" className={`${item} text-down`} onClick={() => setOpen(false)}>
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
