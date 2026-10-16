-- ============================================================
-- 044_agent_counterparties_and_objective.sql
-- MK-183: Review-board filters by Account Manager (advertisers) or Supply Manager
-- (publishers), plus a per-agent IVR objective.
--
-- 1) agent_counterparty_daily — which advertisers / publishers each IVR touched, per
--    day. The Review board needs ivr → counterparty for ALL agents over 30 days; the raw
--    group-by on canoe_calls took ~11.3s on prod (55k heap fetches, same stale-visibility
--    problem as 030/041), over the 8s API cap. Same fix: a small daily rollup refreshed by
--    pg_cron, and an RPC that sums it.
-- 2) agents.objective — free text, what the IVR is trying to achieve. Written with a
--    plain PATCH; agents already has an authenticated update policy (002).
--
-- Notes reuse agent_updates (038) — no schema change needed for them.
-- Run in Supabase SQL Editor (or supabase db query --linked).
-- ============================================================

-- ── 1) ivr → counterparty rollup ──
create table if not exists agent_counterparty_daily (
  ivr_name     text   not null,   -- raw ivr_name; the frontend resolves aliases
  day          date   not null,
  side         text   not null,   -- 'publisher' | 'advertiser'
  counterparty text   not null,   -- '(unknown)' when the name is null
  calls        bigint not null default 0,
  primary key (ivr_name, day, side, counterparty)
);
create index if not exists agent_counterparty_daily_day_idx on agent_counterparty_daily (day);

alter table agent_counterparty_daily enable row level security;
create policy "auth users can read agent_counterparty_daily"
  on agent_counterparty_daily for select to authenticated using (true);

-- Recompute a trailing window (recent days still change as the sync patches calls).
-- Same filters as agent_breakdown (022) so the drawer and the board agree.
create or replace function refresh_agent_counterparty_daily(days_back int default 45)
returns void language plpgsql security definer as $$
begin
  delete from agent_counterparty_daily where day >= (now() - make_interval(days => days_back))::date;
  insert into agent_counterparty_daily (ivr_name, day, side, counterparty, calls)
  with base as materialized (
    select ivr_name, (created_at at time zone 'UTC')::date as day, publisher_name, advertiser_name
    from canoe_calls
    where is_test is not true and ivr_name is not null
      and created_at >= (now() - make_interval(days => days_back))
  )
  select ivr_name, day, 'publisher', coalesce(publisher_name,'(unknown)'), count(*)::bigint
    from base group by 1, 2, 4
  union all
  select ivr_name, day, 'advertiser', coalesce(advertiser_name,'(unknown)'), count(*)::bigint
    from base group by 1, 2, 4;
end;
$$;
alter function refresh_agent_counterparty_daily(int) set statement_timeout = '5min';
grant execute on function refresh_agent_counterparty_daily(int) to service_role;

-- Initial populate (idempotent: deletes + reinserts its window).
select refresh_agent_counterparty_daily(45);

-- Board read: per (ivr, side, counterparty) call totals since since_ts. Day-grained,
-- like agent_metrics (030).
create or replace function agent_counterparties(since_ts timestamptz)
returns table (ivr_name text, side text, counterparty text, calls bigint)
language sql security definer stable as $$
  select ivr_name, side, counterparty, coalesce(sum(calls),0)::bigint
  from agent_counterparty_daily
  where day >= (since_ts at time zone 'UTC')::date
  group by 1, 2, 3;
$$;
grant execute on function agent_counterparties(timestamptz) to authenticated;

-- Daily at 01:15 UTC: after the 00:00 sync, between the 01:00 agent and 01:30 score
-- rollups. cron.schedule upserts by job name, so re-running is safe.
create extension if not exists pg_cron;
select cron.schedule('refresh-agent-counterparty-rollup', '15 1 * * *', $$select public.refresh_agent_counterparty_daily(45)$$);

-- ── 2) IVR objective ──
alter table agents add column if not exists objective text;
