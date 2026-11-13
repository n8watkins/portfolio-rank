// The people queue's table (pipeline/people.mjs), on its own so code that
// only adds a request never imports the code that calls Gemini: a visitor's
// request enqueues here, and the Worker's hourly drain grades it
// (tests/gemini-reach.test.mjs).

export async function ensurePeopleSchema(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS people_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    name TEXT,
    email TEXT,
    shot_key TEXT,
    page_text TEXT,
    facts TEXT,
    meta TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    done_at TEXT,
    result TEXT,
    notified_at TEXT
  )`);
  await db.execute("CREATE INDEX IF NOT EXISTS people_requests_status_idx ON people_requests (status, created_at)");
}

/**
 * Adds a queued request (the capture's evidence: url, name, shot_key,
 * page_text, facts, meta, and the person's email) and returns its id.
 * Nothing here calls Gemini.
 */
export async function enqueueRequest(db, { kind = "grade", url, name = "", email = null, shot_key, page_text, facts, meta = null }, { now = Date.now() } = {}) {
  await ensurePeopleSchema(db);
  const at = new Date(now).toISOString();
  const res = await db.execute({
    sql: `INSERT INTO people_requests (kind, url, name, email, shot_key, page_text, facts, meta, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) RETURNING id`,
    args: [kind, url, name, email, shot_key, page_text, typeof facts === "string" ? facts : JSON.stringify(facts ?? null), meta == null ? null : typeof meta === "string" ? meta : JSON.stringify(meta), at, at],
  });
  return Number(res.rows[0].id);
}

export async function readRequest(db, id) {
  const r = (await db.execute({ sql: "SELECT * FROM people_requests WHERE id = ?", args: [id] })).rows[0];
  return r ? { ...r, result: r.result ? JSON.parse(String(r.result)) : null } : null;
}
