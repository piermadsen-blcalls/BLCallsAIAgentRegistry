-- ============================================================
-- 030_agent_metrics_rollup.sql
-- The Agents tab re-aggregated ~30 days of raw canoe_calls (~90k rows) on every
-- load via agent_metrics() — seconds-level, and worse under heavy write load (stale
-- visibility map → heap fetches). Fix: a pre-aggregated per-agent-per-day rollup the
-- tab reads instead of scanning raw calls. ~135 agents x N days = a few thousand tiny
-- rows → sub-100ms, and load time no longer depends on raw volume or write activity.
--
-- The rollup uses ONLY raw call fields (no AI outcomes), so it's independent of the
-- AI-processing/backfill pipeline.
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

create table if not exists agent_metrics_daily (
  ivr_name text    not null,
  day      date    not null,
  raw      bigint  not null default 0,
  sent     bigint  not null default 0,
  paid     bigint  not null default 0,
  revenue  numeric not null default 0,
  payout   numeric not null default 0,
  primary key (ivr_name, day)
);
create index if not exists agent_metrics_daily_day_idx on agent_metrics_daily (day);

alter table agent_metrics_daily enable row level security;
create policy "auth users can read agent_metrics_daily"
  on agent_metrics_daily for select to authenticated using (true);

-- Recompute the rollup for a trailing window (default 45 days). Recent days can still
-- change as the sync patches duration/result/payin on recently-landed calls, so we
-- re-aggregate a window rather than only "today". Days older than the window are frozen.
create or replace function refresh_agent_metrics_daily(days_back int default 45)
returns void language plpgsql security definer as $$
begin
  delete from agent_metrics_daily where day >= (now() - make_interval(days => days_back))::date;
  insert into agent_metrics_daily (ivr_name, day, raw, sent, paid, revenue, payout)
  select ivr_name, (created_at at time zone 'UTC')::date,
    count(*)::bigint,
    count(*) filter (where coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0)::bigint,
    count(*) filter (where coalesce(advertiser_payin,0) > 0)::bigint,
    coalesce(sum(advertiser_payin),0)::numeric,
    coalesce(sum(publisher_payout),0)::numeric
  from canoe_calls
  where is_test is not true and ivr_name is not null
    and created_at >= (now() - make_interval(days => days_back))
  group by 1, 2;
end;
$$;
grant execute on function refresh_agent_metrics_daily(int) to service_role;

-- Full-history populate (idempotent: the function deletes + reinserts its window).
select refresh_agent_metrics_daily(4000);

-- Cutover: agent_metrics now sums the rollup instead of scanning raw calls. Day-grained
-- (matches the daily "data current through" cadence); boundary calls may shift by the
-- UTC-vs-local offset, negligible for 7/30/90-day totals.
create or replace function agent_metrics(from_ts timestamptz, to_ts timestamptz)
returns table (ivr_name text, raw bigint, sent bigint, paid bigint, revenue numeric, payout numeric)
language sql security definer stable as $$
  select ivr_name,
    coalesce(sum(raw),0)::bigint,
    coalesce(sum(sent),0)::bigint,
    coalesce(sum(paid),0)::bigint,
    coalesce(sum(revenue),0)::numeric,
    coalesce(sum(payout),0)::numeric
  from agent_metrics_daily
  where day >= (from_ts at time zone 'UTC')::date
    and day <  (to_ts   at time zone 'UTC')::date
  group by ivr_name;
$$;
grant execute on function agent_metrics(timestamptz, timestamptz) to authenticated;

-- Keep the rollup fresh daily at 01:00 UTC (after the 00:00 sync) via pg_cron.
-- cron.schedule upserts by job name, so re-running is safe.
create extension if not exists pg_cron;
select cron.schedule('refresh-agent-rollup', '0 1 * * *', $$select public.refresh_agent_metrics_daily(45)$$);
