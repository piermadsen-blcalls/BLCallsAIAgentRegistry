-- ============================================================
-- Rollback for 065_dashboard_mountain_days_and_flags.sql. Puts the 064 dashboard functions back
-- (UTC days; dashboard_summary reads insights_daily), drops flag_daily, its functions,
-- dashboard_tz() and outcome_daily.payout, and rebuilds the two rollups on UTC days inline
-- (about 30 s; dashboard reads wait for it). Revert the page (the combined Calls page) with it.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

drop function if exists dashboard_flag_trend(date, date, text[], text[], text[], text[], boolean);
drop function if exists dashboard_flags(date, date, text[], text[], text[]);
drop function if exists dashboard_flag_rows(date, date, text[], text[], text[]);
drop table if exists flag_daily;

-- As in 064.
create or replace function refresh_dashboard_daily(days_back int default 45)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_today date := (now() at time zone 'UTC')::date;
  v_cut   date := v_today - days_back;
begin
  perform pg_advisory_xact_lock(hashtext('refresh_dashboard_daily'));
  delete from caller_daily  where day >= v_cut;
  delete from outcome_daily where day >= v_cut;
  -- One scan feeds both tables (a data-modifying CTE always runs to completion).
  with base as materialized (
    select (created_at at time zone 'UTC')::date as day,
      coalesce(vertical_name, '') as vertical,
      coalesce(nullif(publisher_name, ''), '(unknown)') as publisher_name,
      coalesce(nullif(advertiser_name, ''), '(unknown)') as advertiser_name,
      coalesce(our_outcome, '') as outcome,
      dashboard_caller_key(called_from) as caller,
      coalesce(advertiser_payin, 0) as payin
    from canoe_calls
    where is_test is not true
      and created_at >= v_cut::timestamp at time zone 'UTC'
      and created_at <  (v_today - 1)::timestamp at time zone 'UTC'   -- settled days only
  ), callers as (
    insert into caller_daily (day, vertical, publisher_name, advertiser_name, caller)
    select distinct day, vertical, publisher_name, advertiser_name, caller from base where caller is not null
  )
  insert into outcome_daily (day, vertical, publisher_name, advertiser_name, outcome, calls, paid, revenue)
  select day, vertical, publisher_name, advertiser_name, outcome,
    count(*), count(*) filter (where payin > 0), sum(payin)
  from base
  group by 1, 2, 3, 4, 5;
end;
$$;

drop function if exists dashboard_outcome_rows(date, date, text[], text[], text[]);
create function dashboard_outcome_rows(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null)
returns table (day date, vertical text, publisher_name text, advertiser_name text, outcome text,
               calls bigint, paid bigint, revenue numeric)
language sql stable set search_path = public, pg_temp as $$
  with w as (
    select coalesce((select max(o.day) + 1 from outcome_daily o), from_day) as live_from
  ), live as (
    select (c.created_at at time zone 'UTC')::date as day,
      coalesce(c.vertical_name, '') as vertical,
      coalesce(nullif(c.publisher_name, ''), '(unknown)') as publisher_name,
      coalesce(nullif(c.advertiser_name, ''), '(unknown)') as advertiser_name,
      coalesce(c.our_outcome, '') as outcome,
      coalesce(c.advertiser_payin, 0) as payin
    from canoe_calls c, w
    where c.is_test is not true
      and c.created_at >= greatest(from_day, w.live_from)::timestamp at time zone 'UTC'
      and c.created_at <  (to_day + 1)::timestamp at time zone 'UTC'
  )
  select o.day, o.vertical, o.publisher_name, o.advertiser_name, o.outcome, o.calls, o.paid, o.revenue
  from outcome_daily o, w
  where o.day >= from_day and o.day <= to_day and o.day < w.live_from
    and (verticals   is null or o.vertical        = any(verticals))
    and (publishers  is null or o.publisher_name  = any(publishers))
    and (advertisers is null or o.advertiser_name = any(advertisers))
  union all
  select l.day, l.vertical, l.publisher_name, l.advertiser_name, l.outcome,
    count(*), count(*) filter (where l.payin > 0), sum(l.payin)
  from live l
  where (verticals   is null or l.vertical        = any(verticals))
    and (publishers  is null or l.publisher_name  = any(publishers))
    and (advertisers is null or l.advertiser_name = any(advertisers))
  group by 1, 2, 3, 4, 5;
$$;

create or replace function dashboard_caller_rows(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null)
returns table (day date, caller bigint)
language sql stable set search_path = public, pg_temp as $$
  with w as (
    select coalesce((select max(d.day) + 1 from caller_daily d), from_day) as live_from
  )
  select d.day, d.caller
  from caller_daily d, w
  where d.day >= from_day and d.day <= to_day and d.day < w.live_from
    and (verticals   is null or d.vertical        = any(verticals))
    and (publishers  is null or d.publisher_name  = any(publishers))
    and (advertisers is null or d.advertiser_name = any(advertisers))
  union all
  select (c.created_at at time zone 'UTC')::date, dashboard_caller_key(c.called_from)
  from canoe_calls c, w
  where c.is_test is not true
    and c.created_at >= greatest(from_day, w.live_from)::timestamp at time zone 'UTC'
    and c.created_at <  (to_day + 1)::timestamp at time zone 'UTC'
    and dashboard_caller_key(c.called_from) is not null
    and (verticals   is null or coalesce(c.vertical_name, '') = any(verticals))
    and (publishers  is null or coalesce(nullif(c.publisher_name, ''), '(unknown)') = any(publishers))
    and (advertisers is null or coalesce(nullif(c.advertiser_name, ''), '(unknown)') = any(advertisers));
$$;

create or replace function dashboard_summary(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with p as (
    select from_day - (to_day - from_day + 1) as prev_from
  ), w as (
    select coalesce((select max(d.day) + 1 from insights_daily d), p.prev_from) as live_from from p
  ), money as (
    select d.day, d.raw as calls, d.paid, d.revenue, d.payout
    from insights_daily d, p, w
    where d.day >= p.prev_from and d.day <= to_day and d.day < w.live_from
      and (verticals   is null or d.vertical        = any(verticals))
      and (publishers  is null or d.publisher_name  = any(publishers))
      and (advertisers is null or d.advertiser_name = any(advertisers))
    union all
    select (c.created_at at time zone 'UTC')::date, 1, (coalesce(c.advertiser_payin, 0) > 0)::int,
      coalesce(c.advertiser_payin, 0), coalesce(c.publisher_payout, 0)
    from canoe_calls c, p, w
    where c.is_test is not true
      and c.created_at >= greatest(p.prev_from, w.live_from)::timestamp at time zone 'UTC'
      and c.created_at <  (to_day + 1)::timestamp at time zone 'UTC'
      and (verticals   is null or coalesce(c.vertical_name, '') = any(verticals))
      and (publishers  is null or coalesce(nullif(c.publisher_name, ''), '(unknown)') = any(publishers))
      and (advertisers is null or coalesce(nullif(c.advertiser_name, ''), '(unknown)') = any(advertisers))
  ), m as (
    select day >= from_day as cur, sum(calls) as calls, sum(paid) as paid, sum(revenue) as revenue, sum(payout) as payout
    from money group by 1
  ), u as (
    select r.day >= from_day as cur, count(distinct r.caller) as uniq
    from p, dashboard_caller_rows(p.prev_from, to_day, verticals, publishers, advertisers) r
    group by 1
  ), k as (
    select k.cur, coalesce(m.calls, 0) as calls, coalesce(u.uniq, 0) as uniq, coalesce(m.paid, 0) as paid,
      coalesce(m.revenue, 0) as revenue, coalesce(m.payout, 0) as payout
    from (values (true), (false)) k(cur) left join m using (cur) left join u using (cur)
  )
  select jsonb_build_object('from', from_day, 'to', to_day, 'prev_from', (select prev_from from p), 'prev_to', from_day - 1)
    || jsonb_object_agg(case when cur then 'current' else 'previous' end, jsonb_build_object(
      'calls', calls, 'unique_calls', uniq, 'paid_calls', paid,
      'revenue', revenue, 'publisher_cost', payout, 'margin', revenue - payout,
      'unique_pct', dashboard_rate(uniq, calls), 'paid_pct', dashboard_rate(paid, calls),
      'revenue_per_call', round(revenue / nullif(calls, 0), 2),
      'revenue_per_paid_call', round(revenue / nullif(paid, 0), 2),
      'margin_pct', dashboard_rate(revenue - payout, revenue)))
  from k;
$$;

grant execute on function dashboard_outcome_rows(date, date, text[], text[], text[]) to authenticated, service_role;
revoke execute on function dashboard_outcome_rows(date, date, text[], text[], text[]) from public, anon;

alter table outcome_daily drop column if exists payout;
drop function if exists dashboard_tz();

select refresh_dashboard_daily(4000);
