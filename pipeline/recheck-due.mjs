#!/usr/bin/env node
// How many sites the hourly re-check has to look at (.github/workflows/recheck.yml),
// asked before anything is installed, so an hour with nothing due costs one
// query: no `npm ci`, no browser. Prints the count and writes `due=<n>` to
// GITHUB_OUTPUT.
//
// With TURSO_DATABASE_URL it asks Turso's HTTP API with plain fetch (no
// packages); without it, the local database through the pipeline's client
// (that one needs `npm ci`). When the count cannot be read (the pool's columns
// are not there yet, Turso answers an error), it says "unknown", and the
// workflow runs the full re-check, which creates them.
//
// Usage: node pipeline/recheck-due.mjs
import fs from "node:fs";
import path from "node:path";
import { DUE_COUNT_SQL, dueCutoff } from "./not-working.mjs";

const out = (due) => {
  console.log(`due=${due}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\n`);
};

/** One statement over Turso's HTTP API (/v2/pipeline); returns the first cell. */
export async function tursoCount(url, token, sql, args, fetchImpl = globalThis.fetch) {
  const base = String(url).replace(/^libsql:\/\//, "https://").replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/v2/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args: args.map((v) => ({ type: "text", value: String(v) })) } }, { type: "close" }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Turso answered HTTP ${res.status}`);
  const first = (await res.json())?.results?.[0];
  if (first?.type !== "ok") throw new Error(`Turso: ${first?.error?.message ?? "no result"}`);
  return Number(first.response?.result?.rows?.[0]?.[0]?.value ?? 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = [dueCutoff(new Date())];
  try {
    let n;
    if (process.env.TURSO_DATABASE_URL) {
      n = await tursoCount(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN, DUE_COUNT_SQL, args);
    } else {
      const { pipelineDb } = await import("./roster.mjs");
      const db = pipelineDb(path.join(import.meta.dirname, ".."));
      n = Number((await db.execute({ sql: DUE_COUNT_SQL, args })).rows[0].n);
    }
    out(n);
  } catch (e) {
    console.log(`::notice::Could not count the due re-checks (${String(e?.message ?? e).slice(0, 200)}); running the full re-check.`);
    out("unknown");
  }
}
