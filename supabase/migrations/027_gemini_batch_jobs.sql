-- ============================================================
-- 027_gemini_batch_jobs.sql
-- Tracks Gemini Batch API jobs across GitHub Actions runs.
-- process.js "submit" inserts a row per batch job; "ingest" polls
-- these rows in a later run and writes results back to canoe_calls.
-- Run in Supabase SQL Editor.
-- ============================================================

create table if not exists gemini_batch_jobs (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null default 'gemini',
  job_name     text not null,                 -- Gemini batch resource name, e.g. "batches/abc123"
  model        text not null,
  prompt_id    uuid,                           -- ai_prompts row used at submit time
  status       text not null default 'submitted',
  -- status: submitted | processing | completed | failed | expired | cancelled
  call_ids     jsonb not null,                 -- canoe_calls ids in this job, in request order
  call_count   integer,
  error        text,
  submitted_at timestamptz default now(),
  completed_at timestamptz,
  created_at   timestamptz default now()
);

-- ingest polls open jobs; keep this lookup cheap.
create index if not exists gemini_batch_jobs_status_idx
  on gemini_batch_jobs (status)
  where status in ('submitted', 'processing');

create index if not exists gemini_batch_jobs_submitted_at_idx
  on gemini_batch_jobs (submitted_at desc);

alter table gemini_batch_jobs enable row level security;

create policy "auth users can read gemini_batch_jobs"
  on gemini_batch_jobs for select to authenticated using (true);

create policy "service role can insert gemini_batch_jobs"
  on gemini_batch_jobs for insert to service_role with check (true);

create policy "service role can update gemini_batch_jobs"
  on gemini_batch_jobs for update to service_role using (true) with check (true);
