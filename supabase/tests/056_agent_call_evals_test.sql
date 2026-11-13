-- ============================================================
-- Regression test for 056_agent_call_evals.sql.
-- Run in the Supabase SQL Editor after 056. Everything runs in one transaction that is rolled
-- back, so it leaves no rows behind; raises on failure. Fixture ids start with 'zztest-' and the
-- IVR name contains 'ZZTEST' so they can't collide with real data.
-- ============================================================
begin;

-- Fixtures: 2 pending agent calls, and 4 the queue must skip (already scored, test call,
-- empty transcript, not an ASCND IVR).
insert into canoe_calls (id, ivr_name, created_at, result, ascnd_transcript, is_test) values
  ('zztest-ae1', 'ASCND ZZTEST Agent', now() - interval '3 hours', 'abandoned', 'bot:Hi\nhuman:Ants.', null),
  ('zztest-ae2', 'ASCND ZZTEST Agent', now() - interval '2 hours', 'connected', 'bot:Hi\nhuman:Roof.', false),
  ('zztest-ae3', 'ASCND ZZTEST Agent', now() - interval '1 hour',  'abandoned', 'bot:Hi', null),
  ('zztest-ae4', 'ASCND ZZTEST Agent', now() - interval '1 hour',  'abandoned', 'bot:Hi\nhuman:Yes.', true),
  ('zztest-ae5', 'ASCND ZZTEST Agent', now() - interval '1 hour',  'abandoned', '', null),
  ('zztest-ae6', 'ZZTEST Plain IVR',   now() - interval '1 hour',  'abandoned', 'bot:Hi\nhuman:Yes.', null);
insert into agent_call_evals (call_id, ivr_name, call_at, verdict, decision, decision_verdict, dropoff_stage, eval, prompt_version)
values ('zztest-ae3', 'ASCND ZZTEST Agent', now() - interval '1 hour', 'no_conversation', 'caller_left', 'not_applicable', 'intro',
        '{"code_decided": true}', 'agent-test');

-- 1) Queue: newest first, skips scored / test / empty / non-ASCND calls.
do $$ begin
  assert (select array_agg(id) from agent_eval_pending(now() - interval '1 day', 100000) where id like 'zztest-%')
         = array['zztest-ae2', 'zztest-ae1'], 'agent_eval_pending returns exactly the 2 pending fixtures, newest first';
  assert (select count(*) from agent_eval_pending(now() - interval '150 minutes', 100000) where id like 'zztest-%') = 1,
    'since_ts bounds the queue';
end $$;

-- 2) Rollup counts, including a reviewer's "AI got this wrong" mark.
insert into agent_call_evals (call_id, ivr_name, call_at, verdict, decision, decision_verdict, dropoff_stage, understanding, script, eval, prompt_version) values
  ('zztest-ae1', 'ASCND ZZTEST Agent', now() - interval '3 hours', 'major', 'rejected',    'over_reject', 'none', 'mishears', 'good',
   '{"intent_match": "mismatch"}', 'agent-test'),
  ('zztest-ae2', 'ASCND ZZTEST Agent', now() - interval '2 hours', 'minor', 'transferred', 'correct',     'none', 'smooth',   'too_long',
   '{"intent_match": "match"}', 'agent-test');
insert into call_reviews (call_id, ivr_name, reviewed_by, eval_disagree) values ('zztest-ae1', 'ASCND ZZTEST Agent', 'zztest@example.com', true);
do $$
declare m record;
begin
  select * into m from agent_eval_metrics(now() - interval '1 day', now() + interval '1 hour') where ivr_name = 'ASCND ZZTEST Agent';
  assert m.scored = 3 and m.conversations = 2, 'scored / conversations';
  assert m.good = 0 and m.minor = 1 and m.major = 1 and m.no_conversation = 1 and m.unclear = 0, 'verdict counts';
  assert m.over_reject = 1 and m.over_transfer = 0, 'decision verdict counts';
  assert m.drop_intro = 1 and m.drop_mid = 0 and m.drop_transfer = 0, 'no_conversation counts as an intro drop-off';
  assert m.mishears = 1 and m.too_long = 1 and m.intent_mismatch = 1, 'finding counts';
  assert m.disagree = 1, 'eval_disagree counted';
  assert not exists (select 1 from agent_eval_pending(now() - interval '1 day', 100000) where id like 'zztest-%'),
    'scored calls leave the queue';
  assert (select scored from agent_eval_metrics(now() - interval '150 minutes', now() + interval '1 hour')
          where ivr_name = 'ASCND ZZTEST Agent') = 2, 'window bounds the rollup';
end $$;

-- 3) Signed-in users read evals and the rollup through RLS.
set local role authenticated;
do $$ begin
  assert (select count(*) from agent_call_evals where call_id like 'zztest-%') = 3, 'authenticated reads agent_call_evals';
  assert (select scored from agent_eval_metrics(now() - interval '1 day', now() + interval '1 hour')
          where ivr_name = 'ASCND ZZTEST Agent') = 3, 'authenticated runs agent_eval_metrics';
end $$;
reset role;

-- 4) Access: writes stay service-role only; anon gets nothing; the FK cascades.
do $$ begin
  assert (select relrowsecurity from pg_class where oid = 'agent_call_evals'::regclass), 'RLS on agent_call_evals';
  assert (select relrowsecurity from pg_class where oid = 'agent_eval_jobs'::regclass), 'RLS on agent_eval_jobs';
  assert has_table_privilege('authenticated', 'agent_call_evals', 'select'), 'authenticated can select evals';
  assert not has_table_privilege('authenticated', 'agent_call_evals', 'insert,update,delete,truncate'), 'authenticated cannot write evals';
  assert not has_table_privilege('anon', 'agent_call_evals', 'select,insert,update,delete,truncate'), 'evals closed to anon';
  assert not has_table_privilege('authenticated', 'agent_eval_jobs', 'select,insert,update,delete,truncate'), 'jobs closed to authenticated';
  assert not has_table_privilege('anon', 'agent_eval_jobs', 'select,insert,update,delete,truncate'), 'jobs closed to anon';
  assert has_function_privilege('service_role', 'agent_eval_pending(timestamptz, int)', 'execute'), 'service_role reads the queue';
  assert not has_function_privilege('authenticated', 'agent_eval_pending(timestamptz, int)', 'execute'), 'authenticated cannot read the queue';
  assert not has_function_privilege('anon', 'agent_eval_pending(timestamptz, int)', 'execute'), 'anon cannot read the queue';
  assert has_function_privilege('authenticated', 'agent_eval_metrics(timestamptz, timestamptz)', 'execute'), 'authenticated runs the rollup';
  assert not has_function_privilege('anon', 'agent_eval_metrics(timestamptz, timestamptz)', 'execute'), 'anon cannot run the rollup';
  assert (select confdeltype from pg_constraint where conrelid = 'agent_call_evals'::regclass and contype = 'f') = 'c',
    'evals cascade with their call';
end $$;

rollback;
