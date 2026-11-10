#!/usr/bin/env node
// Give back to the community list: once a month, one pull request to
// emmabostian/developer-portfolios removing entries PortfolioRank's health
// check confirmed down (3+ failed weekly checks spanning 2+ weeks, so never a
// site that is only "suspect"). Every candidate is checked once more right
// before the pull request; any that load again are left in place.
//
// The format follows the list's own removal pull requests (for example
// emmabostian/developer-portfolios#4450): title "Remove N broken portfolio
// links", a Summary table with each entry's reason, a "Left in place" list,
// and a test plan; README.md loses the lines, the "Current Portfolio Count"
// is updated and feed.json is regenerated with the list's src/generate_feed.py.
//
// This script only prepares the change. .github/workflows/upstream-removals.yml
// pushes it from the owner's fork and opens or updates the pull request.
//
// Usage:
//   node pipeline/upstream-removals.mjs --readme <upstream README.md> --out <dir>
//                                       [--cap 25] [--no-browser]
//     Writes <dir>/README.md (preview), <dir>/pr-title.txt, <dir>/pr-body.md,
//     <dir>/plan.json; prints a Markdown report (also to GITHUB_STEP_SUMMARY).
//   node pipeline/upstream-removals.mjs --apply <dir>/plan.json --readme <README.md>
//     Removes the planned entries from that README in place (the fork's fresh
//     copy, so nothing merged upstream since the plan is lost).
import fs from "fs";
import path from "path";
import { readRenderedPage, UA } from "./gate.mjs";
import { checkSite, DOWN_AFTER_DAYS, FAILS_TO_DOWN, normKey } from "./health.mjs";
import { readJson } from "./exclusions.mjs";

export const DEFAULT_CAP = 25;
const ENTRY = /^-\s+\[([^\]]+)\]\(([^)]+)\)/;
const SITE = "https://portfoliorank.n8builds.dev";

/**
 * Exclusions that qualify for upstream: kind "down" with evidence spanning at
 * least DOWN_AFTER_DAYS over FAILS_TO_DOWN checks. Duplicates, "not a
 * portfolio" grades and takedowns stay ours alone. Oldest removals first.
 */
export function selectCandidates(excluded) {
  return excluded
    .filter((e) => e && typeof e === "object" && e.kind === "down" && e.url)
    .filter((e) => {
      if (!e.first_failed || !e.last_checked) return false;
      const span = (new Date(e.last_checked) - new Date(e.first_failed)) / 86400000;
      return Number(e.checks ?? 0) >= FAILS_TO_DOWN && span >= DOWN_AFTER_DAYS;
    })
    .sort((a, b) => String(a.removed ?? "").localeCompare(String(b.removed ?? "")));
}

/**
 * Remove the README lines for these URLs (matched by normalized URL) and
 * update the "Current Portfolio Count". Returns { readme, removed, missing }.
 */
export function removeFromReadme(readme, urls) {
  const want = new Map(urls.map((u) => [normKey(u), u]));
  const removed = [];
  const found = new Set();
  const lines = readme.split("\n").filter((line) => {
    const m = line.trim().match(ENTRY);
    if (!m) return true;
    const key = normKey(m[2].trim());
    if (!want.has(key)) return true;
    found.add(key);
    removed.push({ name: m[1].trim(), url: want.get(key), line });
    return false;
  });
  const count = lines.filter((l) => ENTRY.test(l.trim())).length;
  const out = lines
    .join("\n")
    .replace(/^(##\s*Current Portfolio Count:\s*)\d+/m, `$1${count}`);
  const missing = [...want].filter(([k]) => !found.has(k)).map(([, u]) => u);
  return { readme: out, removed, missing };
}

const day = (iso) => String(iso ?? "").slice(0, 10);
const bare = (url) => String(url).replace(/^https?:\/\//, "").replace(/\/$/, "");
const cell = (s) => String(s ?? "").replace(/\|/g, "/");

export function prTitle(n) {
  return `Remove ${n} broken portfolio link${n === 1 ? "" : "s"}`;
}

/** The pull request body, in the list's own format. */
export function prBody({ removals, leftInPlace, alreadyGone, checkedOn }) {
  const lines = [
    "## Summary",
    `[PortfolioRank](${SITE}) is a ranked gallery built on this list.`,
    `It checks every entry once a week with a browser User-Agent, redirects followed, a retry for timeouts and server errors, and a headless-browser second opinion; bot checks (403/429 challenges) never count as failures.`,
    `The ${removals.length} entr${removals.length === 1 ? "y" : "ies"} below failed ${FAILS_TO_DOWN} or more checks in a row spanning at least two weeks, and failed again when re-checked on ${checkedOn} right before this pull request.`,
    "",
    "| Name | URL | Reason | Failing since | Last checked |",
    "| --- | --- | --- | --- | --- |",
    ...removals.map(
      (r) => `| ${cell(r.name)} | ${cell(bare(r.url))} | ${cell(r.reason)} | ${day(r.first_failed)} | ${checkedOn} |`
    ),
    "",
  ];
  if (leftInPlace.length) {
    lines.push("Left in place (loaded again on the re-check):");
    for (const l of leftInPlace) lines.push(`- \`${bare(l.url)}\``);
    lines.push("");
  }
  lines.push(
    `Already removed from README.md by earlier PRs: ${alreadyGone.length ? alreadyGone.map((u) => `\`${bare(u)}\``).join(", ") : "none"}.`,
    "",
    "Portfolio count updated and `feed.json` regenerated with `python src/generate_feed.py`; no other entries changed.",
    "",
    "## Test plan",
    `- [x] Each URL failed ${FAILS_TO_DOWN}+ automated weekly checks spanning 2+ weeks (dates in the table)`,
    `- [x] Each URL re-checked on ${checkedOn}, right before opening this PR`,
    "- [x] `feed.json` regenerated from README.md",
    "",
    "One batched pull request per month, at most 25 removals, opened by PortfolioRank's cleanup job. If one of these is a mistake, comment here and it will be dropped.",
    ""
  );
  return lines.join("\n");
}

/**
 * Plan the pull request: candidates still in the upstream README, re-checked
 * now, capped. `check(entry)` returns checkSite's result.
 */
export async function planUpstream({ excluded, readme, check, cap = DEFAULT_CAP, now = new Date() }) {
  const candidates = selectCandidates(excluded);
  const listed = new Set(
    readme
      .split("\n")
      .map((l) => l.trim().match(ENTRY)?.[2]?.trim())
      .filter(Boolean)
      .map(normKey)
  );
  const alreadyGone = candidates.filter((c) => !listed.has(normKey(c.url))).map((c) => c.url);
  const removals = [];
  const leftInPlace = [];
  for (const c of candidates.filter((c) => listed.has(normKey(c.url)))) {
    if (removals.length >= cap) break;
    const r = await check(c);
    // Only a fresh, definite failure goes upstream; a pass or a bot wall stays.
    if (r.ok === false) removals.push({ ...c, reason: r.reason || c.reason });
    else leftInPlace.push({ url: c.url, reason: r.ok === null ? r.reason : "loads" });
  }
  const edit = removeFromReadme(readme, removals.map((r) => r.url));
  const checkedOn = now.toISOString().slice(0, 10);
  return {
    removals,
    leftInPlace,
    alreadyGone,
    readme: edit.readme,
    title: prTitle(removals.length),
    body: prBody({ removals, leftInPlace, alreadyGone, checkedOn }),
  };
}

// ---------------------------------------------------------------------------
// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const ROOT = path.join(import.meta.dirname, "..");
  const out = flag("out");
  const readmePath = flag("readme");
  if (flag("apply") && readmePath) {
    const { urls } = JSON.parse(fs.readFileSync(flag("apply"), "utf8"));
    const edit = removeFromReadme(fs.readFileSync(readmePath, "utf8"), urls);
    fs.writeFileSync(readmePath, edit.readme);
    console.log(`removed ${edit.removed.length} entr${edit.removed.length === 1 ? "y" : "ies"}, ${edit.missing.length} already gone`);
    if (edit.removed.length !== urls.length - edit.missing.length || !edit.removed.length) process.exit(1);
    process.exit(0);
  }
  if (!out || !readmePath) {
    console.error("usage: node pipeline/upstream-removals.mjs --readme <README.md> --out <dir> [--cap N] [--no-browser]");
    process.exit(1);
  }
  let browser = null;
  let render;
  if (!args.includes("--no-browser")) {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    render = async (url) => {
      const ctx = await browser.newContext({ userAgent: UA });
      try {
        const page = await ctx.newPage();
        const res = await page.goto(url, { waitUntil: "load", timeout: 30000 });
        await page.waitForTimeout(1500);
        return {
          status: res?.status() ?? 0,
          finalUrl: page.url(),
          title: await page.title().catch(() => ""),
          ...(await page.evaluate(readRenderedPage).catch(() => ({ text: "", media: false }))),
        };
      } finally {
        await ctx.close().catch(() => {});
      }
    };
  }
  try {
    const plan = await planUpstream({
      excluded: readJson(path.join(ROOT, "data", "excluded.json"), []),
      readme: fs.readFileSync(readmePath, "utf8"),
      check: (e) => checkSite(e, { render }),
      cap: Number(flag("cap", String(DEFAULT_CAP))),
    });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "README.md"), plan.readme);
    fs.writeFileSync(path.join(out, "pr-title.txt"), plan.title);
    fs.writeFileSync(path.join(out, "pr-body.md"), plan.body);
    fs.writeFileSync(
      path.join(out, "plan.json"),
      JSON.stringify(
        {
          removals: plan.removals.length,
          urls: plan.removals.map((r) => r.url),
          leftInPlace: plan.leftInPlace,
          alreadyGone: plan.alreadyGone,
        },
        null,
        2
      )
    );
    const md = [
      "## Upstream removals",
      "",
      plan.removals.length
        ? `${plan.removals.length} removal(s) ready for emmabostian/developer-portfolios.`
        : "Nothing to send upstream.",
      "",
      ...(plan.removals.length ? [`### ${plan.title}`, "", plan.body] : []),
    ].join("\n");
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  } finally {
    await browser?.close();
  }
}
