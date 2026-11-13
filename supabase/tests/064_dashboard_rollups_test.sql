-- ============================================================
-- Regression test for 064_dashboard_rollups.sql.
-- Everything runs inside one transaction that is ROLLED BACK at the end, so it leaves no rows
-- behind; raises on failure. Fixture names start with 'ZZTEST' and use their own verticals, so
-- the vertical filter isolates them from real calls. Run it off production (PGlite or a branch):
-- the refreshes below rebuild real rollup days before the rollback.
-- ============================================================
begin;
set local timezone = 'UTC';   -- current_date below is the UTC day, as in 064

-- Current period = t-3 .. t, previous = t-7 .. t-4. Days up to t-2 are rolled up; t-1 and t
-- are read live. Caller 0001 calls on t-3 (twice, two formats), t-1 and t-5.
insert into canoe_calls (id, created_at, is_test, ivr_name, publisher_name, advertiser_name, vertical_name,
                         called_from, our_outcome, advertiser_payin, publisher_payout) values
  ('zztest-d1', (current_date - 3)::timestamp at time zone 'UTC' + interval '10 hours', false,
   'ZZTEST Agent', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST Vertical', '+1 (555) 010-0001', 'appointment', 50, 20),
  ('zztest-d2', (current_date - 3)::timestamp at time zone 'UTC' + interval '11 hours', false,
   'ZZTEST Agent', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST Vertical', '15550100001', 'sale', 100, 40),
  ('zztest-d3', (current_date - 2)::timestamp at time zone 'UTC' + interval '9 hours', false,
   'ZZTEST Agent', 'ZZTEST Pub B', 'ZZTEST Adv 2', 'ZZTEST Vertical', '+15550100002', null, 0, 0),
  -- last second of a settled day
  ('zztest-d4', (current_date - 2)::timestamp at time zone 'UTC' + interval '86399 seconds', false,
   'ZZTEST Agent', 'ZZTEST Pub B', 'ZZTEST Adv', 'ZZTEST Vertical', '+15550100003', 'quoted_interested', 30, 10),
  -- live days
  ('zztest-d5', (current_date - 1)::timestamp at time zone 'UTC' + interval '8 hours', false,
   'ZZTEST Agent', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST Vertical', '+15550100001', 'voicemail', 0, 1),
  ('zztest-d6', current_date::timestamp at time zone 'UTC' + interval '1 hour', false,
   'ZZTEST Agent', '', 'ZZTEST Adv', 'ZZTEST Vertical', '+15550100004', null, 20, 5),
  -- test call: excluded everywhere
  ('zztest-d7', (current_date - 2)::timestamp at time zone 'UTC' + interval '12 hours', true,
   'ZZTEST Agent', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST Vertical', '+15550100008', 'sale', 999, 9),
  -- previous period
  ('zztest-d8', (current_date - 5)::timestamp at time zone 'UTC' + interval '10 hours', false,
   'ZZTEST Agent', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST Vertical', '+15550100001', 'appointment', 40, 10),
  ('zztest-d9', (current_date - 6)::timestamp at time zone 'UTC' + interval '10 hours', false,
   'ZZTEST Agent', 'ZZTEST Pub B', 'ZZTEST Adv', 'ZZTEST Vertical', '+15550100005', 'caller_hangup', 0, 0),
  -- another vertical
  ('zztest-d10', (current_date - 3)::timestamp at time zone 'UTC' + interval '10 hours', false,
   'ZZTEST Agent', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST Other', '+15550100009', 'sale', 70, 30);

select refresh_insights_daily(10);
select refresh_dashboard_daily(10);

do $$
declare
  t date := (now() at time zone 'UTC')::date;
  v text[] := array['ZZTEST Vertical'];
  s jsonb; o jsonb; q jsonb; tr jsonb; c jsonb; a jsonb; b jsonb;
  got record; want record;
begin
  -- ── Definitions ──
  assert dashboard_qualified_outcomes() = array['appointment', 'sale', 'quoted_interested'], 'Q4 qualified lead';
  assert dashboard_conversion_outcomes() = array['appointment', 'sale'], 'Q5 conversions';
  assert dashboard_caller_key('+1 (555) 010-0001') = dashboard_caller_key('15550100001'), 'caller key ignores formatting';
  assert dashboard_caller_key('+15550100001') <> dashboard_caller_key('+15550100002'), 'different numbers, different keys';
  assert dashboard_caller_key('') is null and dashboard_caller_key(null) is null, 'no digits = no caller';

  -- ── Rollups: settled days only, test calls out, one row per caller per day and keys ──
  assert not exists (select 1 from outcome_daily where day >= t - 1), 'no unsettled day in outcome_daily';
  assert not exists (select 1 from caller_daily where day >= t - 1), 'no unsettled day in caller_daily';
  assert (select sum(calls) from outcome_daily where vertical = 'ZZTEST Vertical') = 6,
    'outcome_daily holds the 6 settled non-test fixture calls';
  assert (select count(*) from caller_daily where vertical = 'ZZTEST Vertical' and day = t - 3) = 1,
    'one caller row for the same number in two formats on one day';
  assert (select outcome from outcome_daily where vertical = 'ZZTEST Vertical' and day = t - 2 and publisher_name = 'ZZTEST Pub B'
          and advertiser_name = 'ZZTEST Adv 2') = '', 'unscored call is outcome ''''';
  assert (select paid from outcome_daily where vertical = 'ZZTEST Vertical' and day = t - 3 and outcome = 'sale') = 1, 'billable call counted';

  -- ── dashboard_summary (rollup t-3, t-2 + live t-1, t) ──
  s := dashboard_summary(t - 3, t, v);
  assert s->>'prev_from' = (t - 7)::text and s->>'prev_to' = (t - 4)::text, format('previous period: %s', s);
  assert (s->'current'->>'calls')::int = 6 and (s->'current'->>'unique_calls')::int = 4
     and (s->'current'->>'paid_calls')::int = 4, format('breakdown: %s', s->'current');
  assert (s->'current'->>'revenue')::numeric = 200 and (s->'current'->>'publisher_cost')::numeric = 76
     and (s->'current'->>'margin')::numeric = 124, format('payout: %s', s->'current');
  assert (s->'current'->>'revenue_per_call')::numeric = 33.33 and (s->'current'->>'revenue_per_paid_call')::numeric = 50.00
     and (s->'current'->>'unique_pct')::numeric = 0.6667 and (s->'current'->>'paid_pct')::numeric = 0.6667
     and (s->'current'->>'margin_pct')::numeric = 0.62, format('ratios: %s', s->'current');
  assert (s->'previous'->>'calls')::int = 2 and (s->'previous'->>'unique_calls')::int = 2
     and (s->'previous'->>'paid_calls')::int = 1 and (s->'previous'->>'revenue')::numeric = 40, format('previous: %s', s->'previous');
  -- Filters, including the live tail's '(unknown)' publisher.
  assert (dashboard_summary(t - 3, t, v, array['ZZTEST Pub B'])->'current'->>'calls')::int = 2, 'publisher filter';
  assert (dashboard_summary(t - 3, t, v, null, array['ZZTEST Adv 2'])->'current'->>'calls')::int = 1, 'advertiser filter';
  assert (dashboard_summary(t - 3, t, v, array['(unknown)'])->'current'->>'revenue')::numeric = 20, 'unknown publisher, live';
  assert (dashboard_summary(t - 3, t, array['ZZTEST Vertical', 'ZZTEST Other'])->'current'->>'calls')::int = 7, 'two verticals';
  -- One-day periods on each side of the rollup boundary.
  assert (dashboard_summary(t - 2, t - 2, v)->'current'->>'calls')::int = 2, 'rollup day';
  assert (dashboard_summary(t - 1, t - 1, v)->'current'->>'calls')::int = 1, 'live day';
  s := dashboard_summary(t - 3, t, array['ZZTEST None']);
  assert (s->'current'->>'calls')::int = 0 and s->'current'->'revenue_per_call' = 'null'::jsonb, format('no match: %s', s);

  -- ── dashboard_outcomes ──
  o := dashboard_outcomes(t - 3, t, v);
  assert (o->>'calls')::int = 6 and (o->>'scored')::int = 4 and (o->>'not_scored')::int = 2, format('outcome totals: %s', o);
  assert (o->>'qualified')::int = 3 and (o->>'qualified_rate')::numeric = 0.5 and (o->>'qualified_pct_of_scored')::numeric = 0.75,
    format('qualified: %s', o);
  assert (o->>'conversions')::int = 2 and (o->>'conversion_rate')::numeric = 0.3333, format('conversions: %s', o);
  assert (select array_agg(e->>'outcome' order by ord) from jsonb_array_elements(o->'outcomes') with ordinality x(e, ord))
         = array['appointment', 'quoted_interested', 'sale', 'voicemail'], format('mix: %s', o->'outcomes');
  assert (o->'outcomes'->0->>'pct_of_scored')::numeric = 0.25, 'mix pct is of scored calls';

  -- ── dashboard_quality ──
  q := dashboard_quality(t - 3, t, array['ZZTEST Vertical', 'ZZTEST Other']);
  assert (q->'current'->>'calls')::int = 7 and (q->'current'->>'qualified')::int = 4, format('quality current: %s', q->'current');
  assert (q->'previous'->>'calls')::int = 2 and (q->'previous'->>'qualified')::int = 1
     and (q->'previous'->>'rate')::numeric = 0.5, format('quality previous: %s', q->'previous');
  assert jsonb_array_length(q->'verticals') = 2 and q->'verticals'->0->>'vertical' = 'ZZTEST Vertical'
     and (q->'verticals'->0->>'rate')::numeric = 0.5 and (q->'verticals'->0->>'scored_rate')::numeric = 0.75
     and (q->'verticals'->1->>'rate')::numeric = 1 and (q->'verticals'->1->>'prev_calls')::int = 0
     and q->'verticals'->1->'prev_rate' = 'null'::jsonb, format('per vertical: %s', q->'verticals');

  -- ── dashboard_trend ──
  tr := dashboard_trend(t - 3, t, v);
  assert jsonb_array_length(tr->'days') = 4, 'one point per day';
  assert (tr->'days'->0->>'calls')::int = 2 and (tr->'days'->0->>'matched')::int = 2
     and (tr->'days'->0->>'rate_7d')::numeric = 0.75, format('t-3 (window has t-6, t-5): %s', tr->'days'->0);
  assert (tr->'days'->3->>'calls')::int = 1 and (tr->'days'->3->>'matched')::int = 0
     and (tr->'days'->3->>'rate')::numeric = 0 and (tr->'days'->3->>'rate_7d')::numeric = 0.5
     and (tr->'days'->3->>'scored_rate_7d')::numeric = 0.6667, format('t: %s', tr->'days'->3);
  tr := dashboard_trend(t - 3, t, v, null, null, array['voicemail']);
  assert (tr->'days'->2->>'matched')::int = 1 and (tr->'days'->2->>'rate')::numeric = 1, 'custom outcome set';
  assert (dashboard_trend(t - 3, t, array['ZZTEST None'])->'days'->1->>'calls')::int = 0, 'empty days are zero-filled';

  -- ── dashboard_cpa ──
  c := dashboard_cpa(t - 3, t, v);
  assert (c->'total'->>'revenue')::numeric = 200 and (c->'total'->>'conversions')::int = 2
     and (c->'total'->>'cpa')::numeric = 100 and (c->'total'->>'scored_pct')::numeric = 0.6667, format('cpa total: %s', c->'total');
  select e into a from jsonb_array_elements(c->'rows') e where e->>'publisher_name' = 'ZZTEST Pub A';
  assert (a->>'calls')::int = 3 and (a->>'revenue')::numeric = 150 and (a->>'cpa')::numeric = 75, format('Pub A: %s', a);
  select round(sum(coalesce(w.pub_score, 0))::numeric / 3, 4) as avg,
         round(count(*) filter (where coalesce(w.pub_score, 0) < 0)::numeric / 3, 4) as defect,
         round(count(*) filter (where coalesce(w.pub_score, 0) >= 2)::numeric / 3, 4) as conv
    into want
    from unnest(array['appointment', 'sale', 'voicemail']) x(outcome) left join outcome_weights w using (outcome);
  assert (a->>'avg_score')::numeric = want.avg and (a->>'defect_rate')::numeric = want.defect
     and (a->>'conv_adjacent_rate')::numeric = want.conv, format('Pub A tier inputs %s vs %s', a, row_to_json(want));
  select e into b from jsonb_array_elements(c->'rows') e where e->>'publisher_name' = 'ZZTEST Pub B';
  assert (b->>'conversions')::int = 0 and b->'cpa' = 'null'::jsonb, format('Pub B, no conversions: %s', b);
  c := dashboard_cpa(t - 3, t, v, null, null, true);
  assert c->'conversion_outcomes' = '["appointment", "sale", "quoted_interested"]'::jsonb
     and (c->'total'->>'cpa')::numeric = 66.67, format('include quoted_interested: %s', c->'total');
  assert (dashboard_cpa(t - 3, t, v, array['ZZTEST Pub A', 'ZZTEST Pub B'])->'total'->>'cpa')::numeric = 90,
    'publisher group: (150 + 30) / 2';

  -- ── Real data: the functions match the raw table over the last 10 days ──
  select (s2->'current'->>'calls')::bigint n, (s2->'current'->>'unique_calls')::bigint u, (s2->'current'->>'paid_calls')::bigint p,
         (s2->'current'->>'revenue')::numeric r
    into got from (select dashboard_summary(t - 9, t) s2) x;
  select count(*) n, count(distinct dashboard_caller_key(called_from)) u,
         count(*) filter (where coalesce(advertiser_payin, 0) > 0) p, coalesce(sum(advertiser_payin), 0) r
    into want from canoe_calls
    where is_test is not true
      and created_at >= (t - 9)::timestamp at time zone 'UTC' and created_at < (t + 1)::timestamp at time zone 'UTC';
  assert got.n = want.n and got.u = want.u and got.p = want.p and got.r = want.r,
    format('summary %s vs raw %s', row_to_json(got), row_to_json(want));
  assert (dashboard_outcomes(t - 9, t)->>'scored')::bigint = (select count(*) from canoe_calls
    where is_test is not true and coalesce(our_outcome, '') <> ''
      and created_at >= (t - 9)::timestamp at time zone 'UTC' and created_at < (t + 1)::timestamp at time zone 'UTC'),
    'scored calls match raw';
end $$;

-- ── The refresh queue knows the dashboard rollup ──
delete from caller_daily where day = current_date - 3;
delete from rollup_refresh_requests where rollup = 'dashboard';   -- e.g. the migration's backfill; rolled back
select request_rollup_refresh((current_date - 3)::timestamp at time zone 'UTC', array['dashboard']);
do $$ begin
  assert run_rollup_refresh('dashboard') = 3, 'queued refresh runs from the requested day';
  assert exists (select 1 from caller_daily where day = current_date - 3 and vertical = 'ZZTEST Vertical'), 'queue rebuilt the day';
  assert not exists (select 1 from rollup_refresh_requests where rollup = 'dashboard'), 'request drained';
  assert (select schedule from cron.job where jobname = 'refresh-dashboard-rollup') = '45 7 * * *', 'nightly job scheduled';
end $$;

-- ── Grants: signed-in users read; nobody but the service role refreshes; anon gets nothing ──
do $$
declare
  f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'dashboard\_%' or p.proname = 'refresh_dashboard_daily') loop
    assert not has_function_privilege('anon', f, 'execute'), 'anon cannot run ' || f;
  end loop;
  assert has_function_privilege('authenticated', 'dashboard_summary(date, date, text[], text[], text[])', 'execute'), 'authenticated: summary';
  assert not has_function_privilege('authenticated', 'refresh_dashboard_daily(int)', 'execute'), 'authenticated: no refresh';
  assert has_function_privilege('service_role', 'refresh_dashboard_daily(int)', 'execute'), 'service_role: refresh';
  assert not has_table_privilege('anon', 'caller_daily', 'select, insert, update, delete, truncate, references, trigger'), 'anon: caller_daily';
  assert not has_table_privilege('anon', 'outcome_daily', 'select, insert, update, delete, truncate, references, trigger'), 'anon: outcome_daily';
  assert has_table_privilege('authenticated', 'outcome_daily', 'select'), 'authenticated reads outcome_daily';
  assert not has_table_privilege('authenticated', 'outcome_daily', 'insert, update, delete, truncate, references, trigger'), 'authenticated: read-only';
  assert not has_table_privilege('authenticated', 'caller_daily', 'insert, update, delete, truncate, references, trigger'), 'authenticated: read-only';
end $$;

set local role authenticated;
do $$
declare
  t date := (now() at time zone 'UTC')::date;
begin
  assert (dashboard_summary(t - 3, t, array['ZZTEST Vertical'])->'current'->>'unique_calls')::int = 4, 'authenticated: summary';
  assert (dashboard_outcomes(t - 3, t, array['ZZTEST Vertical'])->>'scored')::int = 4, 'authenticated: outcomes';
  assert dashboard_quality(t - 3, t, array['ZZTEST Vertical']) is not null, 'authenticated: quality';
  assert dashboard_trend(t - 3, t, array['ZZTEST Vertical']) is not null, 'authenticated: trend';
  assert dashboard_cpa(t - 3, t, array['ZZTEST Vertical']) is not null, 'authenticated: cpa';
  begin
    perform refresh_dashboard_daily(1);
    raise exception 'authenticated must not run refresh_dashboard_daily';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into outcome_daily (day, vertical, publisher_name, advertiser_name, outcome) values (t, 'ZZTEST', 'x', 'x', '');
    raise exception 'authenticated must not write outcome_daily';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role anon;
do $$ begin
  begin
    perform dashboard_summary(current_date, current_date);
    raise exception 'anon must not run dashboard_summary';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from caller_daily limit 1;
    raise exception 'anon must not read caller_daily';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
