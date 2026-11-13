// The owner's goals check (pipeline/goals.mjs), by hand and always a dry run:
// measures the finished week before --now (default: now), and prints each
// goal's numbers and, for a goal that would fire, the email and the .ics
// invite the weekly check would send. Nothing is written or sent; the real
// check runs on the Worker's Monday cron (worker/goals.ts).
//   node scripts/goals-check.mjs [--now=2026-11-16T16:00:00Z] [--json]
// Production numbers: run with TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the
// environment (pass-env run -- node scripts/goals-check.mjs); without them it
// reads the local development file. The newsletter count asks Kit with
// KIT_API_KEY in the environment (pass-env run), else it shows "unknown".
import path from "node:path";
import { createClient } from "@libsql/client";
import { checkGoals } from "../pipeline/goals.mjs";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const now = arg("now") ? new Date(String(arg("now"))) : new Date();
if (Number.isNaN(now.getTime())) throw new Error(`--now is not a date: ${arg("now")}`);

const url = process.env.TURSO_DATABASE_URL;
const db = url
  ? createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: `file:${process.env.LOCAL_DB_FILE ?? path.join(process.cwd(), "data", "portfoliorank.db")}` });

const r = await checkGoals({ db, email: null, to: "OWNER_EMAIL", siteUrl: process.env.SITE_URL ?? "https://portfoliorank.dev", kitApiKey: process.env.KIT_API_KEY ?? null }, { now, dryRun: true });

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log(`Goals for the week of ${r.week} (checked as of ${now.toISOString()}, dry run: nothing written or sent)\n`);
  for (const g of r.goals) {
    const state = g.wouldFire ? "WOULD FIRE" : g.notifiedAt ? `fired ${g.notifiedAt}` : g.reached ? "reached" : "not yet";
    console.log(`${g.title} [${g.id}]: ${state}`);
    for (const c of g.conditions) console.log(`  ${c.met ? "[x]" : "[ ]"} ${c.label}: ${c.values.map((v) => (v == null ? "unknown" : v)).join(", ")}`);
    if (g.email) {
      console.log(`\n  Would email ${g.email.to}: ${g.email.subject}\n  Slot: ${g.slot?.start} to ${g.slot?.end}\n`);
      console.log(g.email.text.replace(/^/gm, "  | "));
      for (const a of g.email.attachments) console.log(`\n  Attachment ${a.filename} (${a.type}):\n${a.content.replace(/\r\n$/, "").replace(/\r\n/g, "\n").replace(/^/gm, "  | ")}`);
    }
    console.log("");
  }
}
