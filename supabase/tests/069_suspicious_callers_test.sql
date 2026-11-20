-- ============================================================
-- Regression test for 069_suspicious_callers.sql.
-- Everything runs inside one transaction that is ROLLED BACK at the end; raises on failure.
-- Requests are played the way PostgREST does it: SET ROLE authenticated plus the JWT claims.
-- Fixtures use verticals 'ZZTEST *', ids 'zztest-s*' and numbers 555-010-7xxx; people are
-- a@zztest.example and b@zztest.example. Run it off production (PGlite or a branch):
-- refresh_script_matches() rebuilds the real script_matches before the rollback.
-- (The nightly procedure COMMITs, so it cannot run inside this transaction; its shape and the
-- cron job are checked here, its failure isolation in the PGlite harness.)
-- ============================================================
begin;

-- ── Grants, RLS, the nightly job ──
do $$
declare f text;
begin
  assert (select relrowsecurity from pg_class where oid = 'public.coached_verdicts'::regclass), 'RLS on coached_verdicts';
  assert (select relrowsecurity from pg_class where oid = 'public.script_matches'::regclass), 'RLS on script_matches';
  assert not has_table_privilege('anon', 'public.coached_verdicts', 'select, insert, update, delete'), 'anon: no verdicts';
  assert not has_table_privilege('anon', 'public.script_matches', 'select, insert, update, delete'), 'anon: no matches';
  assert not has_table_privilege('authenticated', 'public.script_matches', 'insert, update, delete, truncate'), 'matches are read-only';
  assert not has_table_privilege('authenticated', 'public.coached_verdicts', 'truncate, references, trigger'), 'no truncate';
  foreach f in array array['suspicious_caller_key(text)', 'coached_verdict_set(text, text, text, text)', 'coached_verdict_clear(text)',
      'suspicious_repeat_callers(timestamptz, timestamptz, int, boolean, int)', 'suspicious_conversions(timestamptz, timestamptz, int, int)',
      'suspicious_similar_transcripts(real)'] loop
    assert not has_function_privilege('anon', 'public.' || f, 'execute'), 'anon cannot run ' || f;
    assert has_function_privilege('authenticated', 'public.' || f, 'execute'), 'signed-in users run ' || f;
  end loop;
  assert not has_function_privilege('authenticated', 'public.refresh_script_matches(int, real, int, int)', 'execute'), 'refresh is not for the page';
  assert not has_function_privilege('anon', 'public.refresh_script_matches(int, real, int, int)', 'execute'), 'refresh is not for anon';
  assert not has_function_privilege('authenticated', 'public.refresh_dashboard_nightly()', 'execute'), 'nightly is not for the page';

  assert (select command from cron.job where jobname = 'refresh-dashboard-rollup') = 'call public.refresh_dashboard_nightly()', 'job calls the procedure';
  assert (select schedule from cron.job where jobname = 'refresh-dashboard-rollup') = '45 7 * * *', 'same time as before';
  assert (select count(*) from cron.job where command ilike '%refresh_script_matches%') = 0, 'no separate matching job';
  assert (select prokind = 'p' and not prosecdef and proconfig is null from pg_proc where oid = 'public.refresh_dashboard_nightly'::regproc),
    'a procedure without SECURITY DEFINER or SET (either forbids its COMMIT)';
  assert (select prosrc ~ 'refresh_dashboard_daily\(45\);\s+commit;' and prosrc ~ 'exception when others' from pg_proc where oid = 'public.refresh_dashboard_nightly'::regproc),
    'dashboard refresh, COMMIT, then the matching in a block that catches its errors';

  assert suspicious_caller_key('+1 (555) 010-7001') = '5550107001', 'US number without the 1';
  assert suspicious_caller_key('5550107001') = '5550107001', 'ten digits as is';
  assert suspicious_caller_key('+44 20 7946 0958') = '442079460958', 'other countries keep their digits';
  assert suspicious_caller_key('anonymous') is null and suspicious_caller_key('12345') is null and suspicious_caller_key(null) is null, 'no key';
end $$;

-- ── Fixtures ──
insert into canoe_calls (id, created_at, is_test, called_from, zip, vertical_name, publisher_name, advertiser_name,
                         duration, our_outcome, result, flags, suspicious_call, transcription)
values
  -- Repeat callers: 7001 spans 2 ZIPs and 2 publishers; 7002 repeats in one place; 7003 is test traffic
  ('zztest-s01', now() - interval '3 hours', false, '+1 (555) 010-7001', '30301', 'ZZTEST Pest', 'ZZTEST Pub A', 'ZZTEST Adv', 200, 'appointment', 'connected', '[]', false, null),
  ('zztest-s02', now() - interval '2 hours', false, '15550107001',       '60601', 'ZZTEST Pest', 'ZZTEST Pub B', 'ZZTEST Adv', 150, null,          'connected', '["coached_call"]', false, null),
  ('zztest-s03', now() - interval '1 hours', false, '+15550107001',      '99999', 'ZZTEST Pest', 'ZZTEST Pub C', 'ZZTEST Adv', 0,   null,          'abandoned', '[]', false, null),
  ('zztest-s04', now() - interval '3 hours', false, '+15550107002',      '30301', 'ZZTEST Pest', 'ZZTEST Pub A', 'ZZTEST Adv', 100, null,          'connected', '[]', false, null),
  ('zztest-s05', now() - interval '2 hours', false, '+15550107002',      '30301', 'ZZTEST Pest', 'ZZTEST Pub A', 'ZZTEST Adv', 100, null,          'connected', '[]', false, null),
  ('zztest-s06', now() - interval '3 hours', true,  '+15550107003',      '30301', 'ZZTEST Pest', 'ZZTEST Pub A', 'ZZTEST Adv', 100, null,          'connected', '[]', false, null),
  ('zztest-s07', now() - interval '2 hours', true,  '+15550107003',      '60601', 'ZZTEST Pest', 'ZZTEST Pub B', 'ZZTEST Adv', 100, null,          'connected', '[]', false, null),
  -- Timing, 'ZZTEST Timing': 11 conversions, median 400 s; one 120 s (fast), one 900 s (125% above)
  ('zztest-t01', now() - interval '5 hours', false, '+15550107101', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 120, 'appointment', 'connected', '[]', false, null),
  ('zztest-t02', now() - interval '5 hours', false, '+15550107102', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 900, 'sale',        'connected', '[]', false, null),
  ('zztest-t03', now() - interval '5 hours', false, '+15550107103', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 400, 'appointment', 'connected', '[]', false, null),
  ('zztest-t04', now() - interval '5 hours', false, '+15550107104', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 400, 'appointment', 'connected', '[]', false, null),
  ('zztest-t05', now() - interval '5 hours', false, '+15550107105', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 400, 'appointment', 'connected', '[]', false, null),
  ('zztest-t06', now() - interval '5 hours', false, '+15550107106', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 400, 'appointment', 'connected', '[]', false, null),
  ('zztest-t07', now() - interval '5 hours', false, '+15550107107', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 400, 'appointment', 'connected', '[]', false, null),
  ('zztest-t08', now() - interval '5 hours', false, '+15550107108', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 400, 'sale',        'connected', '[]', false, null),
  ('zztest-t09', now() - interval '5 hours', false, '+15550107109', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 400, 'sale',        'connected', '[]', false, null),
  ('zztest-t10', now() - interval '5 hours', false, '+15550107110', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 400, 'sale',        'connected', '[]', false, null),
  ('zztest-t11', now() - interval '5 hours', false, '+15550107111', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 400, 'sale',        'connected', '[]', false, null),
  ('zztest-t12', now() - interval '5 hours', false, '+15550107112', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 50,  'voicemail',   'connected', '[]', false, null),
  ('zztest-t13', now() - interval '5 hours', true,  '+15550107113', null, 'ZZTEST Timing', 'ZZTEST Pub A', 'ZZTEST Adv', 60,  'sale',        'connected', '[]', false, null),
  -- 'ZZTEST Tiny': 2 conversions; the 100 s one is still fast, the 1000 s one can't be "long" (n < 10)
  ('zztest-t21', now() - interval '5 hours', false, '+15550107121', null, 'ZZTEST Tiny', 'ZZTEST Pub A', 'ZZTEST Adv', 100,  'sale', 'connected', '[]', false, null),
  ('zztest-t22', now() - interval '5 hours', false, '+15550107122', null, 'ZZTEST Tiny', 'ZZTEST Pub A', 'ZZTEST Adv', 1000, 'sale', 'connected', '[]', false, null);

-- Same script. x1/x2: two callers, the same script with small wording differences per line.
-- x5 = x1 word for word in another vertical. x6/x7: one caller twice. x3: unrelated.
-- x9/x10/x11: the same office recording (3 identical lines) plus a few words each, and x4 the
-- recording alone: identical on the raw text, but the recording lines are dropped and too little
-- is left, so none of them match.
create temp table zz_script (id text, caller text, vertical text, t text);
insert into zz_script values
  ('zztest-x01', '+15550107201', 'ZZTEST Script',
   E'Hi yes I am calling because I have a really bad termite problem in my kitchen\nThey are coming out of the baseboards near the sink and the back door every night\nI need somebody to come out and spray the whole house as soon as you possibly can\nMy neighbor had the same thing last month and the company fixed it in one visit\nCan you book me for tomorrow morning and tell me how much the whole job costs'),
  ('zztest-x02', '+15550107202', 'ZZTEST Script',
   E'Hi yes I am calling because I have a really bad termite problem in my kitchen right\nThey are coming out of the baseboards near the sink and the back door every night now\nI need somebody to come out and spray the whole house as soon as you possibly can please\nMy neighbor had the same thing last month and the company fixed it in one visit honestly\nCan you book me for tomorrow morning and tell me how much the whole job costs okay'),
  ('zztest-x05', '+15550107205', 'ZZTEST Other',
   E'Hi yes I am calling because I have a really bad termite problem in my kitchen\nThey are coming out of the baseboards near the sink and the back door every night\nI need somebody to come out and spray the whole house as soon as you possibly can\nMy neighbor had the same thing last month and the company fixed it in one visit\nCan you book me for tomorrow morning and tell me how much the whole job costs'),
  ('zztest-x06', '+15550107206', 'ZZTEST Script',
   E'Good afternoon I would like to get a quote for ant treatment around the garage and the driveway\nWe just moved in two weeks ago and there are little black ants in every single room of the place\nThe previous owners said they never had a problem but I do not believe that for a second'),
  ('zztest-x07', '1 555 010 7206', 'ZZTEST Script',
   E'Good afternoon I would like to get a quote for ant treatment around the garage and the driveway\nWe just moved in two weeks ago and there are little black ants in every single room of the place\nThe previous owners said they never had a problem but I do not believe that for a second at all'),
  ('zztest-x03', '+15550107203', 'ZZTEST Script',
   E'Hello there my mother is elderly and lives alone and she found mice droppings in the pantry yesterday\nShe is worried about her cat getting sick from any poison so we want something humane and safe\nWhat days of the week do your technicians work in the north side of town near the hospital'),
  ('zztest-x09', '+15550107209', 'ZZTEST Script',
   E'Thank you for calling Acme Pest and Lawn this call may be recorded for quality assurance and training purposes today\nIf you would like to schedule a new appointment press one if you have any other questions press two or stay on the line\nAll of our representatives are currently assisting other customers please stay on the line and your call will be answered\nyeah I need help'),
  ('zztest-x10', '+15550107210', 'ZZTEST Script',
   E'Thank you for calling Acme Pest and Lawn this call may be recorded for quality assurance and training purposes today\nIf you would like to schedule a new appointment press one if you have any other questions press two or stay on the line\nAll of our representatives are currently assisting other customers please stay on the line and your call will be answered\nhello is anyone there'),
  ('zztest-x11', '+15550107211', 'ZZTEST Script',
   E'Thank you for calling Acme Pest and Lawn this call may be recorded for quality assurance and training purposes today\nIf you would like to schedule a new appointment press one if you have any other questions press two or stay on the line\nAll of our representatives are currently assisting other customers please stay on the line and your call will be answered\nok bye'),
  ('zztest-x04', '+15550107204', 'ZZTEST Script',
   E'Thank you for calling Acme Pest and Lawn this call may be recorded for quality assurance and training purposes today\nIf you would like to schedule a new appointment press one if you have any other questions press two or stay on the line\nAll of our representatives are currently assisting other customers please stay on the line and your call will be answered');
insert into canoe_calls (id, created_at, is_test, called_from, vertical_name, publisher_name, advertiser_name, duration, result, flags, suspicious_call, transcription)
select id, now() - interval '1 day', false, caller, vertical, 'ZZTEST Pub A', 'ZZTEST Adv', 200, 'connected', '[]', false, t from zz_script;
-- An old copy of x1 (outside the 7 days) and a test-traffic copy: neither is matched.
insert into canoe_calls (id, created_at, is_test, called_from, vertical_name, publisher_name, advertiser_name, duration, result, flags, suspicious_call, transcription)
select v.id, now() - v.age, v.test, '+15550107299', 'ZZTEST Script', 'ZZTEST Pub A', 'ZZTEST Adv', 200, 'connected', '[]', false, t
from zz_script, (values ('zztest-x12', interval '9 days', false), ('zztest-x13', interval '1 day', true)) v(id, age, test)
where zz_script.id = 'zztest-x01';
-- An agent on one long conversion and one side of a script pair (the page's agent picks).
update canoe_calls set ivr_name = 'ZZTEST IVR' where id in ('zztest-t02', 'zztest-x01');

do $$ begin assert refresh_script_matches() >= 2, 'the refresh returns the pair count'; end $$;
do $$ begin assert refresh_script_matches() >= 2, 're-runnable: replaces, not appends'; end $$;

-- ── Signed-in reads ──
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006901","email":"A@zztest.example"}', true);
do $$
declare
  r record;
  n int;
begin
  -- Repeat callers
  select * into r from suspicious_repeat_callers(now() - interval '1 day', now() + interval '1 minute') where caller = '5550107001';
  assert r.calls = 2 and r.distinct_zips = 2 and r.distinct_publishers = 2 and r.distinct_verticals = 1, format('7001 grouped across number formats, connected only: %s', row_to_json(r));
  assert r.zips = array['30301', '60601'] and r.conversions = 1 and r.flagged = 1, format('7001 details: %s', row_to_json(r));
  assert r.call_ids = array['zztest-s02', 'zztest-s01'] and r.called_from is not null and r.total >= 1, format('7001 calls, newest first: %s', row_to_json(r));
  assert not exists (select 1 from suspicious_repeat_callers(now() - interval '1 day', now() + interval '1 minute') where caller = '5550107002'), 'cross only: one ZIP/vertical/publisher is out';
  assert exists (select 1 from suspicious_repeat_callers(now() - interval '1 day', now() + interval '1 minute', 2, false) where caller = '5550107002' and calls = 2), 'all repeats when cross_only is off';
  assert not exists (select 1 from suspicious_repeat_callers(now() - interval '1 day', now() + interval '1 minute', 2, false) where caller = '5550107003'), 'test traffic is out';
  assert not exists (select 1 from suspicious_repeat_callers(now() - interval '1 day', now() + interval '1 minute', 3, false) where caller in ('5550107001', '5550107002')), 'min_calls';
  assert not exists (select 1 from suspicious_repeat_callers(now() - interval '150 minutes', now() + interval '1 minute') where caller = '5550107001'), 'window: one call left';

  -- Odd timing: long conversions, longest first
  select count(*) into n from suspicious_conversions(now() - interval '1 day', now() + interval '1 minute', 600) where vertical_name in ('ZZTEST Timing', 'ZZTEST Tiny');
  assert n = 2, format('900 s and 1000 s at 600 s+, got %s', n);
  select * into r from suspicious_conversions(now() - interval '1 day', now() + interval '1 minute', 600) where id = 'zztest-t02';
  assert r.pct_above = 125 and r.typical_secs = 400 and r.vertical_n = 11 and r.caller = '5550107102' and r.ivr_name = 'ZZTEST IVR' and r.total >= 2,
    format('long row with its vertical''s typical and its agent: %s', row_to_json(r));
  select * into r from suspicious_conversions(now() - interval '1 day', now() + interval '1 minute', 600) where id = 'zztest-t22';
  assert r.vertical_n = 2 and r.typical_secs = 550 and r.pct_above = 81 and r.ivr_name is null, format('a small vertical still gets its (rough) typical: %s', row_to_json(r));
  assert (select id from suspicious_conversions(now() - interval '1 day', now() + interval '1 minute', 600) where vertical_name in ('ZZTEST Timing', 'ZZTEST Tiny') limit 1) = 'zztest-t22', 'longest first';
  assert not exists (select 1 from suspicious_conversions(now() - interval '1 day', now() + interval '1 minute', 950) where id = 'zztest-t02'), 'min_secs';
  assert exists (select 1 from suspicious_conversions(now() - interval '1 day', now() + interval '1 minute', 1000) where id = 'zztest-t22'), 'min_secs is inclusive';
  assert exists (select 1 from suspicious_conversions(now() - interval '1 day', now() + interval '1 minute', 0) where id = 'zztest-t01'), 'nothing is "too fast" any more: every conversion over min_secs';
  assert not exists (select 1 from suspicious_conversions(now() - interval '1 day', now() + interval '1 minute', 0) where id in ('zztest-t12', 'zztest-t13')), 'only conversions, no test traffic';
  assert (select count(*) from suspicious_conversions(now() - interval '1 day', now() + interval '1 minute', 0, 1)) = 1, 'max_rows';

  -- Same script
  select * into r from suspicious_similar_transcripts() where call_id_a = 'zztest-x01' and call_id_b = 'zztest-x02';
  assert r.similarity >= 0.55 and not r.same_caller and r.vertical = 'ZZTEST Script', format('x1/x2 match: %s', row_to_json(r));
  assert r.a_caller = '5550107201' and r.b_caller = '5550107202' and r.a_vertical = 'ZZTEST Script' and r.b_duration = 200, format('both calls'' details: %s', row_to_json(r));
  assert r.a_ivr_name = 'ZZTEST IVR' and r.b_ivr_name is null, format('each call''s agent: %s', row_to_json(r));
  select * into r from suspicious_similar_transcripts() where call_id_a = 'zztest-x06' and call_id_b = 'zztest-x07';
  assert r.same_caller, format('x6/x7: one caller (two number formats): %s', row_to_json(r));
  assert not exists (select 1 from suspicious_similar_transcripts() where 'zztest-x05' in (call_id_a, call_id_b)), 'same vertical only';
  assert not exists (select 1 from suspicious_similar_transcripts() where 'zztest-x03' in (call_id_a, call_id_b)), 'unrelated transcript';
  assert not exists (select 1 from suspicious_similar_transcripts() where call_id_a in ('zztest-x04', 'zztest-x09', 'zztest-x10', 'zztest-x11')
                                                                     or call_id_b in ('zztest-x04', 'zztest-x09', 'zztest-x10', 'zztest-x11')), 'a shared recording is not a script';
  assert not exists (select 1 from suspicious_similar_transcripts() where 'zztest-x12' in (call_id_a, call_id_b) or 'zztest-x13' in (call_id_a, call_id_b)), 'last 7 days, no test traffic';
  assert not exists (select 1 from suspicious_similar_transcripts(0.99) where call_id_a = 'zztest-x01' and call_id_b = 'zztest-x02'), 'min_sim';
  assert not exists (select 1 from script_matches where similarity < 0.30), 'nothing stored under 30% (the page''s slider floor)';

  -- ── Verdicts: A records, changes; the number's format doesn't matter ──
  perform coached_verdict_set('+1 (555) 010-7001', 'coached', 'repeat', 'zztest-s01');
  perform coached_verdict_set('15550107001', 'not_coached', 'script', 'zztest-s02');
  select * into r from coached_verdicts where caller = '5550107001';
  assert r.decided_by = 'a@zztest.example' and r.verdict = 'not_coached' and r.source = 'script' and r.call_id = 'zztest-s02',
    format('one verdict per (caller, person), latest wins, email lower case: %s', row_to_json(r));
  assert (select count(*) from coached_verdicts where caller = '5550107001') = 1, 'one row for A';
  begin perform coached_verdict_set('5550107001', 'maybe'); raise exception 'zz: bad verdict accepted';
  exception when check_violation then null; end;
  begin perform coached_verdict_set('12345', 'coached'); raise exception 'zz: no caller accepted';
  exception when not_null_violation then null; end;
end $$;

-- ── B sees A's verdict, adds their own, and cannot change or remove A's ──
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006902","email":"b@zztest.example"}', true);
do $$
declare n int;
begin
  assert exists (select 1 from coached_verdicts where caller = '5550107001' and decided_by = 'a@zztest.example'), 'team-wide read';
  perform coached_verdict_set('5550107001', 'unknown', 'repeat', null);
  assert (select count(*) from coached_verdicts where caller = '5550107001') = 2, 'one per person';
  update coached_verdicts set verdict = 'coached' where caller = '5550107001' and decided_by = 'a@zztest.example';
  get diagnostics n = row_count;
  assert n = 0, 'B cannot update A''s verdict';
  delete from coached_verdicts where caller = '5550107001' and decided_by = 'a@zztest.example';
  get diagnostics n = row_count;
  assert n = 0, 'B cannot delete A''s verdict';
  begin
    insert into coached_verdicts (caller, decided_by, verdict) values ('5550107002', 'a@zztest.example', 'coached');
    raise exception 'zz: B planted a verdict on A';
  exception when insufficient_privilege then null; end;
  perform coached_verdict_clear('+15550107001');
  assert not exists (select 1 from coached_verdicts where caller = '5550107001' and decided_by = 'b@zztest.example'), 'B removed their own';
  assert (select verdict from coached_verdicts where caller = '5550107001' and decided_by = 'a@zztest.example') = 'not_coached', 'A''s verdict untouched';
end $$;

-- ── A removes their own ──
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006901","email":"a@zztest.example"}', true);
do $$
begin
  perform coached_verdict_clear('5550107001');
  assert not exists (select 1 from coached_verdicts where caller = '5550107001'), 'A removed theirs';
end $$;

-- ── Signed out: nothing ──
reset role;
set local role anon;
do $$
begin
  begin perform 1 from coached_verdicts limit 1; raise exception 'zz: anon read verdicts';
  exception when insufficient_privilege then null; end;
  begin perform 1 from script_matches limit 1; raise exception 'zz: anon read matches';
  exception when insufficient_privilege then null; end;
  begin perform suspicious_repeat_callers(now() - interval '1 day', now()); raise exception 'zz: anon ran repeat callers';
  exception when insufficient_privilege then null; end;
  begin perform coached_verdict_set('5550107001', 'coached'); raise exception 'zz: anon set a verdict';
  exception when insufficient_privilege then null; end;
end $$;

rollback;
