-- ============================================================
-- 033_agent_reviews.sql
-- Agent Review workspace: per-agent assessments, per-call "reviewed"
-- markers (the Reviewed KPI + optional per-call note), and a manual
-- change log whose latest entry anchors each review's call window.
--
-- RLS mirrors call_corrections (001_compliance.sql): authenticated
-- read + insert; the service role bypasses RLS entirely.
-- Run in Supabase SQL Editor.
-- ============================================================

-- ── agent_reviews : one row per saved review (append-only history) ──
create table if not exists agent_reviews (
  id             uuid primary key default gen_random_uuid(),
  ivr_name       text not null,              -- canonical agent
  reviewed_by    text,
  period_start   timestamptz,                -- window this review judged
  period_end     timestamptz,
  handling       text,                       -- 'yes' | 'mostly' | 'no'
  handling_note  text,
  has_glitches   boolean,
  glitches_note  text,
  redundant_qs   boolean,
  redundant_note text,
  cvr_wording    boolean,
  cvr_note       text,
  notes          text,
  calls_reviewed integer,
  created_at     timestamptz default now()
);
create index if not exists agent_reviews_ivr_idx on agent_reviews (ivr_name, created_at desc);

-- ── call_reviews : one row per call a human marked reviewed ──
create table if not exists call_reviews (
  call_id     text not null references canoe_calls(id) on delete cascade,
  ivr_name    text,
  reviewed_by text not null,
  note        text,
  reviewed_at timestamptz default now(),
  primary key (call_id, reviewed_by)
);
create index if not exists call_reviews_ivr_idx on call_reviews (ivr_name, reviewed_at desc);

-- ── agent_changes : manual change log; max(applied_at) = window anchor ──
create table if not exists agent_changes (
  id          uuid primary key default gen_random_uuid(),
  ivr_name    text not null,              -- canonical agent
  changed_by  text,
  description text,
  applied_at  timestamptz default now(),
  review_id   uuid references agent_reviews(id) on delete set null,
  created_at  timestamptz default now()
);
create index if not exists agent_changes_ivr_idx on agent_changes (ivr_name, applied_at desc);

-- ── Row Level Security (mirror call_corrections) ──
alter table agent_reviews enable row level security;
alter table call_reviews  enable row level security;
alter table agent_changes enable row level security;

-- read
create policy "auth read agent_reviews" on agent_reviews for select to authenticated using (true);
create policy "auth read call_reviews"  on call_reviews  for select to authenticated using (true);
create policy "auth read agent_changes" on agent_changes for select to authenticated using (true);

-- insert
create policy "auth insert agent_reviews" on agent_reviews for insert to authenticated with check (true);
create policy "auth insert call_reviews"  on call_reviews  for insert to authenticated with check (true);
create policy "auth insert agent_changes" on agent_changes for insert to authenticated with check (true);

-- call_reviews also needs update (upsert) + delete so a reviewer can
-- toggle the "reviewed" marker on and off.
create policy "auth update call_reviews" on call_reviews for update to authenticated using (true) with check (true);
create policy "auth delete call_reviews" on call_reviews for delete to authenticated using (true);
