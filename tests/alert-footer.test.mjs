// Every owner alert says which system sent it (pipeline/alerts.mjs
// emailSender, alertFooter): site alerts go through Cloudflare Email Service,
// newsletters through Kit. Checked on a throwaway database with the test
// outbox standing in for the provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { alertFooter, emailSender } from "../pipeline/alerts.mjs";

test("every owner alert ends with the line naming Cloudflare Email Service, the sender and Kit", async () => {
  const db = createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "alert-footer-")), "db.sqlite")}` });
  await migrate(db);
  const env = { OWNER_EMAIL: "owner@example.com", EMAIL_FROM: "portfoliorank@n8builds.dev", EMAIL_TRANSPORT: "outbox", AUTH_SECRET: "test" };
  await emailSender(env, { db }).send({ to: env.OWNER_EMAIL, subject: "s", text: "Something happened." });
  const { text, kind } = (await db.execute("SELECT text, kind FROM email_outbox")).rows[0];
  assert.equal(kind, "owner-alert");
  assert.equal(
    String(text),
    "Something happened.\n\n--\nSite alert from PortfolioRank, sent through Cloudflare Email Service from portfoliorank@n8builds.dev. Newsletters go through Kit.\n"
  );
  assert.match(alertFooter(undefined), /from EMAIL_FROM\./);
  assert.ok(!alertFooter("x@y.z").includes("—"));
});
