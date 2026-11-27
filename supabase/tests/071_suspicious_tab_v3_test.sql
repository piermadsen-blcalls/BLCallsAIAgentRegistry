-- ============================================================
-- Regression test for 071_suspicious_tab_v3.sql (run after 069, 070 and 071; 070's own test asserts
-- suspicious_odd_timing exists and no longer passes once 071 is applied).
-- Everything runs inside one transaction that is ROLLED BACK at the end; raises on failure.
-- Requests are played the way PostgREST does it: SET ROLE authenticated plus the JWT claims.
-- Fixtures use verticals 'ZZTEST *', ids 'zztest-v3-*', agents 'ZZTEST V3 *' and made-up numbers
-- 555-010-9xxx; the people are a@zztest.example and b@zztest.example. Run it off production
-- (PGlite or a branch).
-- ============================================================
begin;

-- ── The catalog after 071 ──
do $$
declare f text;
begin
  foreach f in array array['canoe_block_set(text)', 'canoe_block_clear(text)',
      'suspicious_transcript_search(timestamptz, timestamptz, text[], text, int)',
      'suspicious_decided_callers(text)', 'suspicious_coached_calls(int)'] loop
    assert not has_function_privilege('anon', 'public.' || f, 'execute'), 'anon cannot run ' || f;
    assert has_function_privilege('authenticated', 'public.' || f, 'execute'), 'signed-in users run ' || f;
  end loop;
  assert to_regprocedure('public.suspicious_odd_timing(timestamptz, timestamptz, int, int)') is null, 'suspicious_odd_timing is gone';
  assert to_regclass('public.canoe_blocks') is not null, 'canoe_blocks exists';
  assert (select relrowsecurity from pg_class where oid = 'public.canoe_blocks'::regclass), 'canoe_blocks has RLS on';
  assert not has_table_privilege('anon', 'public.canoe_blocks', 'select'), 'anon cannot read canoe_blocks';
  assert to_regclass('public.canoe_calls_caller_key_idx') is not null, 'the caller-key index exists';
  assert to_regclass('public.coached_verdicts') is not null, 'verdicts are kept';
end $$;

-- The new verdict sources are valid rows; an unknown source is still refused.
insert into coached_verdicts (caller, decided_by, verdict, source, call_id, decided_at) values
  ('5550109901', 'b@zztest.example', 'coached', 'keywords', 'zztest-v3-k1', now() - interval '2 days'),
  ('5550109902', 'b@zztest.example', 'unknown', 'decided',  null,           now() - interval '2 days'),
  ('5550109903', 'b@zztest.example', 'coached', 'timing',   'zztest-v3-t1', now() - interval '2 days');
do $$
begin
  begin
    insert into coached_verdicts (caller, decided_by, verdict, source) values ('5550109999', 'b@zztest.example', 'coached', 'nope');
    raise exception 'zz: an unknown source was accepted';
  exception when check_violation then null; end;
end $$;

-- ── Fixtures ──
-- Caller 9901 (coached, by b): three connected calls across two ZIPs, two verticals and two
-- publishers in the last 30 days (two number formats), one 40-day-old connected call outside the 30
-- days, and one abandoned call (counts for the money, not for the "connected calls"). Caller 9903
-- (coached, by b, from Odd timing): one connected call. Caller 9902 (unknown): one call. Caller 9904
-- (not coached, by a): one call, must appear nowhere. Caller 9905: no verdict, mentions spiders.
insert into agent_ivr_aliases (ivr_name, canonical_ivr_name) values ('ZZTEST V3 Pest old', 'ZZTEST V3 Pest');
insert into canoe_calls (id, created_at, is_test, called_from, zip, vertical_name, publisher_name, advertiser_name, ivr_name, duration, our_outcome, our_summary, result, flags, suspicious_call, advertiser_payin, publisher_payout, transcription)
values
  ('zztest-v3-k1', now() - interval '1 hour',  false, '+15550109901',      '30301', 'ZZTEST Pest',    'ZZTEST Pub A', 'ZZTEST Adv 1', 'ZZTEST V3 Pest',     250, 'appointment', 'Spiders and cockroaches.', 'connected', '[]', false, 50, 30,
   E'Agent: Thanks for calling.\nCaller: I have SPIDERS in the house, and cockroaches in the kitchen.\nAgent: What is your ZIP?'),
  ('zztest-v3-k2', now() - interval '2 hours', false, '555-010-9901',      '60601', 'ZZTEST Roofing', 'ZZTEST Pub B', 'ZZTEST Adv 2', 'ZZTEST V3 Roof',     240, 'quoted',      'Roof leak quote.',         'connected', '[]', false, 40, 25,
   E'Agent: Thanks for calling.\nCaller: I have a leak in my roof and I want a quote. No spiders here.'),
  ('zztest-v3-k3', now() - interval '3 days',  false, '+15550109901',      '30301', 'ZZTEST Pest',    'ZZTEST Pub A', 'ZZTEST Adv 1', 'ZZTEST V3 Pest old', 200, null,          null,                       'connected', '[]', false, 10, 0,
   'Caller: spiders again, 100% sure, and cockroaches_too.'),
  ('zztest-v3-k4', now() - interval '40 days', false, '+15550109901',      '30301', 'ZZTEST Pest',    'ZZTEST Pub A', 'ZZTEST Adv 1', 'ZZTEST V3 Pest',     100, null,          null,                       'connected', '[]', false, 99, 1,
   'Caller: spiders and cockroaches, long ago.'),
  ('zztest-v3-k5', now() - interval '90 minutes', false, '+15550109901',      '30301', 'ZZTEST Pest',    'ZZTEST Pub A', 'ZZTEST Adv 1', 'ZZTEST V3 Pest',     0,   null,          null,                       'abandoned', '[]', false, 0, 5,
   null),
  ('zztest-v3-t1', now() - interval '5 hours', false, '+15550109903',      '77001', 'ZZTEST Pest',    'ZZTEST Pub A', 'ZZTEST Adv 1', 'ZZTEST V3 Pest',     900, 'appointment', 'Termites.',                'connected', '[]', false, 20, 10,
   'Caller: I think I have termites.'),
  ('zztest-v3-u1', now() - interval '6 hours', false, '+15550109902',      '19101', 'ZZTEST HVAC',    'ZZTEST Pub C', 'ZZTEST Adv 3', 'ZZTEST V3 HVAC',     300, null,          null,                       'connected', '[]', false, 0, 0,
   'Caller: my AC is broken.'),
  ('zztest-v3-n1', now() - interval '7 hours', false, '+15550109904',      '19101', 'ZZTEST HVAC',    'ZZTEST Pub C', 'ZZTEST Adv 3', 'ZZTEST V3 HVAC',     300, null,          null,                       'connected', '[]', false, 0, 0,
   'Caller: furnace tune-up, no bugs.'),
  ('zztest-v3-s1', now() - interval '8 hours', false, '+15550109905',      '98101', 'ZZTEST Pest',    'ZZTEST Pub B', 'ZZTEST Adv 1', 'ZZTEST V3 Pest',     130, 'quoted',      'Spiders in a garage.',     'connected', '[]', false, 0, 0,
   'Caller: we keep finding spiders in the garage. Agent: any other pests? Caller: no, just the spiders.'),
  -- out of every list: a duplicate-result call (not connected), a test call, and a call with no transcript
  ('zztest-v3-x1', now() - interval '1 hour',  false, '+15550109906',      '98101', 'ZZTEST Pest',    'ZZTEST Pub B', 'ZZTEST Adv 1', 'ZZTEST V3 Pest',     6,   null,          null,                       'duplicate', '[]', false, 0, 0,
   'spiders cockroaches'),
  ('zztest-v3-x2', now() - interval '1 hour',  true,  '+15550109907',      '98101', 'ZZTEST Pest',    'ZZTEST Pub B', 'ZZTEST Adv 1', 'ZZTEST V3 Pest',     200, null,          null,                       'connected', '[]', false, 0, 0,
   'spiders cockroaches'),
  ('zztest-v3-x3', now() - interval '1 hour',  false, '+15550109908',      '98101', 'ZZTEST Pest',    'ZZTEST Pub B', 'ZZTEST Adv 1', 'ZZTEST V3 Pest',     200, null,          null,                       'connected', '[]', false, 0, 0,
   null);
insert into coached_verdicts (caller, decided_by, verdict, source, call_id) values
  ('5550109901', 'a@zztest.example', 'not_coached', 'repeat', 'zztest-v3-k1'),   -- a disagrees: any Agree still counts
  ('5550109904', 'a@zztest.example', 'not_coached', 'repeat', 'zztest-v3-n1');

-- ── Signed in as a: the Canoe tick, the searches, the lists ──
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000007001","email":"A@zztest.example"}', true);
do $$
declare
  r record;
  n int;
  ids text[];
begin
  -- Blocked in Canoe: one tick per number, any format, with who and when; ticking again moves it to you
  perform canoe_block_set('+1 (555) 010-9901');
  select * into r from canoe_blocks where caller = '5550109901';
  assert r.blocked_by = 'a@zztest.example' and r.blocked_at > now() - interval '1 minute', format('the tick is recorded in lower case: %s', row_to_json(r));
  perform canoe_block_set('5550109901');
  assert (select count(*) from canoe_blocks where caller = '5550109901') = 1, 'one tick per number';
  begin
    insert into canoe_blocks (caller, blocked_by) values ('5550109903', 'b@zztest.example');
    raise exception 'zz: a tick in someone else''s name was accepted';
  exception when insufficient_privilege or check_violation then null; end;

  -- Transcript keywords: AND, capitals, part of a word, newest first, a snippet, connected calls only
  select array_agg(id order by created_at desc) into ids from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['spider']);
  assert ids = array['zztest-v3-k1', 'zztest-v3-k2', 'zztest-v3-s1', 'zztest-v3-k3'],
    format('"spider" finds SPIDERS and spiders, newest first, not the duplicate, test or 40-day-old calls: %s', ids);
  select array_agg(id order by created_at desc) into ids from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['Spiders', ' cockroaches ']);
  assert ids = array['zztest-v3-k1', 'zztest-v3-k3'], format('every keyword must match (AND), whitespace trimmed: %s', ids);
  select array_agg(id) into ids from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['spiders', 'cockroaches'], 'ZZTEST V3 Pest');
  assert ids = array['zztest-v3-k1', 'zztest-v3-k3'], format('agent plus keywords (the alias folds into the agent): %s', ids);
  select array_agg(id) into ids from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['spiders'], 'ZZTEST V3 Roof');
  assert ids = array['zztest-v3-k2'], format('another agent: %s', ids);
  select array_agg(id) into ids from suspicious_transcript_search(now() - interval '1 day', now() + interval '1 minute', array['spiders']);
  assert ids = array['zztest-v3-k1', 'zztest-v3-k2', 'zztest-v3-s1'], format('the window: %s', ids);
  select array_agg(id) into ids from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['100%']);
  assert ids = array['zztest-v3-k3'], format('%% in a keyword is literal: %s', ids);
  select array_agg(id) into ids from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['cockroaches_too']);
  assert ids = array['zztest-v3-k3'], format('_ in a keyword is literal: %s', ids);
  assert (select count(*) from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['_'])) = 1, 'a lone _ matches only the transcript with an underscore';
  assert (select count(*) from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['', '  '])) = 0, 'blank keywords find nothing';
  assert (select count(*) from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['spider'], null, 2)) = 2, 'max_rows';
  select * into r from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['cockroaches']) where id = 'zztest-v3-k1';
  assert r.total = 2 and r.caller = '5550109901' and r.agent_key = 'ZZTEST V3 Pest' and r.our_summary = 'Spiders and cockroaches.' and r.snippet like '%cockroaches in the kitchen%' and r.snippet not like E'%\n%',
    format('row fields and a one-line snippet around the first keyword: %s', row_to_json(r));
  select * into r from suspicious_transcript_search(now() - interval '30 days', now() + interval '1 minute', array['ZIP']) where id = 'zztest-v3-k1';
  assert r.snippet like '…%' and r.snippet not like '%…', format('a snippet cut at the start says so: %s', r.snippet);

  -- Decided: coached = every caller anyone marked Agree, even with a Disagree from someone else
  select * into r from suspicious_decided_callers('coached') where caller = '5550109901';
  assert r.calls = 5 and r.calls_30d = 3 and r.total >= 2, format('9901: every synced call, 3 connected in the last 30 days: %s', row_to_json(r));
  assert r.zips_30d = array['30301', '60601'] and r.verticals_30d = array['ZZTEST Pest', 'ZZTEST Roofing'] and r.publishers_30d = array['ZZTEST Pub A', 'ZZTEST Pub B'],
    format('9901 30-day ZIPs, verticals and publishers: %s', row_to_json(r));
  assert r.payin_30d = 100 and r.payout_30d = 60 and r.margin_30d = 40, format('9901 30-day money over every call (the abandoned one too), the 40-day-old call out: %s', row_to_json(r));
  assert r.call_ids = array['zztest-v3-k1', 'zztest-v3-k5', 'zztest-v3-k2', 'zztest-v3-k3', 'zztest-v3-k4'], format('every call id newest first: %s', r.call_ids);
  assert r.blocked_by = 'a@zztest.example' and r.blocked_at is not null, format('the Canoe tick: %s', row_to_json(r));
  assert jsonb_array_length(r.verdicts) = 2 and r.verdicts -> 0 ->> 'by' = 'b@zztest.example' and r.verdicts -> 0 ->> 'verdict' = 'coached'
    and r.verdicts -> 1 ->> 'verdict' = 'not_coached' and (r.verdicts -> 0 ->> 'at') is not null, format('verdicts: who, what, when, oldest first: %s', r.verdicts);
  assert r.verticals = array['ZZTEST Pest', 'ZZTEST Roofing'] and r.called_from is not null, format('verticals across all time: %s', row_to_json(r));
  select * into r from suspicious_decided_callers('coached') where caller = '5550109903';
  assert r.calls = 1 and r.calls_30d = 1 and r.blocked_by is null and r.zips_30d = array['77001'] and r.margin_30d = 10,
    format('a coached caller with one call (from Odd timing) gets the same pieces: %s', row_to_json(r));
  assert not exists (select 1 from suspicious_decided_callers('coached') where caller in ('5550109902', '5550109904', '5550109905')), 'unknown, not_coached and undecided callers are not in the coached list';
  select * into r from suspicious_decided_callers('unknown') where caller = '5550109902';
  assert r.calls = 1 and r.total >= 1 and r.verdicts -> 0 ->> 'verdict' = 'unknown', format('the unknown list: %s', row_to_json(r));
  assert (select count(*) from suspicious_decided_callers('not_coached')) >= 1, 'any verdict value can be listed';

  -- Coached calls: one row per call of every coached caller, every result, no transcript column
  select array_agg(id order by caller, created_at desc) into ids from suspicious_coached_calls() where caller like '55501099%';
  assert ids = array['zztest-v3-k1', 'zztest-v3-k5', 'zztest-v3-k2', 'zztest-v3-k3', 'zztest-v3-k4', 'zztest-v3-t1'], format('coached calls: %s', ids);
  select * into r from suspicious_coached_calls() where id = 'zztest-v3-k3';
  assert r.agent_key = 'ZZTEST V3 Pest' and r.ivr_name = 'ZZTEST V3 Pest old' and r.zip = '30301' and r.duration = 200 and r.result = 'connected' and r.total >= 6,
    format('call fields with the canonical agent: %s', row_to_json(r));
  assert pg_get_function_result('public.suspicious_coached_calls(int)'::regprocedure) !~ 'transcription|recording', 'no transcript or recording link in the export rows';
  assert (select count(*) from suspicious_coached_calls(2)) = 2, 'max_rows';

  -- Untick: anyone signed in can clear a tick
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000007002","email":"b@zztest.example"}', true);
  perform canoe_block_clear('+15550109901');
  assert (select count(*) from canoe_blocks where caller = '5550109901') = 0, 'b unticked a''s tick';
  select * into r from suspicious_decided_callers('coached') where caller = '5550109901';
  assert r.blocked_by is null, 'the list shows the untick';
end $$;

-- ── Signed out: nothing ──
reset role;
set local role anon;
do $$
begin
  begin perform canoe_block_set('5550109901'); raise exception 'zz: anon ticked a block';
  exception when insufficient_privilege then null; end;
  begin perform suspicious_transcript_search(now() - interval '1 day', now(), array['spiders']); raise exception 'zz: anon searched transcripts';
  exception when insufficient_privilege then null; end;
  begin perform suspicious_decided_callers('coached'); raise exception 'zz: anon read the decided list';
  exception when insufficient_privilege then null; end;
  begin perform suspicious_coached_calls(); raise exception 'zz: anon read the coached calls';
  exception when insufficient_privilege then null; end;
  begin perform (select count(*) from canoe_blocks); raise exception 'zz: anon read canoe_blocks';
  exception when insufficient_privilege then null; end;
end $$;

rollback;
