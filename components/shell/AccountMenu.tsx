"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import { Check, History, LogOut, Monitor, Moon, Settings, Sparkles, Sun, User } from "lucide-react";
import { useSignIn, type SignInPrompt } from "@/components/SignInModal";
import { ROUTES, type PrimaryAction } from "@/lib/nav";
import { useClientSession, type ClientSession } from "@/lib/session-client";
import { THEMES, THEME_LABEL, useTheme, type Theme } from "@/lib/theme";

/** What the shell's Sign in (header and phone More sheet) asks. */
export const SHELL_SIGN_IN: SignInPrompt = {
  title: "Sign in to PortfolioRank",
  body: "Your votes count officially, and your likes and lists follow you to every device.",
  skipLabel: "Not now",
};

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

const ITEMS = "[role=menuitem],[role=menuitemradio]";
const item =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none transition hover:bg-raised focus-visible:bg-raised";
const panel = "absolute right-0 top-11 z-30 w-60 rounded-xl border border-edge bg-card p-1.5 shadow-xl shadow-black/20";
const rule = <div role="separator" className="my-1 h-px bg-edge" />;

/**
 * A WAI-ARIA menu button: arrow keys, Home and End move between the items,
 * Escape closes and gives focus back, Tab or a click outside closes.
 */
function useMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
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
  const buttonProps = {
    ref: button,
    type: "button" as const,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    onClick: () => setOpen((o) => !o),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown" && !open) {
        e.preventDefault();
        setOpen(true);
      }
    },
  };
  return { open, wrap, menu, buttonProps };
}

const THEME_ICON: Record<Theme, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

/** System, Light and Dark as menu radios; choosing one keeps the menu open, so the change is seen in place. */
function ThemeItems() {
  const [theme, set] = useTheme();
  return (
    <div role="group" aria-labelledby="menu-theme">
      <p id="menu-theme" className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-mute">
        Theme
      </p>
      {THEMES.map((t) => {
        const Icon = THEME_ICON[t];
        return (
          <button key={t} type="button" role="menuitemradio" aria-checked={theme === t} onClick={() => set(t)} className={item}>
            <Icon className="h-4 w-4 text-mute" aria-hidden />
            <span className="flex-1">{THEME_LABEL[t]}</span>
            {theme === t && <Check className="h-4 w-4 text-accent" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

function SettingsLink() {
  if (!ROUTES.settings) return null;
  return (
    <a role="menuitem" href={ROUTES.settings} className={item}>
      <Settings className="h-4 w-4 text-mute" aria-hidden /> All settings
    </a>
  );
}

/** Signed out: a quiet gear for the theme and settings, beside Sign in. */
function SettingsMenu({ className = "" }: { className?: string }) {
  const { open, wrap, menu, buttonProps } = useMenu();
  return (
    <div ref={wrap} className={`relative shrink-0 ${className}`}>
      <button
        {...buttonProps}
        aria-controls={open ? "settings-menu" : undefined}
        aria-label="Settings"
        title="Settings"
        className="grid h-9 w-9 place-items-center rounded-lg text-mute transition hover:bg-raised hover:text-ink aria-expanded:bg-raised aria-expanded:text-ink"
      >
        <Settings className="h-[18px] w-[18px]" aria-hidden />
      </button>
      {open && (
        <div ref={menu} id="settings-menu" role="menu" aria-label="Settings" className={`${panel} w-56`}>
          <ThemeItems />
          {rule}
          <SettingsLink />
        </div>
      )}
    </div>
  );
}

/**
 * The header's top right. Signed in: the avatar opens the account menu,
 * which also holds the theme. Signed out: a gear menu (the theme and a link
 * to Settings), hidden on the narrowest phones where the More sheet links
 * to Settings, and Sign in, which opens the site's one sign-in dialog.
 */
export function AccountMenu({ action }: { action: PrimaryAction | null }) {
  const session = useClientSession();
  const openSignIn = useSignIn();
  const { open, wrap, menu, buttonProps } = useMenu();

  // Hold the buttons' place while the session loads, so nothing shifts.
  if (session === "loading") return <span aria-hidden className="block h-9 w-[4.5rem] shrink-0 rounded-lg bg-raised" />;

  if (!session) {
    return (
      <>
        <SettingsMenu className="max-[359px]:hidden" />
        <button
          type="button"
          onClick={() => openSignIn(SHELL_SIGN_IN)}
          className="h-9 shrink-0 whitespace-nowrap rounded-lg border border-edge px-3 text-sm font-semibold transition hover:border-mute"
        >
          Sign in
        </button>
      </>
    );
  }

  const display = session.name || session.login;
  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        {...buttonProps}
        aria-controls={open ? "account-menu" : undefined}
        aria-label={`Account: ${display}`}
        className="grid h-9 w-9 place-items-center rounded-full transition hover:opacity-90"
      >
        <Avatar user={session} />
      </button>
      {open && (
        <div ref={menu} id="account-menu" role="menu" aria-label="Account" className={panel}>
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="truncate text-sm font-semibold">{display}</p>
            <p className="truncate text-xs text-mute">{session.email ?? `@${session.login}`}</p>
          </div>
          {rule}
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
          {rule}
          <ThemeItems />
          {rule}
          <SettingsLink />
          <button role="menuitem" type="button" className={`${item} text-down`} onClick={() => signOut({ callbackUrl: "/" })}>
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
