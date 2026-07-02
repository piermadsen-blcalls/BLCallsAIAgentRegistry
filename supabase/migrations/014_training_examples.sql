-- ============================================================
-- 014_training_examples.sql
-- Human-reviewed ground-truth labels — the curated training/eval set.
-- ONE row per call (the human's correct answer). Populated only via the
-- dashboard Review panel; nothing auto-populates it.
--
-- Any model's accuracy = compare its output (model_test_results.our_outcome
-- for tests, or canoe_calls.our_outcome for production) to correct_outcome here.
-- Run in Supabase SQL Editor.
-- ============================================================

create table if not exists training_examples (
  id              uuid primary key default gen_random_uuid(),
  call_id         text not null unique,      -- one ground-truth per call (upsert on re-review)
  source          text,                      -- 'model_test:<uuid>' or 'production'
  transcript      text,                      -- snapshot, so the example survives call deletion
  context         jsonb,                     -- snapshot: vertical_name, zip, duration, canoe_outcome
  correct_outcome text not null,
  correct_flags   jsonb default '[]'::jsonb,
  reason          text,                      -- why the AI was wrong / reviewer notes
  reviewed_by     text,
  reviewed_at     timestamptz default now()
);

create index if not exists training_examples_source_idx on training_examples (source);

alter table training_examples enable row level security;

create policy "auth users can read training_examples"
  on training_examples for select to authenticated using (true);
create policy "auth users can insert training_examples"
  on training_examples for insert to authenticated with check (true);
create policy "auth users can update training_examples"
  on training_examples for update to authenticated using (true) with check (true);

create policy "service role full access training_examples"
  on training_examples for all to service_role using (true) with check (true);
