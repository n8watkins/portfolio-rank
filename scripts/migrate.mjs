// Brings the database up to date with lib/schema.mjs. The deploy workflow runs
// it before the new code goes live (TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in
// the environment); without them it migrates the local development file.
//   node scripts/migrate.mjs
import path from "node:path";
import { createClient } from "@libsql/client";
import { SCHEMA_VERSION, migrate, schemaVersion } from "../lib/schema.mjs";

const url = process.env.TURSO_DATABASE_URL;
const client = url
  ? createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({
      url: `file:${process.env.LOCAL_DB_FILE ?? path.join(process.cwd(), "data", "portfoliorank.db")}`,
    });

const before = await schemaVersion(client);
const added = await migrate(client);
console.log(
  `schema: version ${before} -> ${SCHEMA_VERSION}` +
    (added.length ? `; added ${added.join(", ")}` : "; no columns to add")
);
