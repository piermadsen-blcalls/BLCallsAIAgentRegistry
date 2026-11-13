-- ============================================================
-- Regression test for 065_dashboard_mountain_days_and_flags.sql.
-- Everything runs inside one transaction that is ROLLED BACK at the end; raises on failure.
-- Fixtures use the vertical 'ZZTEST MT' and ids 'zztest-m*'. Run it off production (PGlite or a
-- branch): the refresh below rebuilds real rollup days before the rollback.
-- ============================================================
begin;

-- t = today in Mountain Time. Current period = t-3 .. t, previous = t-7 .. t-4. m2 is 23:30 on
-- t-3 in Mountain Time, already t-2 in UTC; m3 is 00:30 on t-2. t-1 and t are read live.
create temp table zz_t as select (now() at time zone 'America/Denver')::date as today_mt;
insert into canoe_calls (id, created_at, is_test, ivr_name, publisher_name, advertiser_name, vertical_name,
                         called_from, our_outcome, advertiser_payin, publisher_payout, flags, suspicious_call, ai_processed_at)
select v.id, (zz_t.today_mt - v.d)::timestamp at time zone 'America/Denver' + v.at, false, 'ZZTEST Agent', v.pub, 'ZZTEST Adv',
       'ZZTEST MT', v.caller, v.outcome, v.payin, v.payout, v.flags::jsonb, v.susp, case when v.outcome is not null then now() end
from zz_t, (values
  ('zztest-m1', 3, interval '10 hours',    'ZZTEST Pub A', '+15550100001', 'appointment',       50, 20, '["geo_mismatch","duplicate_caller"]', false),
  ('zztest-m2', 3, interval '23.5 hours',  'ZZTEST Pub A', '+15550100002', 'sale',             100, 40, '["outbound_dial"]', true),
  ('zztest-m3', 2, interval '30 minutes',  'ZZTEST Pub B', '+15550100003', null,                 0,  0, '["geo_mismatch"]', false),
  ('zztest-m4', 2, interval '12 hours',    'ZZTEST Pub B', '+15550100001', 'voicemail',          0,  1, '[]', true),
  ('zztest-m5', 1, interval '9 hours',     'ZZTEST Pub A', '+15550100004', 'quoted_interested', 30, 10, '["geo_mismatch"]', false),
  ('zztest-m6', 5, interval '10 hours',    'ZZTEST Pub A', '+15550100005', 'appointment',       40, 10, '[]', false)
) as v(id, d, at, pub, caller, outcome, payin, payout, flags, susp);

select refresh_dashboard_daily(10);

do $$
declare
  t date := (select today_mt from zz_t);
  v text[] := array['ZZTEST MT'];
  s jsonb; f jsonb; tr jsonb;
  got record; want record;
begin
  assert dashboard_tz() = 'America/Denver', 'business timezone';

  -- ── Rollups on Mountain days, settled days only ──
  assert not exists (select 1 from outcome_daily where day >= t - 1), 'no unsettled Mountain day in outcome_daily';
  assert (select sum(calls) from outcome_daily where vertical = 'ZZTEST MT' and day = t - 3) = 2, 'm2 (23:30 MT) is on t-3';
  assert (select sum(calls) from outcome_daily where vertical = 'ZZTEST MT' and day = t - 2) = 2, 'm3 (00:30 MT) is on t-2';
  assert (select sum(payout) from outcome_daily where vertical = 'ZZTEST MT') = 71, 'payout rolled up';
  assert (select array_agg(flags::text || suspicious::text order by cardinality(flags) desc, flags, suspicious) from flag_daily where vertical = 'ZZTEST MT')
         = array['{duplicate_caller,geo_mismatch}false', '{outbound_dial}true', '{}true'],
    format('flag sets sorted, suspicious-only kept, unscored m3 left out: %s',
      (select array_agg(flags::text || suspicious::text) from flag_daily where vertical = 'ZZTEST MT'));

  -- ── dashboard_summary from outcome_daily ──
  s := dashboard_summary(t - 3, t, v);
  assert (s->'current'->>'calls')::int = 5 and (s->'current'->>'unique_calls')::int = 4
     and (s->'current'->>'paid_calls')::int = 3 and (s->'current'->>'scored')::int = 4, format('breakdown: %s', s->'current');
  assert (s->'current'->>'revenue')::numeric = 180 and (s->'current'->>'publisher_cost')::numeric = 71
     and (s->'current'->>'margin')::numeric = 109, format('payout: %s', s->'current');
  assert (s->'previous'->>'calls')::int = 1 and (s->'previous'->>'publisher_cost')::numeric = 10, format('previous: %s', s->'previous');
  assert (dashboard_summary(t - 3, t - 3, v)->'current'->>'calls')::int = 2, 'one Mountain day';
  assert (dashboard_summary(t - 1, t - 1, v)->'current'->>'publisher_cost')::numeric = 10, 'live day carries payout';

  -- ── Outcome functions follow (Mountain days) ──
  assert (dashboard_outcomes(t - 3, t, v)->>'qualified')::int = 3, 'qualified m1, m2, m5';
  assert (dashboard_quality(t - 3, t, v)->'current'->>'scored_rate')::numeric = 0.75, 'quality on scored calls';
  assert (dashboard_cpa(t - 3, t, v)->'total'->>'cpa')::numeric = 90, 'cpa 180 / 2';

  -- ── dashboard_flags: the strip histogram ──
  f := dashboard_flags(t - 3, t, v);
  assert jsonb_array_length(f) = 4 and (select sum((e->>'n')::int) from jsonb_array_elements(f) e) = 4, format('histogram: %s', f);
  assert f @> '[{"flags": ["outbound_dial"], "suspicious_call": true, "n": 1}, {"flags": [], "suspicious_call": true, "n": 1}]'::jsonb,
    format('suspicious kept apart: %s', f);

  -- ── dashboard_flag_trend ──
  tr := dashboard_flag_trend(t - 3, t, v, null, null, array['geo_mismatch']);
  assert jsonb_array_length(tr->'days') = 4, 'one point per day';
  assert (tr->'days'->0->>'matched')::int = 1 and (tr->'days'->0->>'scored')::int = 2 and (tr->'days'->0->>'rate')::numeric = 0.5,
    format('t-3 geo: %s', tr->'days'->0);
  assert (tr->'days'->1->>'matched')::int = 0 and (tr->'days'->1->>'scored')::int = 1, format('t-2: unscored m3 not counted: %s', tr->'days'->1);
  assert (tr->'days'->2->>'rate')::numeric = 1, 'live day';
  assert tr->'days'->3->'rate' = 'null'::jsonb, 'no scored calls: no rate';
  assert (tr->'days'->3->>'rate_7d')::numeric = 0.4, format('7-day: 2 of 5 scored: %s', tr->'days'->3);
  assert (dashboard_flag_trend(t - 3, t, v)->'days'->0->>'matched')::int = 2, 'null = any flag (m1, m2)';
  assert (dashboard_flag_trend(t - 3, t, v, null, null, array['geo_mismatch', 'duplicate_caller'])->'days'->0->>'matched')::int = 1,
    'a call with two of the flags counts once';
  assert (dashboard_flag_trend(t - 3, t, v, null, null, array['outbound_dial', 'geo_mismatch'])->'days'->0->>'matched')::int = 2, 'any of the set';
  assert (dashboard_flag_trend(t - 3, t, v)->'days'->1->>'matched')::int = 0, 'suspicious-only is not a flag';
  assert (dashboard_flag_trend(t - 3, t, v, null, null, null, true)->'days'->1->>'matched')::int = 1, 'unless include_suspicious';

  -- ── Real data: Mountain-day totals match the raw table over the last 10 days ──
  select (x->'current'->>'calls')::bigint n, (x->'current'->>'unique_calls')::bigint u, (x->'current'->>'scored')::bigint sc,
         (x->'current'->>'revenue')::numeric r, (x->'current'->>'publisher_cost')::numeric o
    into got from (select dashboard_summary(t - 9, t) x) q;
  select count(*) n, count(distinct dashboard_caller_key(called_from)) u, count(*) filter (where coalesce(our_outcome, '') <> '') sc,
         coalesce(sum(advertiser_payin), 0) r, coalesce(sum(publisher_payout), 0) o
    into want from canoe_calls
    where is_test is not true
      and created_at >= (t - 9)::timestamp at time zone 'America/Denver' and created_at < (t + 1)::timestamp at time zone 'America/Denver';
  assert got.n = want.n and got.u = want.u and got.sc = want.sc and got.r = want.r and got.o = want.o,
    format('summary %s vs raw %s', row_to_json(got), row_to_json(want));
  assert (select sum((e->>'n')::bigint) from jsonb_array_elements(dashboard_flags(t - 9, t)) e)
       = (select count(*) from canoe_calls where is_test is not true and coalesce(our_outcome, '') <> ''
            and (jsonb_array_length(coalesce(flags, '[]'::jsonb)) > 0 or suspicious_call)
            and created_at >= (t - 9)::timestamp at time zone 'America/Denver' and created_at < (t + 1)::timestamp at time zone 'America/Denver'),
    'flagged or suspicious scored calls match raw';
end $$;

-- ── The refresh queue still rebuilds (now on Mountain days) ──
delete from flag_daily where vertical = 'ZZTEST MT';
delete from rollup_refresh_requests where rollup = 'dashboard';
select request_rollup_refresh(((select today_mt from zz_t) - 3)::timestamp at time zone 'America/Denver', array['dashboard']);
do $$ begin
  perform run_rollup_refresh('dashboard');
  assert (select count(*) from flag_daily where vertical = 'ZZTEST MT') = 3, 'queue rebuilt flag_daily';
end $$;

-- ── Grants ──
do $$
declare
  fn text;
begin
  for fn in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'dashboard\_%' or p.proname = 'refresh_dashboard_daily') loop
    assert not has_function_privilege('anon', fn, 'execute'), 'anon cannot run ' || fn;
  end loop;
  assert has_function_privilege('authenticated', 'dashboard_flag_trend(date, date, text[], text[], text[], text[], boolean)', 'execute'), 'authenticated: flag trend';
  assert has_function_privilege('authenticated', 'dashboard_outcome_rows(date, date, text[], text[], text[])', 'execute'), 'authenticated: recreated outcome rows';
  assert not has_table_privilege('anon', 'flag_daily', 'select, insert, update, delete, truncate, references, trigger'), 'anon: flag_daily';
  assert has_table_privilege('authenticated', 'flag_daily', 'select'), 'authenticated reads flag_daily';
  assert not has_table_privilege('authenticated', 'flag_daily', 'insert, update, delete, truncate, references, trigger'), 'authenticated: read-only';
end $$;

set local role authenticated;
do $$
declare
  t date := (now() at time zone 'America/Denver')::date;
begin
  assert (dashboard_summary(t - 3, t, array['ZZTEST MT'])->'current'->>'calls')::int = 5, 'authenticated: summary';
  assert jsonb_array_length(dashboard_flags(t - 3, t, array['ZZTEST MT'])) = 4, 'authenticated: flags';
  assert dashboard_flag_trend(t - 3, t, array['ZZTEST MT']) is not null, 'authenticated: flag trend';
end $$;
reset role;

set local role anon;
do $$ begin
  begin
    perform dashboard_flags(current_date, current_date);
    raise exception 'anon must not run dashboard_flags';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
