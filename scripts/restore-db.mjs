// Restores a nightly snapshot (scripts/backup-db.mjs) into a NEW, EMPTY
// database, then checks every table's row count against the snapshot.
// It reads only RESTORE_DATABASE_URL and RESTORE_AUTH_TOKEN, and refuses to
// run when they point at the production database in TURSO_DATABASE_URL, so
// it can never write to production. The whole procedure, including the
// checks after it, is docs/ASSUMPTIONS.md section G.
//   pass-env run -- node scripts/restore-db.mjs /tmp/pr-restore.json.gz
import { createClient } from "@libsql/client";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { migrate } from "../lib/schema.mjs";
import { countsOf, restoreSnapshot, upgradeSnapshot } from "./lib/snapshot.mjs";

const file = process.argv[2];
const url = process.env.RESTORE_DATABASE_URL;
if (!file || !url) {
  console.error("usage: RESTORE_DATABASE_URL=... [RESTORE_AUTH_TOKEN=...] node scripts/restore-db.mjs SNAPSHOT.json.gz");
  process.exit(1);
}
if (process.env.TURSO_DATABASE_URL && process.env.TURSO_DATABASE_URL === url) {
  console.error("RESTORE_DATABASE_URL is the production database: restore only into a new scratch database");
  process.exit(1);
}

const raw = readFileSync(file);
const snap = upgradeSnapshot(JSON.parse((file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")));
const db = createClient({ url, authToken: process.env.RESTORE_AUTH_TOKEN });
const written = await restoreSnapshot(db, snap, { migrate });

let ok = true;
for (const [table, expected] of Object.entries(countsOf(snap))) {
  const n = Number((await db.execute(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);
  const line = `${table}: ${n} of ${expected}`;
  if (n !== expected || written[table] !== expected) {
    ok = false;
    console.error(`MISMATCH ${line}`);
  } else console.log(line);
}
console.log(ok ? `restored the snapshot of ${snap.exported_at}` : "the restore does not match the snapshot");
process.exit(ok ? 0 : 1);
