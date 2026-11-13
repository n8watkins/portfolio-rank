"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { signOut } from "next-auth/react";
import { useSignIn } from "@/components/SignInModal";
import { SHELL_SIGN_IN } from "@/components/shell/AccountMenu";
import { ThemeChooser } from "@/components/shell/ThemeChooser";
import { useStoredFlag } from "@/lib/client-state";
import { ROUTES } from "@/lib/nav";
import { useClientSession } from "@/lib/session-client";
import { setTheme } from "@/lib/theme";

// Settings: the account, the theme and voting, then what this site keeps in
// your browser, in plain words. Nothing here tracks you, so there is no
// cookie banner: every cookie is needed for something you asked for, and
// the preferences below can be forgotten in one click.

/** Cookies: needed for what you do on the site, never for tracking. */
const COOKIES = [
  { what: "Sign-in session", why: "Keeps you signed in. Only after you sign in with GitHub or an email link, with two short-lived helpers for the sign-in itself." },
  { what: "Browser id", why: "A random, signed id so a vote, poll answer or quiz counts once. Set the first time you vote, play or grade." },
  { what: "Your reports", why: "Which grade reports this browser asked for, so only you see the owner's tools." },
  { what: "Print pass", why: "A one-hour pass to print a portfolio's report." },
  { what: "Face-off intro seen", why: "So the how-to-play card doesn't show again." },
];

/** Kept in this browser only (local storage), and never sent to us. */
const LOCAL = [
  { key: "pr-theme", what: "Theme", why: "Only when you pick Light or Dark." },
  { key: "pr_autoopen", what: "Auto-open both sites", why: "The switch above." },
  { key: "pr-show-scores", what: "Show scores in the face-off", why: "Your choice on the Play page." },
  { key: "pr_celebrated", what: "Celebrations seen", why: "So a report celebrates once." },
];

/**
 * Delete my account: type the GitHub username (or, for an email account,
 * the address), then everything stored about the account is deleted at once
 * (DELETE /api/account) and you are signed out.
 */
function DeleteAccount({ login }: { login: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const ok = typed.trim().replace(/^@/, "").toLowerCase() === login.toLowerCase();
  const del = async () => {
    setState("busy");
    try {
      const res = await fetch("/api/account", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: typed }) });
      if (!res.ok) throw new Error(String(res.status));
      await signOut({ callbackUrl: "/?account=deleted" });
    } catch {
      setState("error");
    }
  };
  return (
    <div className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p id="delete-label" className="font-semibold">
            Delete my account
          </p>
          <p className="mt-0.5 text-sm text-mute">Deletes your votes, likes, lists, badges, quiz plays and claims, then signs you out. It can&apos;t be undone.</p>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className={`${smallBtn} shrink-0 text-down`}>
            Delete
          </button>
        )}
      </div>
      {open && (
        <form
          className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) void del();
          }}
        >
          <label className="min-w-0 flex-1 text-sm">
            <span className="block text-mute">
              Type <strong className="text-ink">{login}</strong> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="mt-1 h-10 w-full rounded-lg border border-edge bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={!ok || state === "busy"} className="inline-flex h-10 items-center rounded-lg bg-down px-3.5 text-sm font-semibold text-white disabled:opacity-50">
              {state === "busy" ? "Deleting..." : "Delete my account"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className={smallBtn}>
              Cancel
            </button>
          </div>
          {state === "error" && (
            <p role="alert" className="text-sm text-down sm:basis-full">
              That didn&apos;t work. Nothing was deleted; try again.
            </p>
          )}
        </form>
      )}
    </div>
  );
}

const LOCAL_KEYS =[...LOCAL.map((l) => l.key), "pr-faceoff-intro"];

/** A setting: its name and note, the control at the right (under it on phones, unless `inline`, for a small control like a switch). */
function Row({ id, title, desc, inline, children }: { id: string; title: string; desc?: string; inline?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`flex gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-5 ${inline ? "flex-row items-center justify-between" : "flex-col"}`}
    >
      <div className="min-w-0">
        <p id={`${id}-label`} className="font-semibold">
          {title}
        </p>
        {desc && (
          <p id={`${id}-desc`} className="mt-0.5 text-sm text-mute">
            {desc}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const section = "mb-8";
const heading = "mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-mute";
const box = "divide-y divide-edge rounded-xl border border-edge bg-card";
const smallBtn = "inline-flex h-10 items-center gap-2 rounded-lg border border-edge px-3.5 text-sm font-semibold transition hover:border-edge-strong";

export default function SettingsPage() {
  const [autoOpen, setAutoOpen] = useStoredFlag("pr_autoopen");
  const session = useClientSession();
  const openSignIn = useSignIn();
  const [forgot, setForgot] = useState(false);

  const forget = () => {
    try {
      for (const k of LOCAL_KEYS) localStorage.removeItem(k);
      document.cookie = "pr-faceoff-intro=; path=/; max-age=0; samesite=lax";
    } catch {}
    setTheme("system");
    setAutoOpen(false);
    setForgot(true);
  };

  return (
    <div className="mx-auto max-w-2xl px-4 pb-16 sm:px-6">
      <div className="py-6">
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      </div>

      <section aria-labelledby="account" className={section}>
        <h2 id="account" className={heading}>
          Account
        </h2>
        <div className={box}>
          {session === "loading" ? (
            <div className="h-[4.5rem] sm:h-20" aria-hidden />
          ) : session ? (
            <Row
              id="gh"
              title={session.provider === "email" ? "Email" : "GitHub"}
              desc={`Signed in as ${session.provider === "email" ? session.login : `@${session.login}`}. Your votes, likes and lists follow you.`}
            >
              <div className="flex gap-2">
                {ROUTES.profile && (
                  <a href={ROUTES.profile} className={smallBtn}>
                    Profile
                  </a>
                )}
                <button type="button" onClick={() => signOut({ callbackUrl: "/" })} className={`${smallBtn} text-down`}>
                  Sign out
                </button>
              </div>
            </Row>
          ) : (
            <Row id="gh" title="Not signed in" desc="Sign in with GitHub or your email to make your votes count and keep likes, lists and badges on every device.">
              <button type="button" onClick={() => openSignIn(SHELL_SIGN_IN)} className={smallBtn}>
                Sign in
              </button>
            </Row>
          )}
        </div>
      </section>

      <section aria-labelledby="prefs" className={section}>
        <h2 id="prefs" className={heading}>
          Preferences
        </h2>
        <div className={box}>
          <Row id="theme" title="Theme" desc="Animations follow your device's reduce motion setting.">
            <div className="w-full sm:w-64">
              <ThemeChooser labelledBy="theme-label" describedBy="theme-desc" />
            </div>
          </Row>
          <Row id="autoopen" inline title="Auto-open both sites when voting" desc="Opens each pair's two sites in new tabs. You may need to allow pop-ups.">
            <button
              role="switch"
              aria-checked={autoOpen}
              aria-labelledby="autoopen-label"
              aria-describedby="autoopen-desc"
              onClick={() => setAutoOpen(!autoOpen)}
              className={`relative h-6 w-11 shrink-0 rounded-full transition after:absolute after:-inset-y-2.5 after:inset-x-0 ${autoOpen ? "bg-fill" : "bg-mute"}`}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-card shadow-sm transition-all ${autoOpen ? "left-[1.375rem]" : "left-0.5"}`} />
            </button>
          </Row>
        </div>
      </section>

      <section aria-labelledby="privacy" className={section}>
        <h2 id="privacy" className={heading}>
          Cookies and privacy
        </h2>
        <div className={`${box} text-sm`}>
          <div className="p-4 sm:p-5">
            <p className="font-semibold">No tracking, so no cookie banner</p>
            <p className="mt-0.5 text-mute">No ads or analytics cookies. Page views are counted without cookies. Every cookie here is needed for something you do.</p>
          </div>
          <details className="group p-4 sm:p-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold [&::-webkit-details-marker]:hidden">
              What this site stores
              <ChevronDown className="h-4 w-4 text-mute transition group-open:rotate-180" aria-hidden />
            </summary>
            <p className="mt-3 font-medium">Cookies</p>
            <dl className="mt-2 grid gap-2">
              {COOKIES.map((c) => (
                <div key={c.what}>
                  <dt className="inline font-medium">{c.what}: </dt>
                  <dd className="inline text-mute">{c.why}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 font-medium">Saved in this browser only</p>
            <dl className="mt-2 grid gap-2">
              {LOCAL.map((c) => (
                <div key={c.key}>
                  <dt className="inline font-medium">{c.what}: </dt>
                  <dd className="inline text-mute">{c.why}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-mute">A few notes last only while the tab is open: whether the sign-in reminder was shown, and your own Gemini key if you grade with one, until the grade is done.</p>
            <p className="mt-2 text-mute">The bot check on some forms (Cloudflare Turnstile) sets no cookies on this site.</p>
          </details>
          <div className="p-4 sm:p-5" id="newsletter">
            <p className="font-semibold">The blog newsletter</p>
            <p className="mt-0.5 text-mute">
              If you sign up for new posts by email, your address goes to Kit (kit.com), the service that keeps the list and sends the emails; this site keeps no copy. Kit
              sends one confirm email, and nothing else comes until you confirm. The address is used for the newsletter alone, never shared or sold. Every email has an
              Unsubscribe link that works in one click. Kit counts opens and clicks of the emails.
            </p>
          </div>
          <Row id="forget" inline title="Forget my preferences" desc="Clears the choices saved in this browser. Your votes and sign-in stay.">
            <button type="button" onClick={forget} className={smallBtn} aria-describedby="forget-desc">
              {forgot ? "Forgotten" : "Forget"}
            </button>
          </Row>
        </div>
      </section>

      <section aria-labelledby="data" className={section}>
        <h2 id="data" className={heading}>
          Your data
        </h2>
        <div className={box}>
          <Row
            id="remove"
            title="Remove my portfolio"
            desc="First prove the site is yours: a link to your GitHub profile on it, or a short code you add to the page. Then hide its grade or remove it."
          >
            <a href="/claim" className={smallBtn}>
              Start
            </a>
          </Row>
          {session && session !== "loading" ? (
            <>
              <Row id="download" title="Download my data" desc="A JSON file of everything stored about your account: votes, likes, lists, badges, quiz plays and claims.">
                <a href="/api/account" download className={smallBtn}>
                  Download
                </a>
              </Row>
              <DeleteAccount login={session.login} />
            </>
          ) : (
            <Row id="data-signin" title="Your account's data" desc="Sign in to download everything stored about your account, or to delete it.">
              <button type="button" onClick={() => openSignIn(SHELL_SIGN_IN)} className={smallBtn}>
                Sign in
              </button>
            </Row>
          )}
        </div>
      </section>
    </div>
  );
}
