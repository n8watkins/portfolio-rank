-- PortfolioRank — Supabase schema
-- Run in the Supabase SQL editor after creating the project.

-- Raw vote log: append-only, source of truth. ELO is always recomputable
-- from this table, so bad actors can be purged retroactively.
create table votes (
  id bigint generated always as identity primary key,
  winner text not null,
  loser text not null,
  rater_type text not null default 'anon' check (rater_type in ('human', 'anon', 'ai')),
  rater_id text not null, -- auth.uid for humans, session id for anon, model id for ai
  created_at timestamptz not null default now()
);
create index votes_rater_idx on votes (rater_id, created_at);

-- Current ratings (denormalized for fast reads; rebuilt from votes if needed).
create table ratings (
  url text primary key,
  elo int not null default 1200,
  votes int not null default 0,
  updated_at timestamptz not null default now()
);
create index ratings_elo_idx on ratings (elo desc);

-- One vote per user per pair (unordered).
create unique index votes_unique_pair_per_rater
  on votes (rater_id, least(winner, loser), greatest(winner, loser));

-- Cached diagnostics (replaces local data/*-cache.json files).
create table site_checks (
  url text primary key,
  inspect jsonb,
  psi jsonb,
  checked_at timestamptz not null default now()
);

alter table votes enable row level security;
alter table ratings enable row level security;
alter table site_checks enable row level security;

-- Reads are public; writes go through the service-role key in API routes only.
create policy "public read ratings" on ratings for select using (true);
create policy "public read site_checks" on site_checks for select using (true);
