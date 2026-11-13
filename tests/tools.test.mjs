// The free tools' caps (lib/tools/caps.mjs) and the discovery seen-set
// (lib/discovery/sites.mjs), on a throwaway in-memory database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { TOOL_CAPS, reserveTool, toolCaps, toolUsed } from "../lib/tools/caps.mjs";
import { DISCOVERY_TABLES, addPending, drop, seen, seenId } from "../lib/discovery/sites.mjs";
import { GRADER_TABLES } from "../lib/grader/schema.mjs";

const fresh = async () => {
  const db = createClient({ url: ":memory:" });
  await db.batch([...GRADER_TABLES, ...DISCOVERY_TABLES], "write");
  return db;
};

test("TOOLS_CAPS can only lower the caps, and junk is ignored", () => {
  assert.deepEqual(toolCaps(""), TOOL_CAPS);
  assert.equal(toolCaps('{"speed":{"site":100}}').speed.site, 100);
  assert.equal(toolCaps('{"speed":{"site":99999}}').speed.site, TOOL_CAPS.speed.site);
  assert.equal(toolCaps('{"page":{"visitor":-5}}').page.visitor, 0);
  assert.deepEqual(toolCaps("not json"), TOOL_CAPS);
  // The speed check never takes more than 500 of PageSpeed's free 25,000 a day.
  assert.ok(TOOL_CAPS.speed.site * 2 <= 500);
});

test("a reservation takes every counter or none", async () => {
  const db = await fresh();
  const caps = { speed: { visitor: 2, network: 3, network48: 9, site: 4 }, page: TOOL_CAPS.page };
  const now = new Date("2026-11-12T20:00:00Z");
  const as = (visitor, network) => reserveTool(db, { tool: "speed", visitor, network, caps, now });
  assert.equal((await as("v1", "n1")).ok, true);
  assert.equal((await as("v1", "n1")).ok, true);
  const v = await as("v1", "n1");
  assert.deepEqual([v.ok, v.scope], [false, "visitor"]);
  assert.equal((await as("v2", "n1")).ok, true);
  const n = await as("v3", "n1");
  assert.deepEqual([n.ok, n.scope], [false, "network"]);
  assert.equal((await as("v4", "n2")).ok, true);
  const s = await as("v5", "n3");
  assert.deepEqual([s.ok, s.scope], [false, "site"]);
  // Refused requests counted nothing.
  assert.equal(await toolUsed(db, { tool: "speed", day: v.day }), 4);
  // Midnight Pacific resets them; the page tools have their own counters.
  assert.ok(Date.parse(v.resetAt) > now.getTime());
  assert.equal((await reserveTool(db, { tool: "page", visitor: "v1", network: "n1", caps, now })).ok, true);
});

test("one seen-set row per site, whatever the spelling", async () => {
  assert.equal(seenId("https://www.Jane.dev/"), seenId("http://jane.dev"));
  assert.equal(seenId("https://jane.dev/work/"), seenId("https://jane.dev/work?x=1#top"));
  assert.notEqual(seenId("https://jane.dev/"), seenId("https://jane.dev/work"));
  assert.equal(typeof seenId("https://jane.dev/"), "bigint");

  const db = await fresh();
  assert.equal(await seen(db, "https://jane.dev/"), null);
  assert.deepEqual(await addPending(db, { url: "https://jane.dev/", source: "tools", now: new Date("2026-11-12T10:00:00Z") }), { status: "pending", added: true });
  assert.deepEqual(await addPending(db, { url: "https://www.jane.dev", source: "tools", now: new Date("2026-11-12T11:00:00Z") }), { status: "pending", added: false });
  const row = await seen(db, "https://JANE.dev");
  assert.deepEqual([row.status, row.source, row.firstSeen, row.checkedAt], ["pending", "tools", "2026-11-12T10:00:00.000Z", "2026-11-12T11:00:00.000Z"]);
  await assert.rejects(addPending(db, { url: "https://x.dev/", source: "somewhere" }));
});

test("a permanent drop forgets the address; a rechecked one keeps it with a date", async () => {
  const db = await fresh();
  const url = (s) => `https://${s}.dev/`;
  for (const s of ["tmpl", "dead"]) await addPending(db, { url: url(s), source: "tools" });
  await drop(db, { url: url("tmpl"), reason: "template" });
  await drop(db, { url: url("dead"), reason: "dead", recheckAt: new Date("2027-02-12T00:00:00Z") });
  const rows = (await db.execute("SELECT status, reason, url, recheck_at, tries FROM discovery_sites ORDER BY reason")).rows;
  assert.deepEqual(rows.map((r) => [r.status, r.reason, r.url, r.recheck_at, Number(r.tries)]), [
    ["dropped", "dead", url("dead"), "2027-02-12T00:00:00.000Z", 1],
    ["dropped", "template", null, null, 1],
  ]);
  // A dropped site stays dropped when a tool sees it again.
  assert.deepEqual(await addPending(db, { url: url("tmpl"), source: "tools" }), { status: "dropped", added: false });
});
