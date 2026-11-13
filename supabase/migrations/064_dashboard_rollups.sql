-- ============================================================
-- 064_dashboard_rollups.sql
-- Data layer for the MK-176 Dashboard tab: daily rollups plus read-only query functions that
-- encode the metric definitions, so the page (and any later report) gets the same numbers.
-- Every function sums rollups; only the newest ~2 days are read live from canoe_calls (1.2 GB;
-- summing it live is what timed out Insights, see 051).
--
-- Definitions (MK-176 board round 2, recommended answers taken 2026-11-13):
--   Q1 Unique calls   = distinct caller numbers in the range and filters. $ averages are per raw call.
--   Q2 Revenue        = advertiser payin. Calls with payout = billable calls (payin > 0).
--                       Publisher cost = publisher payout; margin = revenue - publisher cost.
--   Q3 Quality        = qualified-lead rate (the page sets the gauge bands per vertical).
--   Q4 Qualified Lead = appointment, sale, quoted_interested      -> dashboard_qualified_outcomes()
--   Q5 CPA            = advertiser payin in scope / (appointment + sale) -> dashboard_conversion_outcomes();
--                       optionally / qualified leads (adds quoted_interested). Rows per publisher x vertical.
--   Q6 Trend          = daily points with a 7-day rolling rate.
--   Q8 Outcome mix    = % of AI-scored calls, with the unscored count alongside; qualified and
--                       conversion rates = % of ALL calls.
--
-- 1) caller_daily: one row per (UTC day, vertical, publisher, advertiser, caller). The caller is a
--    64-bit hash of the number's digits, never the number. Distinct counts don't add up across
--    days, so unique calls need these rows rather than a daily count.
-- 2) outcome_daily: calls, billable calls and revenue per (day, vertical, publisher, advertiser,
--    our_outcome). Calls without an AI outcome are outcome '' so every denominator is all calls.
--    Keys match insights_daily (051): no vertical = '', no publisher/advertiser = '(unknown)'.
-- 3) refresh_dashboard_daily(days_back): rebuilds both from one scan of canoe_calls, settled days
--    only (older than yesterday, like insights_daily). pg_cron 'refresh-dashboard-rollup' runs it
--    nightly at 07:45 UTC, after the sync (~03:00-05:00), the 06:17 ingest and the 06:45-07:30
--    rollups. Gemini outcomes land up to ~24h after the sync, so the ingest also queues it through
--    052's refresh queue (rollup 'dashboard'), drained every 10 minutes.
-- 4) Query functions, signed-in only, read-only (SECURITY INVOKER, so RLS applies). All take
--    (from_day, to_day, verticals, publishers, advertisers): to_day inclusive, from_day <= to_day,
--    a null array = no filter, names as stored in the rollups. Days after a rollup's newest day
--    are read live, as in 051. The previous period is the same length, ending the day before
--    from_day.
--      dashboard_summary   Calls Breakdown + Calls Payout cards, current and previous period
--      dashboard_outcomes  outcome mix
--      dashboard_quality   qualified-lead rate overall and per vertical, current and previous period
--      dashboard_trend     daily rate of an outcome set (default: qualified) with a 7-day rolling rate
--      dashboard_cpa       CPA per publisher x vertical, with the inputs the Scores tab tiers on
--    dashboard_outcome_rows / dashboard_caller_rows are the row-level reads they share.
-- 5) History: the migration queues a full rebuild from the first call; the */10 queue job runs it
--    (a few minutes under pg_cron, no API timeout). Until then the functions read live.
-- Rollback: supabase/rollbacks/064_dashboard_rollups_down.sql
-- Test:     supabase/tests/064_dashboard_rollups_test.sql
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

-- ── Definitions: change them here and every function follows ──
create or replace function dashboard_qualified_outcomes()
returns text[] language sql immutable set search_path = '' as $$
  select array['appointment', 'sale', 'quoted_interested']
$$;

create or replace function dashboard_conversion_outcomes()
returns text[] language sql immutable set search_path = '' as $$
  select array['appointment', 'sale']
$$;

-- The caller key: first 64 bits of md5 over the number's digits, so '+1 (555) 010-0000' and
-- '15550100000' are one caller. Null when the number has no digits.
create or replace function dashboard_caller_key(called_from text)
returns bigint language sql immutable set search_path = '' as $$
  select ('x' || left(md5(nullif(regexp_replace(called_from, '\D', '', 'g'), '')), 16))::bit(64)::bigint
$$;

-- n / d rounded to 4 places; null when d is 0.
create or replace function dashboard_rate(n numeric, d numeric)
returns numeric language sql immutable set search_path = '' as $$
  select round(n / nullif(d, 0), 4)
$$;

-- ── 1-2) Rollups ──
create table if not exists caller_daily (
  day             date   not null,
  vertical        text   not null,
  publisher_name  text   not null,
  advertiser_name text   not null,
  caller          bigint not null,
  primary key (day, vertical, publisher_name, advertiser_name, caller)
);

create table if not exists outcome_daily (
  day             date    not null,
  vertical        text    not null,
  publisher_name  text    not null,
  advertiser_name text    not null,
  outcome         text    not null,   -- our_outcome; '' = not AI-scored
  calls           bigint  not null default 0,
  paid            bigint  not null default 0,
  revenue         numeric not null default 0,
  primary key (day, vertical, publisher_name, advertiser_name, outcome)
);

alter table caller_daily  enable row level security;
alter table outcome_daily enable row level security;
revoke all on table caller_daily, outcome_daily from anon, authenticated;
grant select on table caller_daily, outcome_daily to authenticated;
drop policy if exists "auth users can read caller_daily"  on caller_daily;
drop policy if exists "auth users can read outcome_daily" on outcome_daily;
create policy "auth users can read caller_daily"  on caller_daily  for select to authenticated using (true);
create policy "auth users can read outcome_daily" on outcome_daily for select to authenticated using (true);

-- ── 3) Refresh ──
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
revoke execute on function refresh_dashboard_daily(int) from public, anon, authenticated;
grant execute on function refresh_dashboard_daily(int) to service_role;

-- 052's queue learns the 'dashboard' rollup. Same bodies as 052 plus that one branch;
-- CREATE OR REPLACE keeps their grants (service role only).
alter table rollup_refresh_requests drop constraint if exists rollup_refresh_requests_rollup_check;
alter table rollup_refresh_requests add constraint rollup_refresh_requests_rollup_check
  check (rollup in ('agent_metrics', 'agent_counterparty', 'outcome_score', 'dashboard'));

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
  elsif p_rollup = 'dashboard'          then perform refresh_dashboard_daily(v_days);
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
  foreach r in array array['agent_metrics', 'agent_counterparty', 'outcome_score', 'dashboard'] loop
    begin
      perform run_rollup_refresh(r);
    exception when others then
      raise warning 'rollup refresh % failed, left queued: %', r, sqlerrm;
    end;
  end loop;
end;
$$;

-- ── 4) Query functions ──

-- outcome_daily rows in [from_day, to_day] matching the filters, plus the days after its newest
-- day read live from canoe_calls (grouped to the same keys).
create or replace function dashboard_outcome_rows(from_day date, to_day date,
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

-- caller_daily rows (day, caller) in [from_day, to_day] matching the filters, live after its newest day.
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

-- Calls Breakdown + Calls Payout. Money and call counts come from insights_daily (051).
-- { from, to, prev_from, prev_to, current: {...}, previous: {...} }, each period:
--   calls, unique_calls, paid_calls, revenue, publisher_cost, margin,
--   unique_pct, paid_pct (of calls), revenue_per_call, revenue_per_paid_call, margin_pct (of revenue)
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

-- Outcome mix. { qualified_outcomes, conversion_outcomes, calls, scored, not_scored,
--   qualified, qualified_rate (of all calls), qualified_pct_of_scored,
--   conversions, conversion_rate (of all calls),
--   outcomes: [{ outcome, calls, pct_of_scored, paid, revenue }] by calls desc }
create or replace function dashboard_outcomes(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with r as (
    select outcome, sum(calls) as calls, sum(paid) as paid, sum(revenue) as revenue
    from dashboard_outcome_rows(from_day, to_day, verticals, publishers, advertisers)
    group by 1
  ), t as (
    select coalesce(sum(calls), 0) as calls,
      coalesce(sum(calls) filter (where outcome <> ''), 0) as scored,
      coalesce(sum(calls) filter (where outcome = any(dashboard_qualified_outcomes())), 0) as qualified,
      coalesce(sum(calls) filter (where outcome = any(dashboard_conversion_outcomes())), 0) as conversions
    from r
  )
  select jsonb_build_object(
    'qualified_outcomes', to_jsonb(dashboard_qualified_outcomes()),
    'conversion_outcomes', to_jsonb(dashboard_conversion_outcomes()),
    'calls', t.calls, 'scored', t.scored, 'not_scored', t.calls - t.scored,
    'qualified', t.qualified, 'qualified_rate', dashboard_rate(t.qualified, t.calls),
    'qualified_pct_of_scored', dashboard_rate(t.qualified, t.scored),
    'conversions', t.conversions, 'conversion_rate', dashboard_rate(t.conversions, t.calls),
    'outcomes', coalesce((
      select jsonb_agg(jsonb_build_object('outcome', r.outcome, 'calls', r.calls,
        'pct_of_scored', dashboard_rate(r.calls, t.scored), 'paid', r.paid, 'revenue', r.revenue)
        order by r.calls desc, r.outcome)
      from r where r.outcome <> ''), '[]'::jsonb))
  from t;
$$;

-- Qualified-lead rate. { from, to, prev_from, prev_to, qualified_outcomes,
--   current: { calls, scored, qualified, rate (of all calls), scored_rate }, previous: { same },
--   verticals: [{ vertical, calls, scored, qualified, rate, scored_rate,
--                 prev_calls, prev_scored, prev_qualified, prev_rate, prev_scored_rate }] by calls desc }
create or replace function dashboard_quality(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with p as (
    select from_day - (to_day - from_day + 1) as prev_from
  ), v as (
    select r.vertical,
      coalesce(sum(r.calls) filter (where r.day >= from_day), 0) as calls,
      coalesce(sum(r.calls) filter (where r.day >= from_day and r.outcome <> ''), 0) as scored,
      coalesce(sum(r.calls) filter (where r.day >= from_day and r.outcome = any(dashboard_qualified_outcomes())), 0) as qualified,
      coalesce(sum(r.calls) filter (where r.day < from_day), 0) as prev_calls,
      coalesce(sum(r.calls) filter (where r.day < from_day and r.outcome <> ''), 0) as prev_scored,
      coalesce(sum(r.calls) filter (where r.day < from_day and r.outcome = any(dashboard_qualified_outcomes())), 0) as prev_qualified
    from p, dashboard_outcome_rows(p.prev_from, to_day, verticals, publishers, advertisers) r
    group by 1
  ), t as (
    select coalesce(sum(calls), 0) as calls, coalesce(sum(scored), 0) as scored, coalesce(sum(qualified), 0) as qualified,
      coalesce(sum(prev_calls), 0) as prev_calls, coalesce(sum(prev_scored), 0) as prev_scored,
      coalesce(sum(prev_qualified), 0) as prev_qualified
    from v
  )
  select jsonb_build_object(
    'from', from_day, 'to', to_day, 'prev_from', (select prev_from from p), 'prev_to', from_day - 1,
    'qualified_outcomes', to_jsonb(dashboard_qualified_outcomes()),
    'current', jsonb_build_object('calls', t.calls, 'scored', t.scored, 'qualified', t.qualified,
      'rate', dashboard_rate(t.qualified, t.calls), 'scored_rate', dashboard_rate(t.qualified, t.scored)),
    'previous', jsonb_build_object('calls', t.prev_calls, 'scored', t.prev_scored, 'qualified', t.prev_qualified,
      'rate', dashboard_rate(t.prev_qualified, t.prev_calls), 'scored_rate', dashboard_rate(t.prev_qualified, t.prev_scored)),
    'verticals', coalesce((
      select jsonb_agg(jsonb_build_object('vertical', v.vertical,
        'calls', v.calls, 'scored', v.scored, 'qualified', v.qualified,
        'rate', dashboard_rate(v.qualified, v.calls), 'scored_rate', dashboard_rate(v.qualified, v.scored),
        'prev_calls', v.prev_calls, 'prev_scored', v.prev_scored, 'prev_qualified', v.prev_qualified,
        'prev_rate', dashboard_rate(v.prev_qualified, v.prev_calls),
        'prev_scored_rate', dashboard_rate(v.prev_qualified, v.prev_scored))
        order by v.calls desc, v.vertical)
      from v where v.calls > 0 or v.prev_calls > 0), '[]'::jsonb))
  from t;
$$;

-- Daily rate of an outcome set (null = qualified leads; pass e.g. one outcome, or every outcome
-- with a negative weight). The 7-day rates sum the trailing 7 days' counts, so quiet days don't
-- swing them. { outcomes, days: [{ day, calls, scored, matched, rate (of all calls),
--   scored_rate, rate_7d, scored_rate_7d }] }, one entry per day, zero-filled.
create or replace function dashboard_trend(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null,
  outcomes text[] default null)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with o as (
    select coalesce(outcomes, dashboard_qualified_outcomes()) as picked
  ), d as (
    select r.day, sum(r.calls) as calls,
      sum(r.calls) filter (where r.outcome <> '') as scored,
      sum(r.calls) filter (where r.outcome = any(o.picked)) as matched
    from o, dashboard_outcome_rows(from_day - 6, to_day, verticals, publishers, advertisers) r
    group by 1
  ), s as (
    select g.day::date as day, coalesce(d.calls, 0) as calls, coalesce(d.scored, 0) as scored,
      coalesce(d.matched, 0) as matched
    from generate_series((from_day - 6)::timestamp, to_day::timestamp, interval '1 day') g(day)
    left join d on d.day = g.day::date
  ), w as (
    select s.*, sum(calls) over seven as c7, sum(scored) over seven as s7, sum(matched) over seven as m7
    from s
    window seven as (order by day rows between 6 preceding and current row)
  )
  select jsonb_build_object('outcomes', to_jsonb(o.picked), 'days', coalesce((
    select jsonb_agg(jsonb_build_object('day', w.day, 'calls', w.calls, 'scored', w.scored, 'matched', w.matched,
      'rate', dashboard_rate(w.matched, w.calls), 'scored_rate', dashboard_rate(w.matched, w.scored),
      'rate_7d', dashboard_rate(w.m7, w.c7), 'scored_rate_7d', dashboard_rate(w.m7, w.s7)) order by w.day)
    from w where w.day >= from_day), '[]'::jsonb))
  from o;
$$;

-- CPA = advertiser payin in scope / conversions (appointment + sale), or / qualified leads when
-- include_quoted (adds quoted_interested). Revenue is all payin in scope, scored or not, so show
-- scored_pct (AI-scored share of calls) next to it. Rows are per publisher x vertical, with the
-- Scores tab's tier inputs on publisher weights (outcome_weights.pub_score) over AI-scored calls:
-- avg_score, defect_rate (weight < 0), conv_adjacent_rate (weight >= 2).
-- { conversion_outcomes, total: { calls, scored, scored_pct, paid, revenue, conversions, cpa },
--   rows: [{ publisher_name, vertical, calls, scored, scored_pct, paid, revenue, conversions, cpa,
--            avg_score, defect_rate, conv_adjacent_rate }] by revenue desc }
create or replace function dashboard_cpa(from_day date, to_day date,
  verticals text[] default null, publishers text[] default null, advertisers text[] default null,
  include_quoted boolean default false)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with c as (
    select case when include_quoted then dashboard_qualified_outcomes() else dashboard_conversion_outcomes() end as conv
  ), r as (
    select r.publisher_name, r.vertical,
      sum(r.calls) as calls, sum(r.paid) as paid, sum(r.revenue) as revenue,
      coalesce(sum(r.calls) filter (where r.outcome <> ''), 0) as scored,
      coalesce(sum(r.calls) filter (where r.outcome = any(c.conv)), 0) as conversions,
      coalesce(sum(r.calls * coalesce(w.pub_score, 0)) filter (where r.outcome <> ''), 0) as weight_sum,
      coalesce(sum(r.calls) filter (where r.outcome <> '' and coalesce(w.pub_score, 0) < 0), 0) as defects,
      coalesce(sum(r.calls) filter (where r.outcome <> '' and coalesce(w.pub_score, 0) >= 2), 0) as conv_adjacent
    from c, dashboard_outcome_rows(from_day, to_day, verticals, publishers, advertisers) r
    left join outcome_weights w on w.outcome = r.outcome
    group by 1, 2
  )
  select jsonb_build_object(
    'conversion_outcomes', to_jsonb(c.conv),
    'total', (
      select jsonb_build_object('calls', coalesce(sum(calls), 0), 'scored', coalesce(sum(scored), 0),
        'scored_pct', dashboard_rate(sum(scored), sum(calls)), 'paid', coalesce(sum(paid), 0),
        'revenue', coalesce(sum(revenue), 0), 'conversions', coalesce(sum(conversions), 0),
        'cpa', round(sum(revenue) / nullif(sum(conversions), 0), 2))
      from r),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('publisher_name', r.publisher_name, 'vertical', r.vertical,
        'calls', r.calls, 'scored', r.scored, 'scored_pct', dashboard_rate(r.scored, r.calls),
        'paid', r.paid, 'revenue', r.revenue, 'conversions', r.conversions,
        'cpa', round(r.revenue / nullif(r.conversions, 0), 2),
        'avg_score', dashboard_rate(r.weight_sum, r.scored), 'defect_rate', dashboard_rate(r.defects, r.scored),
        'conv_adjacent_rate', dashboard_rate(r.conv_adjacent, r.scored))
        order by r.revenue desc, r.publisher_name, r.vertical)
      from r), '[]'::jsonb))
  from c;
$$;

-- Signed-in users (the page) only; anon and PUBLIC never (063).
do $$
declare
  f regprocedure;
begin
  foreach f in array array[
    'dashboard_qualified_outcomes()', 'dashboard_conversion_outcomes()', 'dashboard_caller_key(text)',
    'dashboard_rate(numeric, numeric)',
    'dashboard_outcome_rows(date, date, text[], text[], text[])', 'dashboard_caller_rows(date, date, text[], text[], text[])',
    'dashboard_summary(date, date, text[], text[], text[])', 'dashboard_outcomes(date, date, text[], text[], text[])',
    'dashboard_quality(date, date, text[], text[], text[])', 'dashboard_trend(date, date, text[], text[], text[], text[])',
    'dashboard_cpa(date, date, text[], text[], text[], boolean)'
  ]::regprocedure[] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ── Schedules (cron.schedule upserts by job name, so re-running is safe) ──
select cron.schedule('refresh-dashboard-rollup', '45 7 * * *', $$select public.refresh_dashboard_daily(45)$$);

-- ── 5) Build the history through the queue (the next */10 run), not inside this migration ──
insert into rollup_refresh_requests (rollup, from_day)
select 'dashboard', (min(created_at) at time zone 'UTC')::date from canoe_calls
having min(created_at) is not null;
