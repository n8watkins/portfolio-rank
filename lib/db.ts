import { createClient, type Client } from "@libsql/client";
import path from "path";
import { migrate, schemaIsCurrent } from "./schema.mjs";

// Turso in production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN), a local
// libSQL file in dev - same client, same SQL.
let client: Client | null = null;
let ready: Promise<void> | null = null;

export function db(): Client {
  if (!client) {
    client = process.env.TURSO_DATABASE_URL
      ? createClient({
          url: process.env.TURSO_DATABASE_URL,
          authToken: process.env.TURSO_AUTH_TOKEN,
        })
      : createClient({
          // LOCAL_DB_FILE lets the end-to-end tests use a throwaway file.
          url: `file:${process.env.LOCAL_DB_FILE ?? path.join(process.cwd(), "data", "portfoliorank.db")}`,
          // A local file is shared by several connections (the client's pool,
          // and the test process in the end-to-end tests). Without a busy
          // timeout a write that meets another connection's lock fails at
          // once with SQLITE_BUSY and the request answers 500.
          timeout: 5000,
        });
  }
  return client;
}

/**
 * Resolves once the database has the current schema (lib/schema.mjs). Costs
 * one query per isolate when it does - deploys migrate ahead of time
 * (scripts/migrate.mjs) - and migrates when it doesn't. A failure (a network
 * blip, say) isn't remembered: the next call tries again.
 */
export function ensureSchema(): Promise<void> {
  if (!ready) {
    const attempt = (async () => {
      if (await schemaIsCurrent(db())) return;
      await migrate(db());
    })();
    ready = attempt;
    attempt.catch(() => {
      if (ready === attempt) ready = null;
    });
  }
  return ready;
}
