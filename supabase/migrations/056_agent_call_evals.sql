-- ============================================================
-- 056_agent_call_evals.sql
-- AI agent performance scoring: a second, separate scorer for the AI agent's own conversation.
--
-- Today's scorer (process.js) reads canoe_calls.transcription, which on ASCND calls is the
-- BUYER leg after the transfer, so the agent's side (ascnd_transcript) is graded on 0% of calls
-- and ~70% of agent calls (no Canoe transcript) are not scored at all.
-- scripts/agent_eval.js reads ascnd_transcript on every ASCND call that has one and judges the
-- agent: transfer/reject decision and whether it was right, qualifying rules, drop-off stage and
-- reason, understanding, script, agent-side compliance flags, intent and disposition checks.
-- Design: firstmate data/ivr-agent-score/report.md (approved 2026-11-12).
--
-- 1) agent_call_evals: one row per call. The ONLY table the agent scorer writes results to;
--    it never touches canoe_calls.our_outcome, scores, flags or ai_processed_at, so Scores,
--    Insights, the Calls flag filters and the digest do not move.
-- 2) agent_eval_jobs: the agent scorer's Gemini batch jobs. Kept apart from gemini_batch_jobs
--    so the call scorer's ingest (which writes canoe_calls) can never pick up an agent job.
-- 3) call_reviews.eval_disagree: a reviewer's "AI got this wrong" mark (calibration signal).
-- 4) agent_eval_pending(): the scorer's queue (ASCND calls with an agent transcript and no eval
--    row). Uses the existing canoe_calls_ascnd_transcript_idx; ~0.1s for 30 days.
-- 5) agent_eval_metrics(): per-IVR rollup for the Agents tab and the Review board. The table is
--    small (~120 rows/day), so it aggregates live; no pg_cron rollup.
--
-- Access: agent_call_evals is readable by authenticated (RLS policy) and written only by the
-- service role. agent_eval_jobs and agent_eval_pending() are service-role only. agent_eval_metrics()
-- runs as the caller and is executable by authenticated, not anon. call_reviews keeps its
-- existing policies (the new column is covered by them).
-- Rollback: supabase/rollbacks/056_agent_call_evals_down.sql
-- Test:     supabase/tests/056_agent_call_evals_test.sql
-- ============================================================

-- ── 1) Per-call agent evaluations ──
create table if not exists agent_call_evals (
  call_id          text primary key references canoe_calls(id) on delete cascade,
  ivr_name         text not null,          -- raw; the page resolves aliases (like agent_metrics)
  call_at          timestamptz not null,   -- canoe_calls.created_at
  verdict          text not null
                   check (verdict in ('good', 'minor', 'major', 'no_conversation', 'unclear')),  -- code-computed
  decision         text,                   -- transferred | rejected | caller_left | stalled
  decision_verdict text,                   -- correct | over_transfer | over_reject | not_applicable | unclear
  dropoff_stage    text,                   -- none | intro | mid_qualification | at_transfer
  drop_reason      text,
  understanding    text,                   -- smooth | mishears | pauses | stuck
  script           text,                   -- good | too_long | late_dq | missing_question
  agent_flags      jsonb not null default '[]',
  summary          text,
  top_issue        text,
  eval             jsonb not null,         -- full validated reply (rules, evidence, intent_match, ...)
  model            text,                   -- null for code-decided no_conversation rows
  prompt_version   text not null,          -- re-score a version by deleting its rows
  input_tokens     int,
  output_tokens    int,                    -- includes thinking tokens (billed as output)
  scored_at        timestamptz not null default now()
);
create index if not exists agent_call_evals_call_at_idx on agent_call_evals (call_at);
create index if not exists agent_call_evals_ivr_idx     on agent_call_evals (ivr_name, call_at desc);

alter table agent_call_evals enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'agent_call_evals'
                 and policyname = 'auth read agent_call_evals') then
    create policy "auth read agent_call_evals" on agent_call_evals for select to authenticated using (true);
  end if;
end $$;
revoke all on table agent_call_evals from anon;
revoke insert, update, delete, truncate, references, trigger on table agent_call_evals from authenticated;
grant select on table agent_call_evals to authenticated;

-- ── 2) The agent scorer's Gemini batch jobs (service role only) ──
create table if not exists agent_eval_jobs (
  id             uuid primary key default gen_random_uuid(),
  job_name       text not null unique,
  model          text not null,
  prompt_version text not null,
  status         text not null default 'submitted',   -- submitted | processing | completed | failed | expired | cancelled
  call_ids       jsonb not null,
  call_count     int,
  input_tokens   bigint,
  output_tokens  bigint,
  error          text,
  submitted_at   timestamptz not null default now(),
  completed_at   timestamptz
);
create index if not exists agent_eval_jobs_open_idx on agent_eval_jobs (submitted_at) where status in ('submitted', 'processing');
alter table agent_eval_jobs enable row level security;
revoke all on table agent_eval_jobs from anon, authenticated;

-- ── 3) Reviewer calibration: "the AI assessment of this call is wrong" ──
alter table call_reviews add column if not exists eval_disagree boolean;

-- ── 4) Scorer queue: ASCND calls with an agent transcript and no eval yet, newest first so
--    live calls are never starved by a backfill ──
create or replace function agent_eval_pending(since_ts timestamptz, max_rows int default 1000)
returns table (id text, ivr_name text, created_at timestamptz, result text, disposition text,
               disposition_description text, intent text, vertical_name text, ivr_duration int,
               ascnd_transcript text)
language sql stable set search_path = public as $$
  select c.id, c.ivr_name, c.created_at, c.result, c.disposition, c.disposition_description,
         c.intent, c.vertical_name, c.ivr_duration, c.ascnd_transcript
  from canoe_calls c
  where c.created_at >= since_ts
    and c.ascnd_transcript is not null and c.ascnd_transcript <> ''
    and c.ivr_name ilike 'ascnd%'
    and c.is_test is not true
    and not exists (select 1 from agent_call_evals e where e.call_id = c.id)
  order by c.created_at desc
  limit max_rows;
$$;
revoke execute on function agent_eval_pending(timestamptz, int) from public, anon, authenticated;
grant execute on function agent_eval_pending(timestamptz, int) to service_role;

-- ── 5) Per-IVR rollup over a window (raw ivr_name; the page sums aliases into their agent) ──
create or replace function agent_eval_metrics(since_ts timestamptz, until_ts timestamptz default now())
returns table (ivr_name text, scored bigint, conversations bigint, good bigint, minor bigint, major bigint,
               unclear bigint, no_conversation bigint, over_transfer bigint, over_reject bigint,
               drop_intro bigint, drop_mid bigint, drop_transfer bigint, mishears bigint, pauses bigint,
               stuck bigint, too_long bigint, late_dq bigint, missing_question bigint,
               intent_mismatch bigint, disagree bigint)
language sql stable set search_path = public as $$
  select e.ivr_name,
    count(*),
    count(*) filter (where e.verdict <> 'no_conversation'),
    count(*) filter (where e.verdict = 'good'),
    count(*) filter (where e.verdict = 'minor'),
    count(*) filter (where e.verdict = 'major'),
    count(*) filter (where e.verdict = 'unclear'),
    count(*) filter (where e.verdict = 'no_conversation'),
    count(*) filter (where e.decision_verdict = 'over_transfer'),
    count(*) filter (where e.decision_verdict = 'over_reject'),
    count(*) filter (where e.verdict = 'no_conversation' or e.dropoff_stage = 'intro'),
    count(*) filter (where e.dropoff_stage = 'mid_qualification'),
    count(*) filter (where e.dropoff_stage = 'at_transfer'),
    count(*) filter (where e.understanding = 'mishears'),
    count(*) filter (where e.understanding = 'pauses'),
    count(*) filter (where e.understanding = 'stuck'),
    count(*) filter (where e.script = 'too_long'),
    count(*) filter (where e.script = 'late_dq'),
    count(*) filter (where e.script = 'missing_question'),
    count(*) filter (where e.eval->>'intent_match' = 'mismatch'),
    count(*) filter (where exists (select 1 from call_reviews r where r.call_id = e.call_id and r.eval_disagree))
  from agent_call_evals e
  where e.call_at >= since_ts and e.call_at < until_ts
  group by e.ivr_name;
$$;
revoke execute on function agent_eval_metrics(timestamptz, timestamptz) from public, anon;
grant execute on function agent_eval_metrics(timestamptz, timestamptz) to authenticated, service_role;
