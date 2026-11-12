// The content engine's tables (docs/CONTENT-ENGINE.md), part of the main
// schema (lib/schema.mjs, version 6; the image library, the neuron guard and
// the Pexels counter in version 9). Additive and idempotent.
import { LIBRARY_TABLES } from "./library.mjs";
import { NEURON_TABLES } from "./neurons.mjs";
import { PEXELS_TABLES } from "./pexels-searches.mjs";
import { JOB_TABLES } from "./jobs.mjs";
import { GUIDELINE_TABLES } from "./guidelines.mjs";
//
//   posts         one row per draft or post: the Markdown body and its
//                 metadata, the fact sheet every number came from, the
//                 checks it passed or failed, the images with their source,
//                 licence and credit, and the outside claims with their
//                 sources. status: draft (the private queue: dry-run
//                 drafts, and publish-mode drafts the weekly cap held back),
//                 published (live from publish_at), dropped (failed its
//                 checks after the revisions), unpublished (by the owner).
//   content_runs  each night's content work: picks, drafts (with why one was
//                 dropped), and the Gemini, Tavily and Workers AI calls each
//                 spent, which the caps count.
export const CONTENT_TABLES = [
  `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    mode TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    alt_titles TEXT,
    tags TEXT,
    share_line TEXT,
    newsletter_blurb TEXT,
    ai_line TEXT NOT NULL,
    ai_note TEXT NOT NULL,
    body TEXT NOT NULL,
    facts TEXT NOT NULL,
    checks TEXT NOT NULL,
    images TEXT NOT NULL,
    claims TEXT NOT NULL,
    data_as_of TEXT NOT NULL,
    publish_at TEXT,
    published_at TEXT,
    newsletter_pending INTEGER NOT NULL DEFAULT 0,
    night TEXT,
    run_id TEXT,
    requests INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS posts_status_idx ON posts (status, publish_at)",
  `CREATE TABLE IF NOT EXISTS content_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    night TEXT NOT NULL,
    at TEXT NOT NULL,
    week TEXT NOT NULL,
    step TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    kind TEXT,
    post_id TEXT,
    gemini INTEGER NOT NULL DEFAULT 0,
    tavily INTEGER NOT NULL DEFAULT 0,
    images_ai INTEGER NOT NULL DEFAULT 0,
    detail TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS content_runs_at_idx ON content_runs (at)",
  "CREATE INDEX IF NOT EXISTS content_runs_week_idx ON content_runs (week, step)",
  // Tavily credits used per calendar month (UTC), the monthly cap's counter (lib/content/tavily-credits.mjs).
  `CREATE TABLE IF NOT EXISTS tavily_credits (
    month TEXT PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0
  )`,
  // The image library and its uses (lib/content/library.mjs).
  ...LIBRARY_TABLES,
  // Workers AI neurons reserved per UTC day, the never-pay guard (lib/content/neurons.mjs).
  ...NEURON_TABLES,
  // Pexels searches per month (lib/content/pexels-searches.mjs).
  ...PEXELS_TABLES,
  // "Write a draft now" jobs and the editor's guidelines (schema version 12; lib/content/jobs.mjs, lib/content/guidelines.mjs).
  ...JOB_TABLES,
  ...GUIDELINE_TABLES,
];
