// One-off: ports v0 JSON-file votes/ratings/caches into libSQL (local file
// or Turso, depending on env). Safe to re-run; skips files that don't exist.
import { createClient } from "@libsql/client";
import fs from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
const db = process.env.TURSO_DATABASE_URL
  ? createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    })
  : createClient({ url: `file:${path.join(dataDir, "portfoliorank.db")}` });

await db.batch(
  [
    `CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      winner TEXT NOT NULL, loser TEXT NOT NULL,
      rater_type TEXT NOT NULL DEFAULT 'anon', rater_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS ratings (
      url TEXT PRIMARY KEY, elo INTEGER NOT NULL DEFAULT 1200,
      votes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ],
  "write"
);

const ratingsFile = path.join(dataDir, "ratings.json");
if (fs.existsSync(ratingsFile)) {
  const ratings = JSON.parse(fs.readFileSync(ratingsFile, "utf8"));
  for (const [url, r] of Object.entries(ratings)) {
    await db.execute({
      sql: `INSERT INTO ratings (url, elo, votes) VALUES (?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET elo = excluded.elo, votes = excluded.votes`,
      args: [url, r.elo, r.votes],
    });
  }
  console.log(`migrated ${Object.keys(ratings).length} ratings`);
}

const votesFile = path.join(dataDir, "votes.jsonl");
if (fs.existsSync(votesFile)) {
  const lines = fs.readFileSync(votesFile, "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const v = JSON.parse(line);
    await db.execute({
      sql: "INSERT INTO votes (winner, loser, rater_type, rater_id, created_at) VALUES (?, ?, 'anon', ?, ?)",
      args: [v.winner, v.loser, v.rater ?? "local", v.at],
    });
  }
  console.log(`migrated ${lines.length} votes`);
}
