-- ============================================================
-- 006_model_tests.sql
-- Tables for multi-model accuracy testing.
-- Run in Supabase SQL Editor.
-- ============================================================

create table model_tests (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz default now(),
  model        text not null,
  sample_size  integer not null,
  status       text not null default 'pending',  -- pending | running | completed | failed
  triggered_by text
);

create table model_test_results (
  id          uuid primary key default gen_random_uuid(),
  test_id     uuid not null references model_tests(id) on delete cascade,
  call_id     text not null,
  model       text not null,
  our_outcome text,
  flags       jsonb default '[]',
  raw_response jsonb,
  created_at  timestamptz default now()
);

create index model_test_results_test_id_idx on model_test_results(test_id);
create index model_test_results_call_id_idx on model_test_results(call_id);

-- RLS
alter table model_tests enable row level security;
alter table model_test_results enable row level security;

create policy "auth users can read model_tests"
  on model_tests for select to authenticated using (true);
create policy "auth users can insert model_tests"
  on model_tests for insert to authenticated with check (true);
create policy "auth users can update model_tests"
  on model_tests for update to authenticated using (true) with check (true);

create policy "auth users can read model_test_results"
  on model_test_results for select to authenticated using (true);
create policy "auth users can insert model_test_results"
  on model_test_results for insert to authenticated with check (true);

-- Service role also needs write access (process.js uses service key)
create policy "service role can insert model_tests"
  on model_tests for insert to service_role with check (true);
create policy "service role can update model_tests"
  on model_tests for update to service_role using (true) with check (true);
create policy "service role can insert model_test_results"
  on model_test_results for insert to service_role with check (true);
