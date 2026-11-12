-- ============================================================
-- 051_insights_rollup.sql
-- Insights (period A vs period B) pulled every raw canoe_calls row of both periods into the
-- browser and summed them there. PR #12 cut that to one UTC day per request, but a
-- month-vs-month run still touches every heap page of ~200k wide rows. On this 1 GB instance
-- the first page of a cold day costs ~1-1.6s alone and 2-8.7s with the run's 6 requests in
-- flight, so some cross the 8s signed-in statement_timeout (57014) and the whole run fails.
-- Aggregating live in the database is no better: one month took 17.8s (39k heap fetches,
-- stale visibility map). Same fix as 030/041/045: a per-day rollup the RPC sums instead.
--
-- 1) insights_daily: one row per (UTC day, vertical, agent, publisher, advertiser) with the
--    counts and money Insights shows. Same keys the page used: a null/empty name is
--    '(unknown)'; a null vertical is '' (matches no vertical filter, like before).
-- 2) refresh_insights_daily(days_back): rebuilds the trailing window, but only settled days.
--    Each sync re-upserts the last 2 UTC days and runs ~03:00-05:00 UTC, so a day is final
--    once it is older than yesterday.
-- 3) insights_period(from_day, to_day, verticals): grouped totals for a period, one row per
--    (agent, publisher, advertiser), as one jsonb array so PostgREST max-rows can't cut it.
--    Days after the rollup's newest day (normally yesterday and today) are read live from
--    canoe_calls, so results are as fresh as the raw table.
-- 4) pg_cron 'refresh-insights-rollup' daily at 07:30 UTC, clear of sync and the 06:00 ingest.
-- Rollback: supabase/rollbacks/051_insights_rollup_down.sql.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

create table if not exists insights_daily (
  day             date    not null,
  vertical        text    not null,
  ivr_name        text    not null,
  publisher_name  text    not null,
  advertiser_name text    not null,
  raw             bigint  not null default 0,
  sent            bigint  not null default 0,
  paid            bigint  not null default 0,
  revenue         numeric not null default 0,
  payout          numeric not null default 0,
  primary key (day, vertical, ivr_name, publisher_name, advertiser_name)
);

alter table insights_daily enable row level security;
create policy "auth users can read insights_daily"
  on insights_daily for select to authenticated using (true);

create or replace function refresh_insights_daily(days_back int default 45)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  today date := (now() at time zone 'UTC')::date;
begin
  delete from insights_daily where day >= today - days_back;
  insert into insights_daily (day, vertical, ivr_name, publisher_name, advertiser_name, raw, sent, paid, revenue, payout)
  select (created_at at time zone 'UTC')::date,
    coalesce(vertical_name, ''),
    coalesce(nullif(ivr_name, ''), '(unknown)'),
    coalesce(nullif(publisher_name, ''), '(unknown)'),
    coalesce(nullif(advertiser_name, ''), '(unknown)'),
    count(*),
    count(*) filter (where coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0),
    count(*) filter (where coalesce(advertiser_payin,0) > 0),
    coalesce(sum(advertiser_payin),0),
    coalesce(sum(publisher_payout),0)
  from canoe_calls
  where is_test is not true
    and created_at >= (today - days_back)::timestamp at time zone 'UTC'
    and created_at <  (today - 1)::timestamp at time zone 'UTC'   -- settled days only
  group by 1, 2, 3, 4, 5;
end;
$$;
revoke execute on function refresh_insights_daily(int) from public, anon, authenticated;
grant execute on function refresh_insights_daily(int) to service_role;

-- Full-history populate (idempotent: deletes + reinserts its window).
select refresh_insights_daily(4000);

-- to_day is inclusive, like the page's period picker. verticals null = all verticals.
create or replace function insights_period(from_day date, to_day date, verticals text[] default null)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with w as (
    select coalesce((select max(day) + 1 from insights_daily), from_day) as live_from
  ), r as (
    select d.ivr_name, d.publisher_name, d.advertiser_name, d.raw, d.sent, d.paid, d.revenue, d.payout
    from insights_daily d, w
    where d.day >= from_day and d.day <= to_day and d.day < w.live_from
      and (verticals is null or d.vertical = any(verticals))
    union all
    select coalesce(nullif(c.ivr_name, ''), '(unknown)'),
      coalesce(nullif(c.publisher_name, ''), '(unknown)'),
      coalesce(nullif(c.advertiser_name, ''), '(unknown)'),
      1,
      (coalesce(c.connect_duration,0) > 0 or position('connected' in lower(coalesce(c.result,''))) > 0)::int,
      (coalesce(c.advertiser_payin,0) > 0)::int,
      coalesce(c.advertiser_payin,0),
      coalesce(c.publisher_payout,0)
    from canoe_calls c, w
    where c.is_test is not true
      and c.created_at >= greatest(from_day, w.live_from)::timestamp at time zone 'UTC'
      and c.created_at <  (to_day + 1)::timestamp at time zone 'UTC'
      and (verticals is null or c.vertical_name = any(verticals))
  )
  select coalesce(jsonb_agg(g), '[]'::jsonb)
  from (
    select ivr_name, publisher_name, advertiser_name,
      sum(raw)::bigint as raw, sum(sent)::bigint as sent, sum(paid)::bigint as paid,
      sum(revenue) as revenue, sum(payout) as payout
    from r
    group by 1, 2, 3
  ) g;
$$;
revoke execute on function insights_period(date, date, text[]) from public, anon;
grant execute on function insights_period(date, date, text[]) to authenticated;

-- Keep the rollup fresh daily via pg_cron. cron.schedule upserts by job name, so re-running is safe.
select cron.schedule('refresh-insights-rollup', '30 7 * * *', $$select public.refresh_insights_daily(45)$$);
