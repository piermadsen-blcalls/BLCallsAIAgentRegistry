-- ============================================================
-- Regression test for 060_new_ivr_detection.sql.
-- Run in the Supabase SQL Editor after 060. Everything runs inside one transaction that is
-- ROLLED BACK at the end, so it leaves no rows behind; raises on failure. Fixture names start
-- with 'ASCND AI Agent - ZZTEST' / 'ZZTEST' and ids with 'zztest-' so they can't collide with
-- real data. Real unregistered IVRs in the window get registered too, then rolled back.
-- ============================================================
begin;

insert into agents (ivr_name, name) values ('ASCND AI Agent - ZZTEST Known - Outgoing', 'ZZ Known');
insert into canoe_calls (id, ivr_name, ivr_id, is_test, created_at) values
  -- registered agent, then renamed (same ivr_id): healed into an alias, not registered
  ('zztest-n1',  'ASCND AI Agent - ZZTEST Known - Outgoing',             'ZZTEST-ID-K', false, now() - interval '2 days'),
  ('zztest-n2',  'ASCND AI Agent - ZZTEST Known_15550000001 - Outgoing', 'ZZTEST-ID-K', false, now() - interval '1 day'),
  -- brand-new IVR with an older call outside the window: registered, first seen 20 days ago, 3 calls
  ('zztest-n3',  'ASCND AI Agent - ZZTEST Fresh_15550000002 - Outgoing', 'ZZTEST-ID-F', false, now() - interval '20 days'),
  ('zztest-n4',  'ASCND AI Agent - ZZTEST Fresh_15550000002 - Outgoing', 'ZZTEST-ID-F', false, now() - interval '2 days'),
  ('zztest-n5',  'ASCND AI Agent - ZZTEST Fresh_15550000002 - Outgoing', 'ZZTEST-ID-F', false, now() - interval '1 day'),
  -- brand-new IVR renamed inside the window: one agent (newest name), the old name aliased to it
  ('zztest-n6',  'ASCND AI Agent - ZZTEST Twin - Outgoing',              'ZZTEST-ID-T', false, now() - interval '3 days'),
  ('zztest-n7',  'ASCND AI Agent - ZZTEST Twin_15550000003 - Outgoing',  'ZZTEST-ID-T', false, now() - interval '1 day'),
  -- no ivr_id: registered on its own
  ('zztest-n8',  'ASCND AI Agent - ZZTEST Door - Incoming',              null,          false, now() - interval '1 day'),
  -- not an AI agent IVR, a test call, and a name only seen before the window: never registered
  ('zztest-n9',  'ZZTEST Skip IVR',                                      'ZZTEST-ID-S', false, now() - interval '1 day'),
  ('zztest-n10', 'ASCND AI Agent - ZZTEST Testcall - Outgoing',          'ZZTEST-ID-X', true,  now() - interval '1 day'),
  ('zztest-n11', 'ASCND AI Agent - ZZTEST Old - Outgoing',               'ZZTEST-ID-O', false, now() - interval '20 days');

do $$
declare
  r      jsonb := check_new_ivrs(7);
  fresh  constant text := 'ASCND AI Agent - ZZTEST Fresh_15550000002 - Outgoing';
  twin   constant text := 'ASCND AI Agent - ZZTEST Twin_15550000003 - Outgoing';
  door   constant text := 'ASCND AI Agent - ZZTEST Door - Incoming';
  a      agents;
begin
  -- 1) What gets registered
  assert r->'registered' ? fresh, 'new IVR registered';
  assert r->'registered' ? twin,  'renamed new IVR registered under its newest name';
  assert r->'registered' ? door,  'new IVR without an ivr_id registered';
  assert not exists (select 1 from agents where ivr_name in (
    'ASCND AI Agent - ZZTEST Known_15550000001 - Outgoing', 'ASCND AI Agent - ZZTEST Twin - Outgoing',
    'ZZTEST Skip IVR', 'ASCND AI Agent - ZZTEST Testcall - Outgoing', 'ASCND AI Agent - ZZTEST Old - Outgoing')),
    'rename, older twin name, non-AI IVR, test call or out-of-window name registered';

  select * into a from agents where ivr_name = fresh;
  assert a.status = 'needs_setup', 'status needs_setup';
  assert a.name = 'ZZTEST Fresh', format('display name, got %s', a.name);
  assert a.first_seen_at = now() - interval '20 days', 'first seen = first call in all history';
  assert a.seen_calls = 3, format('seen_calls 3, got %s', a.seen_calls);
  assert a.vertical is null and a.routing_type = 'unknown', 'vertical left for setup';
  assert (select name from agents where ivr_name = door) = 'ZZTEST Door - Incoming', 'Incoming kept in the name';

  -- 2) Renames still heal first; a new IVR's other name is aliased to it, and its calls counted
  assert (select canonical_ivr_name from agent_ivr_aliases where ivr_name = 'ASCND AI Agent - ZZTEST Known_15550000001 - Outgoing')
         = 'ASCND AI Agent - ZZTEST Known - Outgoing', 'rename healed';
  assert (select canonical_ivr_name from agent_ivr_aliases where ivr_name = 'ASCND AI Agent - ZZTEST Twin - Outgoing') = twin,
    'older name of the new IVR aliased to it';
  assert (select seen_calls from agents where ivr_name = twin) = 2, 'seen_calls includes the alias';
  assert (select canonical_ivr_name from agent_canoe_ivr_ids where ivr_id = 'ZZTEST-ID-F') = fresh, 'new ivr_id learned';

  -- 3) Detection log: one row each, not emailed yet
  assert (select count(*) from new_ivr_detections where ivr_name in (fresh, twin, door)) = 3, 'detection rows';
  assert (select calls_at_detection from new_ivr_detections where ivr_name = fresh) = 3, 'calls at detection';
  assert not exists (select 1 from new_ivr_detections where ivr_name in (fresh, twin, door)
                     and (emailed_at is not null or emailed_to <> '{}')), 'not emailed yet';

  -- 4) Idempotent
  r := check_new_ivrs(7);
  assert r = '{"aliases_added": 0, "registered": []}'::jsonb, format('second run is a no-op, got %s', r);
end $$;

-- 5) The count follows new calls only while the agent needs setup; a deleted detection stays deleted.
insert into canoe_calls (id, ivr_name, ivr_id, is_test, created_at) values
  ('zztest-n12', 'ASCND AI Agent - ZZTEST Fresh_15550000002 - Outgoing', 'ZZTEST-ID-F', false, now()),
  ('zztest-n13', 'ASCND AI Agent - ZZTEST Twin_15550000003 - Outgoing',  'ZZTEST-ID-T', false, now()),
  ('zztest-n14', 'ASCND AI Agent - ZZTEST Door - Incoming',              null,          false, now());
update agents set status = 'live' where ivr_name = 'ASCND AI Agent - ZZTEST Twin_15550000003 - Outgoing';
delete from agents where ivr_name = 'ASCND AI Agent - ZZTEST Door - Incoming';
do $$
declare r jsonb := check_new_ivrs(7);
begin
  assert (select seen_calls from agents where ivr_name = 'ASCND AI Agent - ZZTEST Fresh_15550000002 - Outgoing') = 4, 'count refreshed';
  assert (select seen_calls from agents where ivr_name = 'ASCND AI Agent - ZZTEST Twin_15550000003 - Outgoing') = 2, 'set-up agent left alone';
  assert not (r->'registered' ? 'ASCND AI Agent - ZZTEST Door - Incoming'), 'deleted detection not re-registered';
end $$;

-- 6) Schedule and access
do $$ begin
  assert (select schedule from cron.job where jobname = 'check-new-ivrs') = '15 7 * * *', 'nightly check after the sync';
  assert (select command from cron.job where jobname = 'check-new-ivrs') like '%check_new_ivrs(7)%', 'nightly check command';
  assert not exists (select 1 from cron.job where jobname = 'heal-renamed-ivr-aliases'), '00:45 heal job removed';
  assert has_function_privilege('service_role', 'check_new_ivrs(int)', 'execute'), 'service_role can run the check';
  assert not has_function_privilege('anon', 'check_new_ivrs(int)', 'execute'), 'anon cannot run the check';
  assert not has_function_privilege('authenticated', 'check_new_ivrs(int)', 'execute'), 'authenticated cannot run the check';
  assert (select relrowsecurity from pg_class where oid = 'new_ivr_detections'::regclass), 'RLS on';
  assert not has_table_privilege('anon', 'new_ivr_detections', 'select,insert,update,delete,truncate'), 'closed to anon';
  assert not has_table_privilege('authenticated', 'new_ivr_detections', 'select,insert,update,delete,truncate'), 'closed to authenticated';
  assert has_column_privilege('authenticated', 'agents', 'first_seen_at', 'select'), 'page can read first_seen_at';
end $$;

rollback;
