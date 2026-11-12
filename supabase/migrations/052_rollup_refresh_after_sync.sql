-- ============================================================
-- 052_rollup_refresh_after_sync.sql
-- The Agents, Scores and Review numbers come from three daily rollups (030/044-045/041).
-- Two bugs made them wrong every day:
--
-- A) They refreshed at 01:00-01:30 UTC, but the "00:00" GitHub sync lands at 02:40-04:50 UTC
--    (cron delay), so yesterday was ~90% missing until the next night (Nov 11: 28 of 539 calls).
-- B) Each refresh deleted from a DATE (now() - N days)::date but re-inserted from a TIMESTAMP
--    now() - N days, so the boundary day lost its first ~hour, and once it aged out of the
--    window that loss was permanent: 3,086 calls / $21,985 missing from agent_metrics_daily,
--    1,166 calls from agent_counterparty_daily (as of 2026-11-12).
--
-- Fix:
-- 1) One cutoff for both statements: midnight UTC, days_back days ago. An advisory lock lets
--    two refreshes of the same rollup (queue + nightly) run one after the other instead of
--    colliding on the primary key.
-- 2) Refresh on demand. sync.js (after Pass 1) and the Gemini ingest (after each job) call
--    request_rollup_refresh(from_ts, rollups), which only queues the oldest changed day. A
--    pg_cron job drains the queue every 10 minutes. The refresh itself cannot run over the API:
--    it takes 20-90s and every PostgREST call runs under the authenticator's 8s statement_timeout.
-- 3) The nightly full-window refreshes stay as a safety net, moved after the sync lands
--    (06:45 / 06:55 / 07:05 UTC; 051's insights rollup runs at 07:30).
-- 4) sync_state: the sync's high-water mark, so a failed or skipped run is caught up next run.
--
-- New tables are service-role only (RLS on, no policies, no anon/authenticated grants); the
-- new functions are not executable by anon/authenticated. Existing grants are unchanged.
-- After applying, run 053 once to rebuild the rows bug B already lost.
-- Rollback: supabase/rollbacks/052_rollup_refresh_after_sync_down.sql
-- Test:     supabase/tests/052_rollup_refresh_after_sync_test.sql
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

-- ── 1) Refresh functions: one UTC-midnight cutoff, one refresh per rollup at a time ──

create or replace function refresh_agent_metrics_daily(days_back int default 45)
returns void language plpgsql security definer as $$
declare
  v_cut date := (now() at time zone 'UTC')::date - days_back;
begin
  perform pg_advisory_xact_lock(hashtext('refresh_agent_metrics_daily'));
  delete from agent_metrics_daily where day >= v_cut;
  insert into agent_metrics_daily (ivr_name, day, raw, sent, paid, revenue, payout)
  select ivr_name, (created_at at time zone 'UTC')::date,
    count(*)::bigint,
    count(*) filter (where coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0)::bigint,
    count(*) filter (where coalesce(advertiser_payin,0) > 0)::bigint,
    coalesce(sum(advertiser_payin),0)::numeric,
    coalesce(sum(publisher_payout),0)::numeric
  from canoe_calls
  where is_test is not true and ivr_name is not null
    and created_at >= v_cut::timestamp at time zone 'UTC'
  group by 1, 2;
end;
$$;
grant execute on function refresh_agent_metrics_daily(int) to service_role;

create or replace function refresh_agent_counterparty_daily(days_back int default 45)
returns void language plpgsql security definer as $$
declare
  v_cut date := (now() at time zone 'UTC')::date - days_back;
begin
  perform pg_advisory_xact_lock(hashtext('refresh_agent_counterparty_daily'));
  delete from agent_counterparty_daily where day >= v_cut;
  insert into agent_counterparty_daily (ivr_name, day, side, counterparty, calls, sent, paid, revenue)
  with base as materialized (
    select ivr_name, (created_at at time zone 'UTC')::date as day, publisher_name, advertiser_name,
      (coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0) as is_sent,
      (coalesce(advertiser_payin,0) > 0) as is_paid,
      coalesce(advertiser_payin,0) as payin
    from canoe_calls
    where is_test is not true and ivr_name is not null
      and created_at >= v_cut::timestamp at time zone 'UTC'
  )
  select ivr_name, day, 'publisher', coalesce(publisher_name,'(unknown)'),
         count(*)::bigint, count(*) filter (where is_sent)::bigint, count(*) filter (where is_paid)::bigint, coalesce(sum(payin),0)::numeric
    from base group by 1, 2, 4
  union all
  select ivr_name, day, 'advertiser', coalesce(advertiser_name,'(unknown)'),
         count(*)::bigint, count(*) filter (where is_sent)::bigint, count(*) filter (where is_paid)::bigint, coalesce(sum(payin),0)::numeric
    from base group by 1, 2, 4;
end;
$$;
-- CREATE OR REPLACE resets per-function settings, so re-apply the timeout from 044/045.
alter function refresh_agent_counterparty_daily(int) set statement_timeout = '5min';
grant execute on function refresh_agent_counterparty_daily(int) to service_role;

create or replace function refresh_outcome_score_daily(days_back int default 120)
returns void language plpgsql security definer as $$
declare
  v_cut date := (now() at time zone 'UTC')::date - days_back;
begin
  perform pg_advisory_xact_lock(hashtext('refresh_outcome_score_daily'));
  delete from outcome_score_daily where day >= v_cut;
  insert into outcome_score_daily (entity_type, entity_name, vertical, source, outcome, day, n)
  with base as (
    select
      publisher_name,
      advertiser_name,
      coalesce(nullif(vertical_name, ''), '(unknown)') as vertical,
      canoe_outcome,
      our_outcome,
      (created_at at time zone 'UTC')::date as day
    from canoe_calls
    where is_test is not true
      and canoe_outcome is not null
      and our_outcome   is not null
      and created_at >= v_cut::timestamp at time zone 'UTC'
  ),
  unpivoted as (
    select 'publisher'::text as entity_type, publisher_name as entity_name, vertical, 'canoe'::text as source, canoe_outcome as outcome, day
      from base where publisher_name is not null and publisher_name <> ''
    union all
    select 'publisher', publisher_name, vertical, 'ours', our_outcome, day
      from base where publisher_name is not null and publisher_name <> ''
    union all
    select 'advertiser', advertiser_name, vertical, 'canoe', canoe_outcome, day
      from base where advertiser_name is not null and advertiser_name <> ''
    union all
    select 'advertiser', advertiser_name, vertical, 'ours', our_outcome, day
      from base where advertiser_name is not null and advertiser_name <> ''
  )
  select entity_type, entity_name, vertical, source, outcome, day, count(*)::bigint
  from unpivoted
  group by entity_type, entity_name, vertical, source, outcome, day;
end;
$$;
grant execute on function refresh_outcome_score_daily(int) to service_role;

-- ── 2) On-demand refresh queue ──

-- One row per request: the rollup and the oldest UTC day whose calls changed. Append-only, so a
-- request never waits on a refresh that is running.
create table if not exists rollup_refresh_requests (
  id           bigint generated always as identity primary key,
  rollup       text not null check (rollup in ('agent_metrics', 'agent_counterparty', 'outcome_score')),
  from_day     date not null,
  requested_at timestamptz not null default now()
);
alter table rollup_refresh_requests enable row level security;
revoke all on table rollup_refresh_requests from anon, authenticated;

-- Called by sync.js / process.js with the service key. A plain insert: well inside the API's 8s.
create or replace function request_rollup_refresh(from_ts timestamptz, rollups text[])
returns void language sql security definer set search_path = public as $$
  insert into rollup_refresh_requests (rollup, from_day)
  select r, (from_ts at time zone 'UTC')::date from unnest(rollups) as r;
$$;
revoke execute on function request_rollup_refresh(timestamptz, text[]) from public, anon, authenticated;
grant execute on function request_rollup_refresh(timestamptz, text[]) to service_role;

-- Drain one rollup's requests: delete the ones this transaction can see and rebuild from the
-- oldest requested day. All in one transaction, so a failed refresh rolls the delete back and
-- the next tick retries; a request committed after the delete started stays for the next tick.
-- Returns the days_back it refreshed, or null when nothing was queued.
create or replace function run_rollup_refresh(p_rollup text)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_from date;
  v_days int;
begin
  with claimed as (
    delete from rollup_refresh_requests where rollup = p_rollup returning from_day
  )
  select min(from_day) into v_from from claimed;
  if v_from is null then return null; end if;

  v_days := greatest((now() at time zone 'UTC')::date - v_from, 0);
  if    p_rollup = 'agent_metrics'      then perform refresh_agent_metrics_daily(v_days);
  elsif p_rollup = 'agent_counterparty' then perform refresh_agent_counterparty_daily(v_days);
  elsif p_rollup = 'outcome_score'      then perform refresh_outcome_score_daily(v_days);
  else raise exception 'unknown rollup %', p_rollup;
  end if;
  return v_days;
end;
$$;
revoke execute on function run_rollup_refresh(text) from public, anon, authenticated;

-- The pg_cron entry point. Each rollup runs in its own subtransaction, so one failing refresh
-- keeps its requests queued (and is logged) without blocking the other two.
create or replace function run_rollup_refresh_queue()
returns void language plpgsql security definer set search_path = public as $$
declare
  r text;
begin
  foreach r in array array['agent_metrics', 'agent_counterparty', 'outcome_score'] loop
    begin
      perform run_rollup_refresh(r);
    exception when others then
      raise warning 'rollup refresh % failed, left queued: %', r, sqlerrm;
    end;
  end loop;
end;
$$;
revoke execute on function run_rollup_refresh_queue() from public, anon, authenticated;

-- ── 3) Schedules (cron.schedule upserts by job name, so re-running is safe) ──
create extension if not exists pg_cron;
select cron.schedule('refresh-rollup-queue', '*/10 * * * *', $$select public.run_rollup_refresh_queue()$$);
-- Nightly full-window safety net, after the sync has landed.
select cron.schedule('refresh-agent-rollup',              '45 6 * * *', $$select public.refresh_agent_metrics_daily(45)$$);
select cron.schedule('refresh-agent-counterparty-rollup', '55 6 * * *', $$select public.refresh_agent_counterparty_daily(45)$$);
select cron.schedule('refresh-outcome-score-rollup',      '5 7 * * *',  $$select public.refresh_outcome_score_daily(120)$$);

-- ── 4) Sync high-water mark (read/written by sync.js with the service key) ──
create table if not exists sync_state (
  name           text primary key,          -- 'canoe_pass1'
  synced_through timestamptz not null,      -- end of the last fully successful Pass 1 window
  updated_at     timestamptz not null default now()
);
alter table sync_state enable row level security;
revoke all on table sync_state from anon, authenticated;
