#!/usr/bin/env node
// Measures the account-wide free allowances only the providers know and
// stores them for /admin/limits (lib/admin/limits.mjs, limit_snapshots):
//
//   Turso    rows read, rows written and storage this month, for the whole
//            account (all its databases share Turso Free's limits)
//   R2       storage of every bucket on the account, and this month's
//            Class A and Class B operations
//   Workers  this month's requests and CPU time, every Worker on the account
//
//   node scripts/limits-snapshot.mjs              measure and store
//   node scripts/limits-snapshot.mjs --dry-run    measure and print, store nothing
//   node scripts/limits-snapshot.mjs --input F    also take values from a JSON
//                                                 file { key: { used, cap?, detail? } }
//
// Where the numbers come from:
//   Turso       the Platform API with TURSO_PLATFORM_TOKEN and TURSO_ORG
//               (a platform token, not a database token), else the turso CLI
//               when it is installed and logged in (`turso plan show`)
//   Cloudflare  CLOUDFLARE_API_TOKEN (Account Analytics Read and R2 read) and
//               CLOUDFLARE_ACCOUNT_ID: R2 account metrics and the GraphQL
//               Analytics API
// A source that is missing or refused is skipped and said so; the page then
// shows that row as not measured, or keeps the last measurement with its date.
// The database written is TURSO_DATABASE_URL (with TURSO_AUTH_TOKEN), else
// the local file, like every pipeline script. Reads nothing from the app's
// tables and writes only limit_snapshots.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parsePlanShow, saveSnapshots } from "../lib/admin/limits.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const inputAt = args.indexOf("--input");
const ROOT = path.join(import.meta.dirname, "..");
const now = new Date();
const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00Z`;
const values = {};
const notes = [];

// ---------------------------------------------------------------------------
// Turso
// ---------------------------------------------------------------------------

async function turso() {
  const token = process.env.TURSO_PLATFORM_TOKEN;
  const org = process.env.TURSO_ORG;
  if (token && org) {
    const res = await fetch(`https://api.turso.tech/v1/organizations/${encodeURIComponent(org)}/usage`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return notes.push(`turso: the Platform API answered ${res.status}`);
    const body = await res.json();
    const u = body?.organization?.usage ?? {};
    const dbs = (body?.organization?.databases ?? []).map((d) => ({ name: d.name, read: d.usage?.rows_read ?? null, written: d.usage?.rows_written ?? null, storage: d.usage?.storage_bytes ?? null }));
    const detail = { databases: dbs, via: "platform-api" };
    values["turso.read"] = { used: Number(u.rows_read ?? 0), detail };
    values["turso.write"] = { used: Number(u.rows_written ?? 0), detail };
    values["turso.storage"] = { used: Number(u.storage_bytes ?? 0), detail };
    return;
  }
  const cli = [process.env.TURSO_CLI, path.join(process.env.HOME ?? "", ".turso", "turso"), "turso"].filter(Boolean).find((p) => p === "turso" || fs.existsSync(p));
  try {
    const out = execFileSync(cli, ["plan", "show"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    const p = parsePlanShow(out);
    if (p.rowsRead == null) return notes.push("turso: could not read `turso plan show`");
    const detail = { via: "turso plan show" };
    values["turso.read"] = { used: p.rowsRead, detail };
    values["turso.write"] = { used: p.rowsWritten, detail };
    values["turso.storage"] = { used: p.storage, detail };
  } catch {
    notes.push("turso: no TURSO_PLATFORM_TOKEN and TURSO_ORG, and no logged-in turso CLI");
  }
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

// R2 operation classes (developers.cloudflare.com/r2/pricing): deletes are free.
const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration", "LifecycleStorageTierTransition"]);
const FREE_OPS = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

async function cloudflare() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID;
  if (!token || !account) return notes.push("cloudflare: no CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  const api = async (p, init = {}) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false || body.errors?.length) throw new Error(`${p}: ${res.status} ${JSON.stringify(body.errors ?? []).slice(0, 200)}`);
    return body;
  };
  try {
    const m = (await api(`/accounts/${account}/r2/metrics`)).result;
    const bytes = (c) => Number(c?.published?.payloadSize ?? 0) + Number(c?.published?.metadataSize ?? 0) + Number(c?.uploaded?.payloadSize ?? 0);
    values["r2.storage"] = { used: bytes(m.standard) + bytes(m.infrequentAccess), detail: { objects: Number(m.standard?.published?.objects ?? 0) } };
  } catch (e) {
    notes.push(`cloudflare r2 metrics: ${e.message}`);
  }
  const query = `query($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
    r2: r2OperationsAdaptiveGroups(limit: 2000, filter: { datetime_geq: $s, datetime_leq: $e }) { sum { requests } dimensions { actionType bucketName } }
    storage: r2StorageAdaptiveGroups(limit: 200, filter: { datetime_geq: $s, datetime_leq: $e }) { max { payloadSize objectCount } dimensions { bucketName } }
    workers: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $s, datetime_leq: $e }) { sum { requests cpuTimeUs } dimensions { scriptName } }
  } } }`;
  try {
    const body = await api("/graphql", { method: "POST", body: JSON.stringify({ query, variables: { a: account, s: monthStart, e: now.toISOString() } }) });
    const acc = body.data?.viewer?.accounts?.[0];
    if (!acc) throw new Error("no account in the answer");
    const ops = { A: 0, B: 0 };
    const opsByBucket = {};
    for (const g of acc.r2 ?? []) {
      const t = g.dimensions.actionType;
      if (FREE_OPS.has(t)) continue;
      const c = CLASS_A.has(t) ? "A" : "B";
      ops[c] += g.sum.requests;
      const b = (opsByBucket[g.dimensions.bucketName || "?"] ??= { A: 0, B: 0 });
      b[c] += g.sum.requests;
    }
    const buckets = Object.fromEntries((acc.storage ?? []).map((g) => [g.dimensions.bucketName, { bytes: g.max.payloadSize, objects: g.max.objectCount }]));
    values["r2.classA"] = { used: ops.A, detail: { byBucket: opsByBucket } };
    values["r2.classB"] = { used: ops.B, detail: { byBucket: opsByBucket } };
    if (values["r2.storage"]) values["r2.storage"].detail = { ...values["r2.storage"].detail, buckets };
    const scripts = {};
    let requests = 0;
    let cpuUs = 0;
    for (const g of acc.workers ?? []) {
      requests += g.sum.requests;
      cpuUs += g.sum.cpuTimeUs;
      const s = (scripts[g.dimensions.scriptName] ??= { requests: 0, cpuMs: 0 });
      s.requests += g.sum.requests;
      s.cpuMs += Math.round(g.sum.cpuTimeUs / 1000);
    }
    values["workers.requests"] = { used: requests, detail: { scripts } };
    values["workers.cpu"] = { used: Math.round(cpuUs / 1000), detail: { scripts } };
  } catch (e) {
    notes.push(`cloudflare analytics: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------

await Promise.all([turso(), cloudflare()]);
if (inputAt >= 0) {
  const extra = JSON.parse(fs.readFileSync(args[inputAt + 1], "utf8"));
  for (const [k, v] of Object.entries(extra)) values[k] = { ...values[k], ...v };
}
for (const n of notes) console.log(`skipped: ${n}`);
for (const [k, v] of Object.entries(values)) console.log(`${k.padEnd(18)} ${Math.round(v.used).toLocaleString("en-US")}`);
if (dryRun) {
  console.log("dry run: nothing stored");
} else {
  const { pipelineDb } = await import("../pipeline/roster.mjs");
  const n = await saveSnapshots(pipelineDb(ROOT), values, now.toISOString());
  console.log(`stored ${n} measurement(s)`);
}
