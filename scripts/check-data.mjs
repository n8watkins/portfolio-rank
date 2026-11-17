#!/usr/bin/env node
// Checks that the data files have the shape this code reads, before a build
// that puts new data under released code goes to production.
//
// Production is the last release's code built over main's data/ (DEPLOY.md
// "How a change ships"), and pages import data/feed.json and
// data/excluded.json straight into the build. So a data file can be newer
// than the code that reads it: this is the released code's own statement of
// what it can read. The deploy runs it first and stops when it fails, which
// leaves the site as it was.
//
//   node scripts/check-data.mjs [dir]     dir defaults to ./data
//
// It is no stricter than the code that reads each file, so it never blocks
// data the site would have shown: new fields are fine, and so is whatever a
// reader already skips. A file that is not JSON, a list cut short, or a
// missing or mistyped field that a page reads is not.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** A truncated or emptied list never reaches production. */
export const MIN_FEED = 100;
const MAX_PROBLEMS = 20;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";

function isWebAddress(v) {
  if (!isText(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {{ feed: unknown, additions: unknown, excluded: unknown }} data parsed files
 * @returns {string[]} problems, empty when the data is good
 */
export function checkData({ feed, additions, excluded }) {
  const problems = [];
  const say = (m) => problems.push(m);

  const list = (name, value, each) => {
    if (!Array.isArray(value)) {
      say(`${name} is not a list`);
      return;
    }
    value.forEach((entry, i) => {
      if (!isObject(entry)) say(`${name}[${i}] is not an object`);
      else each(entry, `${name}[${i}]`);
    });
  };

  list("feed.json", feed, (e, at) => {
    if (!isText(e.name)) say(`${at} has no name`);
    if (!isWebAddress(e.url)) say(`${at} has no web address (url: ${JSON.stringify(e.url)})`);
    if (e.tagline !== undefined && typeof e.tagline !== "string") say(`${at} has a tagline that is not text`);
    // The list's current spelling of a site stored under another address (pipeline/list-key.mjs).
    if (e.href !== undefined && (!isWebAddress(e.href) || e.href === e.url)) say(`${at} has an href that is not another web address (href: ${JSON.stringify(e.href)})`);
  });
  if (Array.isArray(feed) && feed.length < MIN_FEED) {
    say(`feed.json lists ${feed.length} portfolios, fewer than ${MIN_FEED}: it looks cut short`);
  }

  // No page imports additions.json; the feed generator reads it and skips an
  // entry without an address, so objects are all it needs.
  list("additions.json", additions, () => {});

  // As loose as its readers: app/removed/page.tsx skips bare address strings
  // (old entries) and entries without a url, and pipeline/generate_feed.py
  // takes a string or an object. Anything else would break the generator, and
  // a field the page prints must be text.
  if (!Array.isArray(excluded)) {
    say("excluded.json is not a list");
  } else {
    excluded.forEach((e, i) => {
      const at = `excluded.json[${i}]`;
      if (typeof e === "string") return;
      if (!isObject(e)) {
        say(`${at} is neither an address nor an object`);
        return;
      }
      for (const field of ["url", "name", "kind", "reason", "removed"]) {
        if (e[field] !== undefined && typeof e[field] !== "string") say(`${at} has a ${field} that is not text`);
      }
    });
  }

  return problems;
}

/** Reads the three files; a file that is missing or not JSON is a problem too. */
export function checkDataDir(dir) {
  const data = {};
  const problems = [];
  for (const name of ["feed", "additions", "excluded"]) {
    const file = path.join(dir, `${name}.json`);
    try {
      data[name] = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      problems.push(`${name}.json cannot be read: ${e.message}`);
      data[name] = [];
    }
  }
  return problems.length ? problems : checkData(data);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2] ?? "data";
  const problems = checkDataDir(dir);
  if (problems.length) {
    console.error(`The data in ${dir} does not fit this code (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
    for (const p of problems.slice(0, MAX_PROBLEMS)) console.error(`  - ${p}`);
    if (problems.length > MAX_PROBLEMS) console.error(`  ... and ${problems.length - MAX_PROBLEMS} more`);
    process.exit(1);
  }
  console.log(`The data in ${dir} fits this code.`);
}
