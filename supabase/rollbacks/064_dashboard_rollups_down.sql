-- ============================================================
-- Rollback for 064_dashboard_rollups.sql. Removes the cron job, the dashboard functions and both
-- rollup tables, and puts 052's refresh queue back as it was (queued 'dashboard' requests are
-- dropped). Revert the scripts/process.js change with it or first: until then the ingest's
-- 'dashboard' refresh request fails on the queue's check and only logs a warning.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

select cron.unschedule('refresh-dashboard-rollup')
where exists (select 1 from cron.job where jobname = 'refresh-dashboard-rollup');

delete from rollup_refresh_requests where rollup = 'dashboard';
alter table rollup_refresh_requests drop constraint if exists rollup_refresh_requests_rollup_check;
alter table rollup_refresh_requests add constraint rollup_refresh_requests_rollup_check
  check (rollup in ('agent_metrics', 'agent_counterparty', 'outcome_score'));

-- As in 052.
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

drop function if exists dashboard_cpa(date, date, text[], text[], text[], boolean);
drop function if exists dashboard_trend(date, date, text[], text[], text[], text[]);
drop function if exists dashboard_quality(date, date, text[], text[], text[]);
drop function if exists dashboard_outcomes(date, date, text[], text[], text[]);
drop function if exists dashboard_summary(date, date, text[], text[], text[]);
drop function if exists dashboard_caller_rows(date, date, text[], text[], text[]);
drop function if exists dashboard_outcome_rows(date, date, text[], text[], text[]);
drop function if exists refresh_dashboard_daily(int);
drop function if exists dashboard_rate(numeric, numeric);
drop function if exists dashboard_caller_key(text);
drop function if exists dashboard_conversion_outcomes();
drop function if exists dashboard_qualified_outcomes();
drop table if exists caller_daily;
drop table if exists outcome_daily;
