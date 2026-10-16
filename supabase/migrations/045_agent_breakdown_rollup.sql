-- ============================================================
-- 045_agent_breakdown_rollup.sql
-- Agents-tab drawer ("Publishers sending traffic" / "Advertisers buying calls") called
-- agent_breakdown() (022) on every open, which scans raw canoe_calls — ~0.4-0.75s warm
-- for the bigger agents and seconds on a cold cache (wide table, heap fetches).
-- Same fix as 030/041/044: read a daily rollup instead.
--
-- 1) agent_counterparty_daily (044) gains sent / paid / revenue, so it carries everything
--    the drawer shows. Same is_sent / is_paid definitions as agent_breakdown (022).
-- 2) Backfill full history (data starts 2026-05-31) so any date range the Agents tab can
--    pick (7/30/90d or custom) is covered; the nightly cron keeps refreshing 45 days.
-- 3) agent_breakdown_all(from_ts, to_ts): every agent's breakdown in ONE call, so the
--    frontend can prefetch it with the card metrics and open drawers with no request.
--    Day-grained (UTC) like agent_metrics (030), so drawer totals match the cards.
-- agent_breakdown (022) is left in place, unused by the frontend.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

alter table agent_counterparty_daily
  add column if not exists sent    bigint  not null default 0,
  add column if not exists paid    bigint  not null default 0,
  add column if not exists revenue numeric not null default 0;

create or replace function refresh_agent_counterparty_daily(days_back int default 45)
returns void language plpgsql security definer as $$
begin
  delete from agent_counterparty_daily where day >= (now() - make_interval(days => days_back))::date;
  insert into agent_counterparty_daily (ivr_name, day, side, counterparty, calls, sent, paid, revenue)
  with base as materialized (
    select ivr_name, (created_at at time zone 'UTC')::date as day, publisher_name, advertiser_name,
      (coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0) as is_sent,
      (coalesce(advertiser_payin,0) > 0) as is_paid,
      coalesce(advertiser_payin,0) as payin
    from canoe_calls
    where is_test is not true and ivr_name is not null
      and created_at >= (now() - make_interval(days => days_back))
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
-- CREATE OR REPLACE resets per-function settings, so re-apply the timeout from 044.
alter function refresh_agent_counterparty_daily(int) set statement_timeout = '5min';
grant execute on function refresh_agent_counterparty_daily(int) to service_role;

-- Full-history populate (idempotent: deletes + reinserts its window).
select refresh_agent_counterparty_daily(4000);

create or replace function agent_breakdown_all(from_ts timestamptz, to_ts timestamptz)
returns table (ivr_name text, side text, counterparty text, raw bigint, sent bigint, paid bigint, revenue numeric)
language sql security definer stable as $$
  select ivr_name, side, counterparty,
    coalesce(sum(calls),0)::bigint, coalesce(sum(sent),0)::bigint,
    coalesce(sum(paid),0)::bigint,  coalesce(sum(revenue),0)::numeric
  from agent_counterparty_daily
  where day >= (from_ts at time zone 'UTC')::date
    and day <  (to_ts   at time zone 'UTC')::date
  group by 1, 2, 3;
$$;
grant execute on function agent_breakdown_all(timestamptz, timestamptz) to authenticated;
