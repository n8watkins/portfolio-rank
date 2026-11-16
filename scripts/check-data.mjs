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
// New fields are fine (pages ignore what they do not know). A missing or
// mistyped field that a page reads is not.
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
  });
  if (Array.isArray(feed) && feed.length < MIN_FEED) {
    say(`feed.json lists ${feed.length} portfolios, fewer than ${MIN_FEED}: it looks cut short`);
  }

  list("additions.json", additions, (e, at) => {
    if (!isText(e.name)) say(`${at} has no name`);
    if (!isWebAddress(e.url)) say(`${at} has no web address (url: ${JSON.stringify(e.url)})`);
  });

  list("excluded.json", excluded, (e, at) => {
    if (!isWebAddress(e.url)) say(`${at} has no web address (url: ${JSON.stringify(e.url)})`);
    for (const field of ["name", "kind", "reason", "removed"]) {
      if (e[field] !== undefined && typeof e[field] !== "string") say(`${at} has a ${field} that is not text`);
    }
  });

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
