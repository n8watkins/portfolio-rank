#!/usr/bin/env node
// The facts audit's scoring: for every site of a probe run (probe.mjs), the
// truth per fact and signal, the code's answer before (pipeline/facts.mjs
// and signals.mjs as they were on main at BASELINE_COMMIT, read from git into
// a temporary folder) and after (the pipeline's current code), and for every
// miss its cause. Emails in the printed evidence are replaced by <email>.
//
// The truth: the broad probe's answer (dom-probe.mjs, read after the page
// stopped changing and a slow scroll), replaced by the answer decided by eye
// in truth.json wherever the screenshots were read (every site where the
// broad probe and the code disagree). Neither version of the code under test
// takes part in it.
//
//   node scripts/experiments/facts-audit/analyze.mjs <before-dir> [<after-dir>] [--render <render-dir>] [--list] [--json out.json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as now from "../../../pipeline/facts.mjs";

// main before this work (2026-11-21): the facts and signals code the audit measured as "before".
const BASELINE_COMMIT = "5900b53df688073b717b5cfa792dc176f41db525";
const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "facts-audit-baseline-"));
for (const f of ["facts.mjs", "signals.mjs"]) {
  const src = execFileSync("git", ["show", `${BASELINE_COMMIT}:pipeline/${f}`], { cwd: import.meta.dirname, encoding: "utf8" });
  fs.writeFileSync(path.join(baselineDir, f), src);
}
const v1 = await import(pathToFileURL(path.join(baselineDir, "facts.mjs")).href);
fs.rmSync(baselineDir, { recursive: true, force: true });
const redact = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [beforeDir, afterDir] = args.filter((a, i) => !a.startsWith("--") && !["--json", "--render"].includes(args[i - 1]));
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const sample = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "sample.json"), "utf8"));
const overrides = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "truth.json"), "utf8"));

const FACTS = ["resume", "github", "contact", "project_links", "footer_year", "own_domain", "sections"];
const SIGNALS = ["projects", "about", "contact", "resume", "github", "name"];

const readMaybe = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
const fold = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const GH_RESERVED = /^(sponsors|topics|features|about|pricing|marketplace|orgs|settings|explore|login|join|new|search|apps|collections|site|enterprise|team|security|contact|trending|events)$/i;
const SOCIAL = /(^|\.)(linkedin|twitter|x|instagram|facebook|youtube|tiktok|threads|bsky|dribbble|behance|medium|dev|discord|t|wa|calendly|cal|google|w3|schema|vercel|netlify|leetcode|hackerrank|stackoverflow|codepen|kaggle|credly|fonts\.googleapis)\.(com|to|me|gg|org|io|app|net)$/i;

function ghUser(u) {
  const m = String(u).match(/github\.com\/([A-Za-z0-9-]+)(\/[A-Za-z0-9._-]+)?/i);
  if (!m || GH_RESERVED.test(m[1])) return null;
  return { user: m[1], repo: Boolean(m[2]) };
}
const urlOf = (s) => String(s).replace(/^[\w-]+=/, "");

/** The broad probe's answer per fact and signal, with the evidence behind each. */
function broadTruth(probe, site, finalUrl) {
  const clicks = probe.clickables ?? [];
  const ev = {};
  const pick = (k, list) => (ev[k] = list.slice(0, 6));
  const self = (() => {
    try {
      return new URL(finalUrl || site.url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  pick(
    "resume",
    [
      ...clicks.filter((c) => /\b(resume|résumé|cv|curriculum vitae)\b/i.test(c.label) || c.urls.some((u) => /resume|[-_/]cv\.pdf|\/cv\b/i.test(urlOf(u)))),
      ...probe.embeds.filter((e) => /resume|\bcv\b/i.test(e)).map((e) => ({ tag: "embed", label: e, urls: [e], visible: true })),
    ]
  );
  pick("github", clicks.filter((c) => c.urls.some((u) => ghUser(urlOf(u))) || /\bgithub\b/i.test(c.label)));
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(probe.text ?? "");
  pick("contact", [
    ...clicks.filter(
      (c) =>
        c.urls.some((u) => /^(mailto|tel):|linkedin\.com\/in\/|(twitter|x)\.com\/\w|wa\.me|t\.me|calendly\.com/i.test(urlOf(u))) ||
        /\b(contact|get in touch|hire me|say hello|say hi|let'?s talk|let'?s connect|email me|reach out|work with me)\b/i.test(c.label)
    ),
    ...(probe.forms > 0 ? [{ tag: "form", label: `${probe.forms} form(s)`, urls: [], visible: true }] : []),
    ...(email ? [{ tag: "text", label: email[0], urls: [], visible: true }] : []),
  ]);
  pick(
    "project_links",
    clicks.filter((c) =>
      c.urls.some((u) => {
        const raw = urlOf(u);
        const g = ghUser(raw);
        if (g) return g.repo;
        try {
          const x = new URL(raw);
          const h = x.hostname.replace(/^www\./, "");
          return /^https?:$/.test(x.protocol) && h !== self && !SOCIAL.test(h) && !/\.(pdf|png|jpe?g|svg|webp)$/i.test(x.pathname);
        } catch {
          return false;
        }
      })
    )
  );
  // Projects / about: a heading, a control or a section id with the word.
  const PROJECTS = /\b(projects?|portfolio|my work|selected work|featured work|work|case stud(y|ies)|things i('ve)? built|showcase)\b/i;
  const ABOUT = /\babout\b|who i am|my story/i;
  const named = (re) => [
    ...probe.headings.filter((h) => re.test(h.text)).map((h) => ({ tag: h.tag, label: h.text, urls: [], visible: h.visible })),
    ...clicks.filter((c) => c.label.length <= 40 && re.test(c.label)),
    ...probe.ids.filter((id) => re.test(id.replace(/[-_]/g, " "))).map((id) => ({ tag: "id", label: id, urls: [], visible: true })),
  ];
  pick("projects", named(PROJECTS));
  pick("about", named(ABOUT));
  const tokens = fold(site.name).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const nameIn = fold(`${probe.title} ${probe.headings.map((h) => h.text).join(" ")} ${String(probe.text ?? "").slice(0, 300)}`);
  ev.name = tokens.filter((t) => nameIn.includes(t)).map((t) => ({ tag: "text", label: t, urls: [], visible: true }));
  // Footer year: a year within 40 characters after the copyright mark.
  const years = [...String(probe.text ?? "").matchAll(/(?:©|\(c\)|copyright)([^\n]{0,40})/gi)]
    .flatMap((m) => [...m[1].matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((y) => Number(y[1])))
    .filter((y) => y <= new Date().getUTCFullYear() + 1);
  const footer = years.length ? Math.max(...years) : null;
  // In-page section navigation: links to "#section" on this page, or nav-word
  // controls that are not links to another page (buttons that scroll).
  const NAV = /^(home|about( me)?|projects?|work|portfolio|skills|experience|contact( me)?|blog|services|education|testimonials)$/i;
  const navEv = new Map();
  for (const c of clicks) {
    const hash = c.urls.map(urlOf).find((u) => /#[\w-]+$/.test(u) && u.includes(self));
    const word = c.label.split(" | ")[0];
    if (hash) navEv.set(hash.split("#")[1].toLowerCase(), c);
    else if (NAV.test(word) && (c.tag !== "a" || !c.urls.length)) navEv.set(word.toLowerCase(), c);
  }
  ev.sections = [...navEv.entries()].map(([n, c]) => ({ tag: c.tag, label: n, urls: c.urls, visible: c.visible }));
  const navs = navEv;
  const truth = {
    resume: ev.resume.length > 0,
    github: ev.github.length > 0,
    contact: ev.contact.length > 0,
    project_links: ev.project_links.length > 0,
    footer_year: footer,
    own_domain: Boolean(self) && !now.FREE_HOSTS.test(`.${self}`),
    sections: navs.size > 0,
    projects: ev.projects.length > 0,
    about: ev.about.length > 0,
    name: ev.name.length > 0,
  };
  return { truth, ev };
}

/** One version of the code on one saved reading: the facts and signals as booleans. */
function codeAnswer(lib, html, text, site, finalUrl) {
  const f = lib.measureFacts({ html, text, url: site.url, finalUrl, name: site.name });
  // The links measurePage checks: pageLinks where the version has it (links plus control URLs), else the links.
  const cands = lib.projectLinkCandidates((lib.pageLinks ?? lib.extractLinks)(html, f.final_url), f.final_url);
  return {
    facts: {
      resume: f.resume,
      github: f.github,
      contact: f.contact,
      project_links: cands.length > 0,
      footer_year: f.footer_year,
      own_domain: f.own_domain,
      sections: f.sections > 0,
    },
    signals: Object.fromEntries(SIGNALS.map((k) => [k, f.signals[k]])),
    score: f.signals.score,
    raw: f,
  };
}

const textFromHtml = (html) => {
  // The saved readings keep the html; the text is saved for A only. For R, A2 and B the
  // visible text is approximated from the html (only footer_year and words read it).
  return String(html ?? "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ");
};

const sites = [];
for (const site of sample) {
  const key = (await import("node:crypto")).createHash("sha1").update(site.url).digest("hex").slice(0, 12);
  const dir = path.join(beforeDir, key);
  const meta = JSON.parse(readMaybe(path.join(dir, "meta-before.json")) ?? "null");
  const probe = JSON.parse(readMaybe(path.join(dir, "probe.json")) ?? "null");
  if (!meta || meta.error || !probe || probe.error || !meta.A) {
    sites.push({ url: site.url, skipped: meta?.error ?? probe?.error ?? "no reading" });
    continue;
  }
  const A = readMaybe(path.join(dir, "A-before.html"));
  const Atext = readMaybe(path.join(dir, "A-before.txt"));
  const A2 = readMaybe(path.join(dir, "A2.html"));
  const B = readMaybe(path.join(dir, "B.html"));
  const R = readMaybe(path.join(dir, "R.html"));
  const fin = meta.finalUrl;
  const { truth: broad, ev } = broadTruth(probe, site, fin);
  const truth = { ...broad };
  const decided = {};
  for (const [k, v] of Object.entries(overrides[site.url] ?? {})) {
    if (k.startsWith("_")) continue;
    truth[k] = v.truth;
    decided[k] = v.why;
  }
  const old = { A: codeAnswer(v1, A, Atext, site, fin), A2: codeAnswer(v1, A2, textFromHtml(A2), site, fin), B: codeAnswer(v1, B, probe.text, site, fin), R: codeAnswer(v1, R, textFromHtml(R), site, fin) };
  const fixedOnA = codeAnswer(now, A, Atext, site, fin);
  let after = null;
  if (afterDir) {
    const dirAfter = path.join(afterDir, key);
    const Aa = readMaybe(path.join(dirAfter, "A-after.html"));
    const Ta = readMaybe(path.join(dirAfter, "A-after.txt"));
    const ma = JSON.parse(readMaybe(path.join(dirAfter, "meta-after.json")) ?? "null");
    if (Aa && ma && !ma.error) after = { ...codeAnswer(now, Aa, Ta, site, ma.finalUrl), meta: ma };
  }
  sites.push({ url: site.url, from: site.from, meta, truth, broad, ev, decided, old, fixedOnA, after });
}

/** Why the old code missed a true fact on the capture's reading. */
function cause(s, group, k) {
  const pickOld = (r) => (group === "facts" ? s.old[r].facts[k] : s.old[r].signals[k]);
  if (s.decided[k] && /behind a click/i.test(s.decided[k])) return "behind a click";
  if (pickOld("A2")) return "rendered after the capture's wait";
  if (pickOld("B")) return "only after scrolling";
  const e = s.ev[k] ?? [];
  if (s.meta.A.fullHtmlChars > 400000 && e.some((x) => x.tag === "a")) return "other: page HTML cut at 400,000 characters";
  if (e.length && e.every((x) => x.tag !== "a" || !x.urls.length)) return "not a link (button or script)";
  if (e.some((x) => x.tag === "a")) return "wording the pattern misses";
  if (e.length && e.every((x) => !x.visible)) return "behind a click";
  return `other${s.decided[k] ? `: ${s.decided[k]}` : ""}`;
}

const scored = sites.filter((s) => !s.skipped);
const keysOf = (group) => (group === "facts" ? FACTS.filter((k) => k !== "footer_year") : SIGNALS);
const table = [];
const misses = [];
for (const group of ["facts", "signals"]) {
  for (const k of keysOf(group)) {
    const row = { group, fact: k, n: 0, before: { right: 0, fn: 0, fp: 0 }, fixedOnA: { right: 0, fn: 0, fp: 0 }, after: { right: 0, fn: 0, fp: 0, n: 0 }, causes: {} };
    for (const s of scored) {
      const t = s.truth[k];
      const get = (ans) => (group === "facts" ? ans.facts[k] : ans.signals[k]);
      row.n++;
      const tally = (bucket, v) => {
        if (v === t) bucket.right++;
        else if (t) bucket.fn++;
        else bucket.fp++;
      };
      const b = get(s.old.A);
      tally(row.before, b);
      tally(row.fixedOnA, get(s.fixedOnA));
      if (s.after) {
        row.after.n++;
        tally(row.after, get(s.after));
      }
      if (b !== t) {
        const c = t ? cause(s, group, k) : "false positive";
        row.causes[c] = (row.causes[c] ?? 0) + 1;
        misses.push({ group, fact: k, url: s.url, truth: t, before: b, fixedOnA: get(s.fixedOnA), after: s.after ? get(s.after) : null, cause: c, decided: s.decided[k] ?? null, ev: (s.ev[k] ?? []).slice(0, 3).map((e) => `${e.tag}${e.visible ? "" : "(hidden)"}: ${e.label.slice(0, 60)} ${e.urls.slice(0, 1).join(" ")}`) });
      } else if (get(s.fixedOnA) !== t) {
        misses.push({ group, fact: k, url: s.url, truth: t, before: b, fixedOnA: get(s.fixedOnA), after: s.after ? get(s.after) : null, cause: "new miss with the fixed code", decided: s.decided[k] ?? null, ev: (s.ev[k] ?? []).slice(0, 3).map((e) => `${e.tag}: ${e.label.slice(0, 60)}`) });
      } else if (s.after && get(s.after) !== t) {
        misses.push({ group, fact: k, url: s.url, truth: t, before: b, fixedOnA: get(s.fixedOnA), after: get(s.after), cause: "new miss after the fix", decided: s.decided[k] ?? null, ev: [] });
      }
    }
    table.push(row);
  }
}
// Footer year: right when it equals the broad probe's year (or the decided one).
const fy = { n: 0, before: 0, fixedOnA: 0, after: 0, afterN: 0, causes: {} };
for (const s of scored) {
  fy.n++;
  if (s.old.A.facts.footer_year === s.truth.footer_year) fy.before++;
  else misses.push({ group: "facts", fact: "footer_year", url: s.url, truth: s.truth.footer_year, before: s.old.A.facts.footer_year, fixedOnA: s.fixedOnA.facts.footer_year, after: s.after?.facts.footer_year ?? null, cause: "different year", decided: s.decided.footer_year ?? null, ev: [] });
  if (s.fixedOnA.facts.footer_year === s.truth.footer_year) fy.fixedOnA++;
  if (s.after) {
    fy.afterN++;
    if (s.after.facts.footer_year === s.truth.footer_year) fy.after++;
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`sites scored: ${scored.length} of ${sites.length} (skipped: ${sites.filter((s) => s.skipped).map((s) => `${s.url} [${s.skipped}]`).join(", ") || "none"})`);
console.log(`${pad("", 9)}${pad("fact", 15)}${pad("before right/FN/FP", 22)}${pad("fixed code, same reading", 26)}${pad("after (new visit)", 22)}causes of the misses before`);
for (const r of table) {
  const f = (b) => `${b.right}/${b.fn}/${b.fp}`;
  console.log(`${pad(r.group, 9)}${pad(r.fact, 15)}${pad(f(r.before), 22)}${pad(f(r.fixedOnA), 26)}${pad(r.after.n ? `${f(r.after)} of ${r.after.n}` : "-", 22)}${Object.entries(r.causes).map(([c, n]) => `${c}: ${n}`).join("; ")}`);
}
console.log(`facts    footer_year    ${fy.before} of ${fy.n} right; fixed code ${fy.fixedOnA}; after ${fy.afterN ? `${fy.after} of ${fy.afterN}` : "-"}`);
// Facts only gain: on the same reading, anything main's code found that the current code does not.
const lost = [];
for (const s of scored) {
  for (const k of keysOf("facts")) if (s.old.A.facts[k] === true && s.fixedOnA.facts[k] !== true) lost.push(`facts.${k} ${s.url}`);
  for (const k of SIGNALS) if (s.old.A.signals[k] === true && s.fixedOnA.signals[k] !== true) lost.push(`signals.${k} ${s.url}`);
  if (s.fixedOnA.raw.sections < s.old.A.raw.sections) lost.push(`facts.sections count ${s.old.A.raw.sections} -> ${s.fixedOnA.raw.sections} ${s.url}`);
}
console.log(`\nfound by main's code and not by the current code, same reading: ${lost.length ? lost.join("; ") : "none"}`);

// The browser second opinion (pipeline/render.mjs, used by the health check's
// signals and by evidence.mjs): the old code at its old reading point (R) and
// the current code on a load through the current renderer (--render <dir>).
const renderDir = args.includes("--render") ? args[args.indexOf("--render") + 1] : null;
if (renderDir) {
  const { createHash } = await import("node:crypto");
  console.log("\nrender.mjs (health check signals, evidence.mjs): old code at network idle + 1 s  ->  current code after settleText");
  for (const group of ["facts", "signals"]) {
    for (const k of keysOf(group)) {
      const b = { right: 0, fn: 0, fp: 0 };
      const a = { right: 0, fn: 0, fp: 0, n: 0 };
      for (const s of scored) {
        const t = s.truth[k];
        const get = (ans) => (group === "facts" ? ans.facts[k] : ans.signals[k]);
        const tally = (bucket, v) => (v === t ? bucket.right++ : t ? bucket.fn++ : bucket.fp++);
        tally(b, get(s.old.R));
        const rd = path.join(renderDir, createHash("sha1").update(s.url).digest("hex").slice(0, 12));
        const html = readMaybe(path.join(rd, "render.html"));
        const meta = JSON.parse(readMaybe(path.join(rd, "meta-render.json")) ?? "null");
        if (html != null && meta && !meta.error) {
          a.n++;
          tally(a, get(codeAnswer(now, html, readMaybe(path.join(rd, "render.txt")), { url: s.url, name: sample.find((x) => x.url === s.url).name }, meta.finalUrl)));
        }
      }
      console.log(`${pad(group, 9)}${pad(k, 15)}${pad(`${b.right}/${b.fn}/${b.fp}`, 22)}${a.right}/${a.fn}/${a.fp} of ${a.n}`);
    }
  }
  const scores = { before: [], after: [] };
  for (const s of scored) {
    scores.before.push(s.old.R.score);
    const rd = path.join(renderDir, createHash("sha1").update(s.url).digest("hex").slice(0, 12));
    const html = readMaybe(path.join(rd, "render.html"));
    if (html != null) scores.after.push(codeAnswer(now, html, "", { url: s.url, name: sample.find((x) => x.url === s.url).name }, s.url).score);
  }
  const low = (xs) => xs.filter((x) => x <= 1).length;
  console.log(`signal score <= 1 (needs_review): ${low(scores.before)} of ${scores.before.length} before, ${low(scores.after)} of ${scores.after.length} after`);
}

if (flags.has("--list")) {
  for (const m of misses) console.log(redact(`MISS ${m.group}.${m.fact} ${m.url} truth=${m.truth} before=${m.before} fixed=${m.fixedOnA} after=${m.after} [${m.cause}]${m.decided ? ` decided: ${m.decided}` : ""}\n     ${m.ev.join("\n     ")}`));
}
// The per-site JSON is for local digging only (it holds page evidence): keep it out of the repository.
if (jsonOut) fs.writeFileSync(jsonOut, redact(JSON.stringify({ table, footerYear: fy, misses, sites: sites.map((s) => (s.skipped ? s : { url: s.url, from: s.from, truth: s.truth, decided: s.decided, words: { R: s.meta.R?.words, A: s.meta.A?.words, A2: s.meta.A2?.words, B: s.meta.B?.words }, t: s.meta.t, before: { ...s.old.A.facts, ...Object.fromEntries(SIGNALS.map((k) => [`sig_${k}`, s.old.A.signals[k]])) }, fixedOnA: { ...s.fixedOnA.facts, ...Object.fromEntries(SIGNALS.map((k) => [`sig_${k}`, s.fixedOnA.signals[k]])) }, after: s.after ? { ...s.after.facts, ...Object.fromEntries(SIGNALS.map((k) => [`sig_${k}`, s.after.signals[k]])), settle: s.after.meta.settle, t: s.after.meta.t } : null })) }, null, 1)));
