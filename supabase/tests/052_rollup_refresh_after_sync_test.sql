-- ============================================================
-- Regression test for 052_rollup_refresh_after_sync.sql.
-- Run in the Supabase SQL Editor after 052. Everything up to ROLLBACK runs in one transaction
-- that is rolled back, so it leaves no rows behind; raises on failure. Fixture ids start with
-- 'zztest-' and the IVR/publisher names with 'ZZTEST' so they can't collide with real data.
-- The last query (after 053) is read-only.
-- ============================================================
begin;

-- Fixtures: calls in the first seconds of a UTC day (the ones the old refresh dropped).
insert into canoe_calls (id, ivr_name, publisher_name, advertiser_name, vertical_name, canoe_outcome, our_outcome, advertiser_payin, created_at) values
  ('zztest-r1', 'ZZTEST IVR', 'ZZTEST Pub', 'ZZTEST Adv', 'ZZTEST V', 'sale', 'sale', 10,
     ((now() at time zone 'UTC')::date - 2)::timestamp at time zone 'UTC' + interval '1 second'),
  ('zztest-r2', 'ZZTEST IVR', 'ZZTEST Pub', 'ZZTEST Adv', 'ZZTEST V', 'sale', 'voicemail', 0,
     ((now() at time zone 'UTC')::date - 2)::timestamp at time zone 'UTC' + interval '12 hours');

-- 1) Boundary day: a refresh of N days keeps all of day today-N, including its first second.
select refresh_agent_metrics_daily(2);
select refresh_agent_counterparty_daily(2);
select refresh_outcome_score_daily(2);
do $$
declare d date := (now() at time zone 'UTC')::date - 2;
begin
  assert (select raw from agent_metrics_daily where ivr_name = 'ZZTEST IVR' and day = d) = 2,
    'agent_metrics_daily lost the boundary day''s first call';
  assert (select revenue from agent_metrics_daily where ivr_name = 'ZZTEST IVR' and day = d) = 10, 'revenue';
  assert (select calls from agent_counterparty_daily where ivr_name = 'ZZTEST IVR' and day = d and side = 'publisher') = 2,
    'agent_counterparty_daily lost the boundary day''s first call';
  assert (select sum(n) from outcome_score_daily where entity_name = 'ZZTEST Pub' and entity_type = 'publisher' and day = d) = 4,
    'outcome_score_daily lost the boundary day''s first call (2 calls x canoe+ours)';
  -- Real data: every refreshed day now matches canoe_calls exactly.
  assert not exists (
    with raw as (select (created_at at time zone 'UTC')::date as day, count(*) as n from canoe_calls
                 where is_test is not true and ivr_name is not null and created_at >= d::timestamp at time zone 'UTC' group by 1),
         roll as (select day, sum(raw) as n from agent_metrics_daily where day >= d group by 1)
    select 1 from raw full join roll using (day) where raw.n is distinct from roll.n
  ), 'agent_metrics_daily differs from canoe_calls on a refreshed day';
end $$;

-- 2) Queue: requests are drained by run_rollup_refresh_queue(), from the oldest requested day.
insert into canoe_calls (id, ivr_name, publisher_name, advertiser_name, created_at) values
  ('zztest-r3', 'ZZTEST IVR', 'ZZTEST Pub', 'ZZTEST Adv', ((now() at time zone 'UTC')::date - 1)::timestamp at time zone 'UTC' + interval '30 seconds');
select request_rollup_refresh(now() - interval '1 day', array['agent_metrics', 'agent_counterparty']);
select request_rollup_refresh(now(), array['agent_metrics']);
do $$
declare d date := (now() at time zone 'UTC')::date - 1;
begin
  assert (select count(*) from rollup_refresh_requests where from_day >= d - 1) >= 3, 'requests queued';
  perform run_rollup_refresh_queue();
  assert not exists (select 1 from rollup_refresh_requests where rollup in ('agent_metrics', 'agent_counterparty')), 'queue drained';
  assert (select raw from agent_metrics_daily where ivr_name = 'ZZTEST IVR' and day = d) = 1, 'queued refresh covered the oldest requested day';
  assert (select calls from agent_counterparty_daily where ivr_name = 'ZZTEST IVR' and day = d and side = 'advertiser') = 1, 'counterparty refreshed';
  assert run_rollup_refresh('agent_metrics') is null, 'empty queue is a no-op';
end $$;

-- 3) Schedules, and the new objects stay out of anon/authenticated reach.
do $$ begin
  assert (select schedule from cron.job where jobname = 'refresh-rollup-queue') = '*/10 * * * *', 'queue job';
  assert (select schedule from cron.job where jobname = 'refresh-agent-rollup') = '45 6 * * *', 'agent safety net';
  assert (select schedule from cron.job where jobname = 'refresh-agent-counterparty-rollup') = '55 6 * * *', 'counterparty safety net';
  assert (select schedule from cron.job where jobname = 'refresh-outcome-score-rollup') = '5 7 * * *', 'score safety net';
  assert has_function_privilege('service_role', 'request_rollup_refresh(timestamptz, text[])', 'execute'), 'service_role can request';
  assert not has_function_privilege('anon', 'request_rollup_refresh(timestamptz, text[])', 'execute'), 'anon cannot request';
  assert not has_function_privilege('authenticated', 'request_rollup_refresh(timestamptz, text[])', 'execute'), 'authenticated cannot request';
  assert not has_function_privilege('anon', 'run_rollup_refresh_queue()', 'execute'), 'anon cannot run the queue';
  assert not has_table_privilege('anon', 'sync_state', 'select,insert,update,delete,truncate'), 'sync_state closed to anon';
  assert not has_table_privilege('authenticated', 'rollup_refresh_requests', 'select,insert,update,delete,truncate'), 'queue closed to authenticated';
end $$;

rollback;

-- After 053 (read-only, slow: scans canoe_calls): days where a rollup still differs from the raw
-- table. Expect no rows except today and yesterday if a sync landed after the last refresh.
with raw as (select (created_at at time zone 'UTC')::date as day, count(*) as n from canoe_calls
             where is_test is not true and ivr_name is not null group by 1),
     am  as (select day, sum(raw) as n from agent_metrics_daily group by 1),
     acp as (select day, sum(calls) as n from agent_counterparty_daily where side = 'publisher' group by 1)
select day, raw.n as raw_calls, am.n as agent_metrics, acp.n as counterparty
from raw full join am using (day) full join acp using (day)
where raw.n is distinct from am.n or raw.n is distinct from acp.n
order by day;
