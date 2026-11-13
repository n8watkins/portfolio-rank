"use client";

import { useCallback, useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { BadgeCheck, Code2, FileText, LoaderCircle, ShieldCheck } from "lucide-react";
import { CopyButton } from "@/components/ui/CopyButton";
import { btnPrimary } from "@/components/ui/styles";
import { useClientSession } from "@/lib/session-client";
import { ClaimFlow } from "@/components/claim/ClaimFlow";

type Verify = {
  url: string;
  verified: boolean;
  method: string | null;
  token: string;
  file: { path: string; url: string; content: string };
  meta: { tag: string };
};

const REASONS: Record<string, string> = {
  not_found: "We didn't find it yet. Check it's deployed at exactly that address, then verify again.",
  off_site: "The site redirected to another site, so we couldn't check it.",
  too_many_redirects: "The site redirected too many times.",
  unreachable: "We couldn't reach the site just now.",
  timeout: "The site took longer than 5 seconds to answer.",
};
const ERRORS: Record<string, string> = {
  rate_limited: "That's 5 checks this hour. Try again in a little while.",
  unknown_portfolio: "That address isn't on PortfolioRank.",
  network: "We couldn't reach PortfolioRank. Check your connection and try again.",
};

async function post(body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const res = await fetch("/api/owner/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, body: { error: "network" } };
  }
}

/**
 * Claim a portfolio with code you deploy (POST /api/owner/verify, while "Add
 * your portfolio" is on): a file at the site's root or a meta tag on its home
 * page, each checked once when you press Verify. A GitHub Pages site of your
 * own account is verified at once. Then the usual owner tools (ClaimFlow).
 */
export function VerifyFlow({ url, name, domain, hero }: { url: string; name: string; domain: string; hero: string | null }) {
  const session = useClientSession();
  const [v, setV] = useState<Verify | null>(null);
  const [busy, setBusy] = useState<"" | "start" | "file" | "meta">("");
  const [message, setMessage] = useState("");

  const run = useCallback(
    async (method: "start" | "file" | "meta") => {
      setBusy(method);
      setMessage("");
      const r = await post({ url, method });
      setBusy("");
      if (!r.ok) return setMessage(ERRORS[String(r.body.error)] ?? "That didn't work. Try again in a moment.");
      setV(r.body.claim as Verify);
      if (r.body.reason) setMessage(REASONS[String(r.body.reason)] ?? REASONS.not_found);
    },
    [url]
  );

  // Signed in: open the claim and get the code (or, for your own GitHub Pages site, the verification at once).
  useEffect(() => {
    if (!session || session === "loading") return;
    let live = true;
    post({ url, method: "start" }).then((r) => {
      if (!live) return;
      if (r.ok) setV(r.body.claim as Verify);
      else setMessage(ERRORS[String(r.body.error)] ?? "That didn't work. Try again in a moment.");
    });
    return () => {
      live = false;
    };
  }, [session, url]);

  // Proven: the owner's tools (re-grade, hide the grade, remove).
  if (v?.verified) return <ClaimFlow url={url} name={name} domain={domain} hero={hero} />;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6 sm:py-16">
      <section aria-labelledby="verify-t" className="card p-5 sm:p-6">
        <span className="icon-tile h-10 w-10">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </span>
        <h1 id="verify-t" className="mt-3 text-2xl font-bold tracking-tight">
          Claim {domain}
        </h1>
        <p className="mt-2 text-sm text-mute">
          Prove it&apos;s yours: put a code we give you on your site, then press Verify. Only someone who can deploy to {domain} can do that, so once it&apos;s found you can re-check your site, hide its
          grade or remove it.
        </p>

        {session === "loading" || (session && !v && !message) ? (
          <p className="mt-5 flex items-center gap-2 text-sm text-mute" role="status">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> Getting your code
          </p>
        ) : !session ? (
          <button type="button" onClick={() => signIn("github", { callbackUrl: window.location.href })} className={`${btnPrimary} mt-5`}>
            Sign in with GitHub to start
          </button>
        ) : (
          v && (
            <div className="mt-5 grid gap-4">
              <div className="rounded-xl border border-edge p-4 sm:p-5">
                <p className="flex items-center gap-2 font-semibold">
                  <FileText className="h-4 w-4 text-mute" aria-hidden /> Option 1: a file at your site&apos;s root
                </p>
                <p className="mt-1 text-sm text-mute">
                  Create <code className="font-mono text-ink">{v.file.path}</code> containing only the code below, deploy, and check it opens at{" "}
                  <span className="break-all font-mono text-ink">{v.file.url}</span>.
                </p>
                <pre className="mt-3 overflow-x-auto rounded-lg bg-raised p-3 font-mono text-[12.5px]">{v.file.content}</pre>
                <div className="mt-3 flex flex-wrap gap-2">
                  <CopyButton text={v.file.content} label="Copy code" />
                  <button type="button" disabled={busy !== ""} onClick={() => run("file")} className={btnPrimary}>
                    {busy === "file" ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <BadgeCheck className="h-4 w-4" aria-hidden />} Verify the file
                  </button>
                </div>
              </div>
              <div className="rounded-xl border border-edge p-4 sm:p-5">
                <p className="flex items-center gap-2 font-semibold">
                  <Code2 className="h-4 w-4 text-mute" aria-hidden /> Option 2: a meta tag on your home page
                </p>
                <p className="mt-1 text-sm text-mute">Add this line inside the &lt;head&gt; of {domain}&apos;s home page and deploy.</p>
                <pre className="mt-3 overflow-x-auto rounded-lg bg-raised p-3 font-mono text-[12.5px]">{v.meta.tag}</pre>
                <div className="mt-3 flex flex-wrap gap-2">
                  <CopyButton text={v.meta.tag} label="Copy tag" />
                  <button type="button" disabled={busy !== ""} onClick={() => run("meta")} className={btnPrimary}>
                    {busy === "meta" ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <BadgeCheck className="h-4 w-4" aria-hidden />} Verify the tag
                  </button>
                </div>
              </div>
              <p className="text-xs text-mute">The code is yours and this site&apos;s alone. You can verify 5 times an hour; you can take the file or tag down once you&apos;re verified.</p>
            </div>
          )
        )}
        {message && (
          <p role="alert" className="mt-4 text-sm text-down">
            {message}
          </p>
        )}
      </section>
    </div>
  );
}
