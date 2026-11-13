#!/usr/bin/env node
// The sites recheck-543 could not grade (a failed load or a blocked capture),
// sorted by what went wrong, then (step `retry`) loaded once more from this
// machine rather than a GitHub runner, with longer timeouts. Owner request,
// 2026-11-13: earlier checks found most "broken or dead" sites work.
//
//   node scripts/experiments/recheck-543-ungraded.mjs classify
//   node scripts/experiments/recheck-543-ungraded.mjs retry
//
// `classify` writes ungraded.json (one row per site: id, url, group, kind,
// detail). `retry` resolves each failed site's host first (no browser for a
// name that doesn't resolve), then captures the rest one at a time into
// RECHECK_DIR/retry/X/<id> with a 60 s load timeout, 20 s for content and
// the fixes since the first capture (#218, the scroll fix); it never touches
// the first capture's bundles. retry.json lists what happened.
import dns from "dns/promises";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson } from "./grading-two-sets-lib.mjs";
import { DIR, SET } from "./recheck-543.mjs";

const BOT = /just a moment|attention required|checking your browser|verify (you are|you're) human|access denied|cf-ray|cloudflare|captcha|are you a robot|request blocked|forbidden/i;

/** What kind of failure a capture's meta records. */
export function kindOf(meta) {
  if (!meta) return { kind: "not captured", detail: "" };
  const text = `${meta.failed ?? ""} ${meta.blocked ?? ""}`;
  if (meta.failed) {
    const f = meta.failed;
    if (/Invalid URL/.test(f)) return { kind: "malformed address", detail: f };
    if (/ERR_NAME_NOT_RESOLVED/.test(f)) return { kind: "DNS: name does not resolve", detail: f };
    if (/Timeout/i.test(f)) return { kind: "timeout", detail: f };
    if (/ERR_SSL|ERR_CERT|SSL|TLS/i.test(f)) return { kind: "TLS", detail: f };
    if (/ERR_CONNECTION_(REFUSED|CLOSED|RESET)|ERR_EMPTY_RESPONSE|ERR_HTTP2/i.test(f)) return { kind: "connection refused or dropped", detail: f };
    if (/HTTP\s?[45]\d\d/i.test(f)) return { kind: "HTTP error", detail: f };
    if (/page\.evaluate|TypeError|ReferenceError/i.test(f)) return { kind: "script error in our capture", detail: f };
    return { kind: "other load failure", detail: f };
  }
  if (meta.blocked) {
    if (BOT.test(meta.page_text ?? "") || BOT.test(text)) return { kind: "bot or Cloudflare block", detail: meta.blocked };
    if (/gate|loader/.test(meta.blocked)) return { kind: "blocked: gate still on screen", detail: meta.blocked };
    if (/dialog/.test(meta.blocked)) return { kind: "blocked: dialog still on screen", detail: meta.blocked };
    if (/picker/.test(meta.blocked)) return { kind: "blocked: mode picker still on screen", detail: meta.blocked };
    return { kind: "blocked: under 40 words, no outbound links", detail: meta.blocked };
  }
  return null;
}

function classify(dir = DIR) {
  const sel = readJson(path.join(dir, "selection.json"));
  const rows = [];
  for (const s of sel.sites) {
    const p = path.join(dir, "bundles", SET, s.id, "meta.json");
    const meta = fs.existsSync(p) ? readJson(p) : null;
    const k = kindOf(meta);
    if (k) rows.push({ id: s.id, url: s.url, name: s.name, group: s.group, failed: Boolean(meta?.failed), ...k });
  }
  writeJson(path.join(dir, "ungraded.json"), rows);
  const by = {};
  for (const r of rows) by[r.kind] = (by[r.kind] ?? 0) + 1;
  console.log(`${rows.length} ungraded: ${rows.filter((r) => r.failed).length} failed loads, ${rows.filter((r) => !r.failed).length} blocked`);
  for (const [k, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
  return rows;
}

/** Whether a host resolves from here (A or AAAA). */
async function resolves(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, why: "not a valid URL" };
  }
  for (const fn of [dns.resolve4, dns.resolve6]) {
    try {
      if ((await fn.call(dns, host)).length) return { ok: true };
    } catch (e) {
      if (!["ENODATA", "ENOTFOUND", "ESERVFAIL", "ETIMEOUT", "EREFUSED"].includes(e.code)) return { ok: false, why: e.code };
    }
  }
  return { ok: false, why: "no A or AAAA record" };
}

async function retry(dir = DIR) {
  const rows = fs.existsSync(path.join(dir, "ungraded.json")) ? readJson(path.join(dir, "ungraded.json")) : classify(dir);
  // Failed loads only, and blocked captures that look like a bot block; a malformed address can't load anywhere.
  // Failed loads first (a malformed address can't load anywhere), then the sparse or
  // bot-blocked captures, which may be slow apps a GitHub runner never saw render.
  const order = (r) => (r.failed ? 0 : 1);
  const todo = rows
    .filter((r) => (r.failed && r.kind !== "malformed address") || r.kind === "bot or Cloudflare block" || r.kind.startsWith("blocked: under 40 words"))
    .sort((a, b) => order(a) - order(b));
  process.env.RECHECK_GOTO_MS = "60000";
  process.env.RECHECK_CONTENT_MS = "20000";
  const { captureSite } = await import("./recheck-543-capture.mjs");
  const outPath = path.join(dir, "retry.json");
  const out = fs.existsSync(outPath) ? readJson(outPath) : {};
  let browser = null;
  try {
    for (const [i, r] of todo.entries()) {
      if (out[r.id]) continue;
      const dnsr = await resolves(r.url);
      if (!dnsr.ok) {
        out[r.id] = { url: r.url, before: r.kind, result: "dead: the name does not resolve from here either", detail: dnsr.why };
      } else {
        if (!browser) browser = await (await import("playwright")).chromium.launch();
        const d = path.join(dir, "retry", SET, r.id);
        const meta = await captureSite(browser, { id: r.id, url: r.url, name: r.name, group: r.group }, d);
        const k = kindOf(meta);
        out[r.id] = { url: r.url, before: r.kind, result: !k ? "loads now" : `still ${k.kind}`, detail: k?.detail ?? `${meta.words} words, signals ${meta.signals?.score}` };
      }
      writeJson(outPath, out);
      console.log(`[${i + 1}/${todo.length}] ${r.id} ${r.url}: ${out[r.id].result}${out[r.id].detail ? ` (${String(out[r.id].detail).slice(0, 90)})` : ""}`);
    }
  } finally {
    await browser?.close();
  }
  const by = {};
  for (const v of Object.values(out)) by[v.result] = (by[v.result] ?? 0) + 1;
  console.log(JSON.stringify(by));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const step = process.argv[2];
  if (step === "classify") classify();
  else if (step === "retry") await retry();
  else {
    console.error("usage: recheck-543-ungraded.mjs <classify|retry>");
    process.exit(1);
  }
}
