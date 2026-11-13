-- ============================================================
-- 065_dashboard_mountain_days_and_flags.sql
-- MK-176: the Dashboard and Calls pages become one page with one filter bar, so the cards,
-- charts and call list must count the same calls. Captain's call (2026-11-13): the whole page
-- uses business days in Mountain Time (America/Denver). Before this, the 064 rollups used UTC
-- days and the Calls list used the viewer's local days.
--
-- 1) dashboard_tz() = 'America/Denver'. caller_daily and outcome_daily are rebuilt on Mountain
--    days, and their "settled" cut moves with them (older than yesterday, Mountain).
-- 2) outcome_daily gains payout (publisher payout), so dashboard_summary sums outcome_daily
--    instead of insights_daily (UTC; Insights keeps it unchanged).
-- 3) flag_daily: AI-scored calls with a flag or suspicious_call, per (day, vertical, publisher,
--    advertiser, sorted flag set, suspicious). Keeping the whole set per call means "any of these
--    flags" and "high severity" are exact, not summed per flag.
-- 4) Functions: the row reads and dashboard_summary move to Mountain days (summary also returns
--    scored); dashboard_outcomes/_quality/_trend/_cpa are unchanged and follow. New:
--      dashboard_flag_rows  row-level read of flag_daily
--      dashboard_flags      flag-set histogram for a range (the Calls strip when no list filter is on)
--      dashboard_flag_trend daily share of AI-scored calls with any of a set of flags, 7-day rolling
-- 5) The rebuild runs inline (about 30 s on prod). The whole migration is one transaction, and
--    the ALTER holds outcome_daily's lock until commit, so dashboard reads wait up to that long.
-- Rollback: supabase/rollbacks/065_dashboard_mountain_days_and_flags_down.sql
-- Test:     supabase/tests/065_dashboard_mountain_days_and_flags_test.sql
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

create or replace function dashboard_tz()
returns text language sql immutable set search_path = '' as $$
  select 'America/Denver'
$$;

alter table outcome_daily add column if not exists payout numeric not null default 0;

create table if not exists flag_daily (
  day             date    not null,
  vertical        text    not null,
  publisher_name  text    not null,
  advertiser_name text    not null,
  flags           text[]  not null,   -- the call's flags, distinct and sorted; '{}' = suspicious only
  suspicious      boolean not null,   -- canoe_calls.suspicious_call
  calls           bigint  not null default 0,
  primary key (day, vertical, publisher_name, advertiser_name, flags, suspicious)
);
alter table flag_daily enable row level security;
revoke all on table flag_daily from anon, authenticated;
grant select on table flag_daily to authenticated;
drop policy if exists "auth users can read flag_daily" on flag_daily;
create policy "auth users can read flag_daily" on flag_daily for select to authenticated using (true);

-- ── Refresh: Mountain days, all three tables from one scan ──
create or replace function refresh_dashboard_daily(days_back int default 45)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_today date := (now() at time zone dashboard_tz())::date;
  v_cut   date := v_today - days_back;
begin
  perform pg_advisory_xact_lock(hashtext('refresh_dashboard_daily'));
  delete from caller_daily  where day >= v_cut;
  delete from outcome_daily where day >= v_cut;
  delete from flag_daily    where day >= v_cut;
  -- One scan feeds all three tables (a data-modifying CTE always runs to completion).
  with base as materialized (
    select (created_at at time zone dashboard_tz())::date as day,
      coalesce(vertical_name, '') as vertical,
      coalesce(nullif(publisher_name, ''), '(unknown)') as publisher_name,
      coalesce(nullif(advertiser_name, ''), '(unknown)') as advertiser_name,
      coalesce(our_outcome, '') as outcome,
      dashboard_caller_key(called_from) as caller,
      coalesce(advertiser_payin, 0) as payin,
      coalesce(publisher_payout, 0) as payout,
      case when jsonb_array_length(coalesce(flags, '[]'::jsonb)) > 0
        then (select array_agg(distinct f order by f) from jsonb_array_elements_text(flags) f)
        else '{}'::text[] end as flagset,
      coalesce(suspicious_call, false) as suspicious
    from canoe_calls
    where is_test is not true
      and created_at >= v_cut::timestamp at time zone dashboard_tz()
      and created_at <  (v_today - 1)::timestamp at time zone dashboard_tz()   -- settled days only
  ), callers as (
    insert into caller_daily (day, vertical, publisher_name, advertiser_name, caller)
    select distinct day, vertical, publisher_name, advertiser_name, caller from base where caller is not null
  ), flagged as (
    insert into flag_daily (day, vertical, publisher_name, advertiser_name, flags, suspicious, calls)
    select day, vertical, publisher_name, advertiser_name, flagset, suspicious, count(*)
    from base
    where outcome <> '' and (cardinality(flagset) > 0 or suspicious)
    group by 1, 2, 3, 4, 5, 6
  )
  insert into outcome_daily (day, vertical, publisher_name, advertiser_name, outcome, calls, paid, revenue, payout)
  select day, vertical, publisher_name, advertiser_name, outcome,
    count(*), count(*) filter (where payin > 0), sum(payin), sum(payout)
  from base
  group by 1, 2, 3, 4, 5;
end;
$$;
revoke execute on function refresh_dashboard_daily(int) from public, anon, authenticated;
grant execute on function refresh_dashboard_daily(int) to service_role;

-- ── Row reads on Mountain days (the return type changes, so drop and recreate) ──
drop function if exists dashboard_outcome_rows(date, date, text[], text[], text[]);
create function dashboard_outcome_rows(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null)
returns table (day date, vertical text, publisher_name text, advertiser_name text, outcome text,
               calls bigint, paid bigint, revenue numeric, payout numeric)
language sql stable set search_path = public, pg_temp as $$
  with w as (
    select coalesce((select max(o.day) + 1 from outcome_daily o), from_day) as live_from
  ), live as (
    select (c.created_at at time zone dashboard_tz())::date as day,
      coalesce(c.vertical_name, '') as vertical,
      coalesce(nullif(c.publisher_name, ''), '(unknown)') as publisher_name,
      coalesce(nullif(c.advertiser_name, ''), '(unknown)') as advertiser_name,
      coalesce(c.our_outcome, '') as outcome,
      coalesce(c.advertiser_payin, 0) as payin,
      coalesce(c.publisher_payout, 0) as payout
    from canoe_calls c, w
    where c.is_test is not true
      and c.created_at >= greatest(from_day, w.live_from)::timestamp at time zone dashboard_tz()
      and c.created_at <  (to_day + 1)::timestamp at time zone dashboard_tz()
  )
  select o.day, o.vertical, o.publisher_name, o.advertiser_name, o.outcome, o.calls, o.paid, o.revenue, o.payout
  from outcome_daily o, w
  where o.day >= from_day and o.day <= to_day and o.day < w.live_from
    and (verticals   is null or o.vertical        = any(verticals))
    and (publishers  is null or o.publisher_name  = any(publishers))
    and (advertisers is null or o.advertiser_name = any(advertisers))
  union all
  select l.day, l.vertical, l.publisher_name, l.advertiser_name, l.outcome,
    count(*), count(*) filter (where l.payin > 0), sum(l.payin), sum(l.payout)
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
  select (c.created_at at time zone dashboard_tz())::date, dashboard_caller_key(c.called_from)
  from canoe_calls c, w
  where c.is_test is not true
    and c.created_at >= greatest(from_day, w.live_from)::timestamp at time zone dashboard_tz()
    and c.created_at <  (to_day + 1)::timestamp at time zone dashboard_tz()
    and dashboard_caller_key(c.called_from) is not null
    and (verticals   is null or coalesce(c.vertical_name, '') = any(verticals))
    and (publishers  is null or coalesce(nullif(c.publisher_name, ''), '(unknown)') = any(publishers))
    and (advertisers is null or coalesce(nullif(c.advertiser_name, ''), '(unknown)') = any(advertisers));
$$;

-- flag_daily rows (day, flags, suspicious, calls) in [from_day, to_day] matching the filters,
-- live after its newest day. Only AI-scored calls carry flags.
create or replace function dashboard_flag_rows(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null)
returns table (day date, flags text[], suspicious boolean, calls bigint)
language sql stable set search_path = public, pg_temp as $$
  with w as (
    select coalesce((select max(f.day) + 1 from flag_daily f), from_day) as live_from
  ), live as (
    select (c.created_at at time zone dashboard_tz())::date as day,
      coalesce((select array_agg(distinct x order by x) from jsonb_array_elements_text(c.flags) x), '{}'::text[]) as flags,
      coalesce(c.suspicious_call, false) as suspicious
    from canoe_calls c, w
    where c.is_test is not true
      and c.created_at >= greatest(from_day, w.live_from)::timestamp at time zone dashboard_tz()
      and c.created_at <  (to_day + 1)::timestamp at time zone dashboard_tz()
      and coalesce(c.our_outcome, '') <> ''
      and (jsonb_array_length(coalesce(c.flags, '[]'::jsonb)) > 0 or c.suspicious_call)
      and (verticals   is null or coalesce(c.vertical_name, '') = any(verticals))
      and (publishers  is null or coalesce(nullif(c.publisher_name, ''), '(unknown)') = any(publishers))
      and (advertisers is null or coalesce(nullif(c.advertiser_name, ''), '(unknown)') = any(advertisers))
  )
  select f.day, f.flags, f.suspicious, f.calls
  from flag_daily f, w
  where f.day >= from_day and f.day <= to_day and f.day < w.live_from
    and (verticals   is null or f.vertical        = any(verticals))
    and (publishers  is null or f.publisher_name  = any(publishers))
    and (advertisers is null or f.advertiser_name = any(advertisers))
  union all
  select l.day, l.flags, l.suspicious, count(*) from live l group by 1, 2, 3;
$$;

-- Calls Breakdown + Calls Payout, now from outcome_daily (Mountain days). Same shape as 064, plus
-- scored (AI-scored calls) in each period.
create or replace function dashboard_summary(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with p as (
    select from_day - (to_day - from_day + 1) as prev_from
  ), m as (
    select r.day >= from_day as cur, sum(r.calls) as calls, sum(r.paid) as paid,
      sum(r.calls) filter (where r.outcome <> '') as scored, sum(r.revenue) as revenue, sum(r.payout) as payout
    from p, dashboard_outcome_rows(p.prev_from, to_day, verticals, publishers, advertisers) r
    group by 1
  ), u as (
    select r.day >= from_day as cur, count(distinct r.caller) as uniq
    from p, dashboard_caller_rows(p.prev_from, to_day, verticals, publishers, advertisers) r
    group by 1
  ), k as (
    select k.cur, coalesce(m.calls, 0) as calls, coalesce(u.uniq, 0) as uniq, coalesce(m.paid, 0) as paid,
      coalesce(m.scored, 0) as scored, coalesce(m.revenue, 0) as revenue, coalesce(m.payout, 0) as payout
    from (values (true), (false)) k(cur) left join m using (cur) left join u using (cur)
  )
  select jsonb_build_object('from', from_day, 'to', to_day, 'prev_from', (select prev_from from p), 'prev_to', from_day - 1)
    || jsonb_object_agg(case when cur then 'current' else 'previous' end, jsonb_build_object(
      'calls', calls, 'unique_calls', uniq, 'paid_calls', paid, 'scored', scored,
      'revenue', revenue, 'publisher_cost', payout, 'margin', revenue - payout,
      'unique_pct', dashboard_rate(uniq, calls), 'paid_pct', dashboard_rate(paid, calls),
      'revenue_per_call', round(revenue / nullif(calls, 0), 2),
      'revenue_per_paid_call', round(revenue / nullif(paid, 0), 2),
      'margin_pct', dashboard_rate(revenue - payout, revenue)))
  from k;
$$;

-- Flag-set histogram for a range: [{ flags, suspicious_call, n }], the shape the Calls strip
-- already totals from raw rows (callsStripTotals), so it can read this instead.
create or replace function dashboard_flags(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('flags', to_jsonb(g.flags), 'suspicious_call', g.suspicious, 'n', g.n)
    order by g.n desc), '[]'::jsonb)
  from (
    select r.flags, r.suspicious, sum(r.calls) as n
    from dashboard_flag_rows(from_day, to_day, verticals, publishers, advertisers) r
    group by 1, 2
  ) g;
$$;

-- Daily share of AI-scored calls with any of `flags` (null = any flag at all), counting
-- suspicious_call too when include_suspicious. Each call counts once, however many of the flags
-- it has. { flags, include_suspicious, days: [{ day, scored, matched, rate, rate_7d }] },
-- one entry per day, zero-filled.
create or replace function dashboard_flag_trend(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null,
  flags text[] default null, include_suspicious boolean default false)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with s as (
    select r.day, sum(r.calls) filter (where r.outcome <> '') as scored
    from dashboard_outcome_rows(from_day - 6, to_day, verticals, publishers, advertisers) r
    group by 1
  ), m as (
    select r.day, sum(r.calls) as matched
    from dashboard_flag_rows(from_day - 6, to_day, verticals, publishers, advertisers) r
    -- `flags` alone would mean the column here; the parameter is dashboard_flag_trend.flags.
    where (case when dashboard_flag_trend.flags is null then cardinality(r.flags) > 0
                else r.flags && dashboard_flag_trend.flags end)
       or (include_suspicious and r.suspicious)
    group by 1
  ), d as (
    select g.day::date as day, coalesce(s.scored, 0) as scored, coalesce(m.matched, 0) as matched
    from generate_series((from_day - 6)::timestamp, to_day::timestamp, interval '1 day') g(day)
    left join s on s.day = g.day::date
    left join m on m.day = g.day::date
  ), w as (
    select d.*, sum(scored) over seven as s7, sum(matched) over seven as m7
    from d
    window seven as (order by day rows between 6 preceding and current row)
  )
  select jsonb_build_object('flags', to_jsonb(dashboard_flag_trend.flags), 'include_suspicious', include_suspicious, 'days', coalesce((
    select jsonb_agg(jsonb_build_object('day', w.day, 'scored', w.scored, 'matched', w.matched,
      'rate', dashboard_rate(w.matched, w.scored), 'rate_7d', dashboard_rate(w.m7, w.s7)) order by w.day)
    from w where w.day >= from_day), '[]'::jsonb));
$$;

-- Signed-in users (the page) only; anon and PUBLIC never (063).
do $$
declare
  f regprocedure;
begin
  foreach f in array array[
    'dashboard_tz()',
    'dashboard_outcome_rows(date, date, text[], text[], text[])', 'dashboard_caller_rows(date, date, text[], text[], text[])',
    'dashboard_flag_rows(date, date, text[], text[], text[])', 'dashboard_summary(date, date, text[], text[], text[])',
    'dashboard_flags(date, date, text[], text[], text[])',
    'dashboard_flag_trend(date, date, text[], text[], text[], text[], boolean)'
  ]::regprocedure[] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ── Rebuild the history on Mountain days (readers see the old rows until this commits) ──
select refresh_dashboard_daily(4000);
