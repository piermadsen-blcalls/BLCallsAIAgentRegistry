-- ============================================================
-- Regression test for 070_suspicious_tab_v2.sql (run after 069 and 070; 069's own test describes
-- the state before 070 and no longer passes once 070 is applied).
-- Everything runs inside one transaction that is ROLLED BACK at the end; raises on failure.
-- Requests are played the way PostgREST does it: SET ROLE authenticated plus the JWT claims.
-- Fixtures use verticals 'ZZTEST *', ids 'zztest-v2-*', agents 'ZZTEST V2 *' and numbers
-- 555-010-8xxx; the person is a@zztest.example. Run it off production (PGlite or a branch).
-- ============================================================
begin;

-- ── The catalog after 070: new functions signed-in only, Same script gone, verdicts kept ──
do $$
declare f text;
begin
  foreach f in array array['suspicious_repeat_callers(timestamptz, timestamptz, int, boolean, int)',
      'suspicious_odd_timing(timestamptz, timestamptz, int, int)'] loop
    assert not has_function_privilege('anon', 'public.' || f, 'execute'), 'anon cannot run ' || f;
    assert has_function_privilege('authenticated', 'public.' || f, 'execute'), 'signed-in users run ' || f;
  end loop;
  assert to_regprocedure('public.suspicious_conversions(timestamptz, timestamptz, int, int)') is null, 'suspicious_conversions is gone';
  assert to_regprocedure('public.suspicious_similar_transcripts(real)') is null, 'suspicious_similar_transcripts is gone';
  assert to_regprocedure('public.refresh_script_matches(int, real, int, int)') is null, 'refresh_script_matches is gone';
  assert to_regprocedure('public.refresh_dashboard_nightly()') is null, 'the nightly procedure is gone';
  assert to_regclass('public.script_matches') is null, 'script_matches is gone';
  assert to_regclass('public.coached_verdicts') is not null, 'verdicts are kept';
  assert (select command from cron.job where jobname = 'refresh-dashboard-rollup') = 'select public.refresh_dashboard_daily(45)', 'the job is back on the dashboard rollup alone';
  assert (select schedule from cron.job where jobname = 'refresh-dashboard-rollup') = '45 7 * * *', 'same time as before';
  assert (select count(*) from cron.job where command ilike '%script_matches%' or command ilike '%dashboard_nightly%') = 0, 'nothing runs the matching';
  assert pg_get_function_result('public.suspicious_repeat_callers(timestamptz, timestamptz, int, boolean, int)'::regprocedure) !~ 'conversions',
    'the conversions count is gone from repeat callers';
end $$;

-- A verdict given on the Same script sub-tab is still a valid row (the source check is unchanged).
insert into coached_verdicts (caller, decided_by, verdict, source, call_id) values ('5550108999', 'a@zztest.example', 'coached', 'script', 'zztest-v2-old');
do $$ begin assert (select source from coached_verdicts where caller = '5550108999') = 'script', 'script verdicts stay'; end $$;

-- ── Fixtures ──
-- Odd timing. 'ZZTEST V2 A' has 24 connected calls with a duration in the last 30 days: 21 from
-- 10 days ago (290-299, 300, 300, 313-321; one through the alias 'ZZTEST V2 A old') and, in the
-- last day, a 900 s call that is not a conversion, a 330 s call and a 240 s call. Sorted, the 12th
-- and 13th are both 300, so A's typical is 300 s: 900 is 200% over, 330 is 10% over, 240 is 20%
-- under. Also in the last day, out of the list: a duplicate-result 1200 s call (not connected), a
-- 1200 s test call and a connected call with no duration. 'ZZTEST V2 B' has 3 calls (100, 100 and
-- a 500 s appointment), so B is measured against the vertical, as is the no-agent 1000 s call:
-- 'ZZTEST V2' holds A's 24 + B's 3 + that one = 28 calls, median 300 s (14th and 15th).
insert into agent_ivr_aliases (ivr_name, canonical_ivr_name) values ('ZZTEST V2 A old', 'ZZTEST V2 A');
insert into canoe_calls (id, created_at, is_test, called_from, vertical_name, publisher_name, advertiser_name, ivr_name, duration, our_outcome, result, flags, suspicious_call)
select 'zztest-v2-a' || lpad(i::text, 2, '0'), now() - interval '10 days', false, '+1555010' || (8100 + i)::text, 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv',
  case when i = 1 then 'ZZTEST V2 A old' else 'ZZTEST V2 A' end,
  case when i <= 10 then 300 - i when i <= 12 then 300 else 300 + i end,   -- 290..299, 300, 300, 313..321
  null, 'connected', '[]', false
from generate_series(1, 21) i;
insert into canoe_calls (id, created_at, is_test, called_from, vertical_name, publisher_name, advertiser_name, ivr_name, duration, our_outcome, result, flags, suspicious_call)
values
  ('zztest-v2-long', now() - interval '2 hours', false, '+15550108201', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST V2 A', 900,  'undecided',   'connected', '[]', false),
  ('zztest-v2-bit',  now() - interval '3 hours', false, '+15550108202', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST V2 A', 330,  'appointment', 'connected', '[]', false),
  ('zztest-v2-short',now() - interval '4 hours', false, '+15550108203', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST V2 A', 240,  'sale',        'connected', '[]', false),
  ('zztest-v2-dup',  now() - interval '2 hours', false, '+15550108204', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST V2 A', 1200, null,          'duplicate', '[]', false),
  ('zztest-v2-test', now() - interval '2 hours', true,  '+15550108205', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST V2 A', 1200, null,          'connected', '[]', false),
  ('zztest-v2-nodur',now() - interval '2 hours', false, '+15550108206', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST V2 A', null, null,          'connected', '[]', false),
  ('zztest-v2-b01',  now() - interval '10 days', false, '+15550108301', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST V2 B', 100,  null,          'connected', '[]', false),
  ('zztest-v2-b02',  now() - interval '10 days', false, '+15550108302', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST V2 B', 100,  null,          'connected', '[]', false),
  ('zztest-v2-b03',  now() - interval '2 hours', false, '+15550108303', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST V2 B', 500,  'appointment', 'connected', '[]', false),
  ('zztest-v2-noagt',now() - interval '2 hours', false, '+15550108401', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', null,          1000, null,          'connected', '[]', false),
  -- A's 40-day-old 5000 s call is outside the 30 days "typical" rests on: it must not move the median
  ('zztest-v2-old',  now() - interval '40 days', false, '+15550108501', 'ZZTEST V2', 'ZZTEST Pub A', 'ZZTEST Adv', 'ZZTEST V2 A', 5000, null,          'connected', '[]', false);

-- Repeat callers. 8601 (two formats) has 2 connected calls across 2 ZIPs in the last day, paid 50/30
-- and 40/25; a third call 20 days ago in a third format, paid 10/0, counts for the money but not the
-- window; an unpaid abandoned call counts zero; a 40-day-old paid call is outside the 30 days.
insert into canoe_calls (id, created_at, is_test, called_from, zip, vertical_name, publisher_name, advertiser_name, duration, our_outcome, result, flags, suspicious_call, advertiser_payin, publisher_payout)
values
  ('zztest-v2-r01', now() - interval '3 hours',  false, '+1 (555) 010-8601', '30301', 'ZZTEST V2 R', 'ZZTEST Pub A', 'ZZTEST Adv', 200, 'appointment', 'connected', '[]', false, 50, 30),
  ('zztest-v2-r02', now() - interval '2 hours',  false, '15550108601',       '60601', 'ZZTEST V2 R', 'ZZTEST Pub B', 'ZZTEST Adv', 150, null,          'connected', '[]', false, 40, 25),
  ('zztest-v2-r03', now() - interval '20 days',  false, '555-010-8601',      '30301', 'ZZTEST V2 R', 'ZZTEST Pub A', 'ZZTEST Adv', 100, null,          'connected', '[]', false, 10, 0),
  ('zztest-v2-r04', now() - interval '1 hours',  false, '+15550108601',      '30301', 'ZZTEST V2 R', 'ZZTEST Pub A', 'ZZTEST Adv', 0,   null,          'abandoned', '[]', false, 0, 0),
  ('zztest-v2-r05', now() - interval '40 days',  false, '+15550108601',      '30301', 'ZZTEST V2 R', 'ZZTEST Pub A', 'ZZTEST Adv', 100, null,          'connected', '[]', false, 99, 1),
  -- 8602: paid nothing, paid out 5 on one call (a duplicate): negative margin
  ('zztest-v2-r06', now() - interval '3 hours',  false, '+15550108602',      '30301', 'ZZTEST V2 R', 'ZZTEST Pub A', 'ZZTEST Adv', 100, null,          'connected', '[]', false, 0, 0),
  ('zztest-v2-r07', now() - interval '2 hours',  false, '+15550108602',      '60601', 'ZZTEST V2 R', 'ZZTEST Pub B', 'ZZTEST Adv', 100, null,          'connected', '[]', false, 0, 0),
  ('zztest-v2-r08', now() - interval '1 hours',  false, '+15550108602',      '30301', 'ZZTEST V2 R', 'ZZTEST Pub A', 'ZZTEST Adv', 6,   null,          'duplicate', '[]', false, 0, 5);

-- ── Signed-in reads ──
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000007001","email":"a@zztest.example"}', true);
do $$
declare
  r record;
  n int;
  ids text[];
begin
  -- Odd timing, last day, every % (min_pct 0 still drops calls under their typical)
  select array_agg(id order by pct_above desc) into ids
  from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute', -1000) where vertical_name = 'ZZTEST V2';
  assert ids = array['zztest-v2-noagt', 'zztest-v2-long', 'zztest-v2-b03', 'zztest-v2-bit', 'zztest-v2-short'],
    format('every connected call with a duration, highest %% over typical first: %s', ids);
  select * into r from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute') where id = 'zztest-v2-long';
  assert r.pct_above = 200 and r.typical_secs = 300 and r.typical_n = 24 and r.typical_from = 'agent' and r.agent_key = 'ZZTEST V2 A',
    format('an agent with 20+ calls in the last 30 days: its own median (aliases folded, the 40-day-old call out): %s', row_to_json(r));
  assert r.caller = '5550108201' and r.our_outcome = 'undecided' and r.total >= 3, format('row details, and not only conversions: %s', row_to_json(r));
  select * into r from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute') where id = 'zztest-v2-b03';
  assert r.pct_above = 66 and r.typical_secs = 300 and r.typical_n = 28 and r.typical_from = 'vertical',
    format('an agent with under 20 calls: the vertical''s median: %s', row_to_json(r));
  select * into r from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute') where id = 'zztest-v2-noagt';
  assert r.pct_above = 233 and r.typical_from = 'vertical' and r.agent_key is null, format('no IVR name: the vertical''s median: %s', row_to_json(r));
  select * into r from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute') where id = 'zztest-v2-bit';
  assert r.pct_above = 10, format('10%% over: %s', row_to_json(r));
  assert not exists (select 1 from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute') where id = 'zztest-v2-short'), 'min_pct 0: a call under its typical is out';
  assert not exists (select 1 from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute', -1000) where id in ('zztest-v2-dup', 'zztest-v2-test', 'zztest-v2-nodur')),
    'not connected, test traffic and no duration are out';
  assert not exists (select 1 from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute', -1000) where id like 'zztest-v2-a%'), 'window: the 10-day-old calls are out of the list';
  select count(*) into n from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute', 100) where vertical_name = 'ZZTEST V2';
  assert n = 2, format('min_pct 100: the 200%% and 233%% calls, got %s', n);
  select count(*) into n from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute', 200) where vertical_name = 'ZZTEST V2';
  assert n = 2, 'min_pct is inclusive';
  assert (select count(*) from suspicious_odd_timing(now() - interval '1 day', now() + interval '1 minute', 0, 1)) = 1, 'max_rows';
  -- A 30-day window lists the 10-day-old calls too, against the same typical
  select * into r from suspicious_odd_timing(now() - interval '30 days', now() + interval '1 minute', -1000) where id = 'zztest-v2-a11';
  assert r.pct_above = 0 and r.typical_secs = 300 and r.typical_from = 'agent', format('a 30-day window: same typical: %s', row_to_json(r));

  -- Repeat callers: the 30-day money, grouped across number formats; no conversions column
  select * into r from suspicious_repeat_callers(now() - interval '1 day', now() + interval '1 minute') where caller = '5550108601';
  assert r.calls = 2 and r.distinct_zips = 2 and r.distinct_publishers = 2 and r.flagged = 0, format('8601 in the window: %s', row_to_json(r));
  assert r.payin_30d = 100 and r.payout_30d = 55 and r.margin_30d = 45, format('30-day money: 50+40+10 in, 30+25+0 out, the 40-day-old call out: %s', row_to_json(r));
  assert r.call_ids = array['zztest-v2-r02', 'zztest-v2-r01'] and r.total >= 2, format('calls newest first: %s', row_to_json(r));
  select * into r from suspicious_repeat_callers(now() - interval '1 day', now() + interval '1 minute') where caller = '5550108602';
  assert r.payin_30d = 0 and r.payout_30d = 5 and r.margin_30d = -5, format('a payout on an unconnected call counts; margin can be negative: %s', row_to_json(r));
  assert not exists (select 1 from suspicious_repeat_callers(now() - interval '1 day', now() + interval '1 minute', 3) where caller = '5550108601'), 'min_calls';
end $$;

-- ── Signed out: nothing ──
reset role;
set local role anon;
do $$
begin
  begin perform suspicious_odd_timing(now() - interval '1 day', now()); raise exception 'zz: anon ran odd timing';
  exception when insufficient_privilege then null; end;
  begin perform suspicious_repeat_callers(now() - interval '1 day', now()); raise exception 'zz: anon ran repeat callers';
  exception when insufficient_privilege then null; end;
end $$;

rollback;
