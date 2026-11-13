-- ============================================================
-- Regression test for 057_agent_activity_team_overview.sql.
-- Run in the Supabase SQL Editor after 057. Everything runs in one transaction that is rolled
-- back, so it leaves no rows behind; raises on failure. Fixture ids start with 'zztest-' and
-- names with 'ZZTEST' so they can't collide with real data.
-- ============================================================
begin;

-- Fixtures: rollup days for two IVRs, one manager owning one advertiser + one publisher,
-- and flagged/unflagged/test/old calls on those accounts.
insert into agent_metrics_daily (ivr_name, day, raw) values
  ('ZZTEST IVR A', (now() at time zone 'UTC')::date - 40, 3),
  ('ZZTEST IVR A', (now() at time zone 'UTC')::date - 2,  1),
  ('ZZTEST IVR A', (now() at time zone 'UTC')::date - 1,  0),   -- zero-call day is not a call
  ('ZZTEST IVR B', (now() at time zone 'UTC')::date - 45, 2);

insert into account_managers (manager_name, manager_email) values ('ZZTEST Manager', 'zztest@example.invalid');
insert into account_manager_assignments (manager_id, account_name, account_type)
select id, x.n, x.t from account_managers, (values ('ZZTEST Adv', 'advertiser'), ('ZZTEST Pub', 'publisher')) x(n, t)
where manager_name = 'ZZTEST Manager';

insert into canoe_calls (id, ivr_name, publisher_name, advertiser_name, flags, is_test, created_at) values
  ('zztest-t1', 'ZZTEST IVR A', 'ZZTEST Pub',   'ZZTEST Adv',   '["angry_caller"]', false, now() - interval '1 day'),   -- both of the manager's accounts: counts once for the manager
  ('zztest-t2', 'ZZTEST IVR A', 'ZZTEST Other', 'ZZTEST Adv',   '["outbound_dial"]', false, now() - interval '2 days'),
  ('zztest-t3', 'ZZTEST IVR A', 'ZZTEST Pub',   'ZZTEST Other', '["geo_mismatch"]', null,  now() - interval '3 days'),
  ('zztest-t4', 'ZZTEST IVR A', 'ZZTEST Pub',   'ZZTEST Adv',   '[]',               false, now() - interval '1 day'),    -- not flagged
  ('zztest-t5', 'ZZTEST IVR A', 'ZZTEST Pub',   'ZZTEST Adv',   '["angry_caller"]', true,  now() - interval '1 day'),    -- test call
  ('zztest-t6', 'ZZTEST IVR A', 'ZZTEST Pub',   'ZZTEST Adv',   '["angry_caller"]', false, now() - interval '9 days');   -- outside the window

-- Run as a signed-in user so RLS applies (both functions are SECURITY INVOKER).
set local role authenticated;

-- 1) agent_last_call_days: newest day with raw > 0, per raw ivr_name.
do $$
declare today date := (now() at time zone 'UTC')::date;
begin
  assert (select last_day from agent_last_call_days() where ivr_name = 'ZZTEST IVR A') = today - 2,
    'IVR A last call should be today-2 (the zero-call day is ignored)';
  assert (select last_day from agent_last_call_days() where ivr_name = 'ZZTEST IVR B') = today - 45, 'IVR B last call';
  assert (select count(*) from agent_last_call_days() where ivr_name like 'ZZTEST%') = 2, 'one row per ivr_name';
end $$;

-- 2) team_overview: per-account and distinct per-manager flagged counts in the window.
do $$
declare
  r jsonb := team_overview(now() - interval '7 days');
  mid uuid := (select id from account_managers where manager_name = 'ZZTEST Manager');
begin
  assert (select (e->>'flagged')::int from jsonb_array_elements(r->'accounts') e
          where e->>'account_name' = 'ZZTEST Adv' and e->>'account_type' = 'advertiser') = 2, 'advertiser: t1 + t2';
  assert (select (e->>'flagged')::int from jsonb_array_elements(r->'accounts') e
          where e->>'account_name' = 'ZZTEST Pub' and e->>'account_type' = 'publisher') = 2, 'publisher: t1 + t3';
  assert (select (e->>'flagged')::int from jsonb_array_elements(r->'managers') e
          where e->>'manager_id' = mid::text) = 3, 'manager: t1, t2, t3 counted once each';
  assert not exists (select 1 from jsonb_array_elements(r->'accounts') e where e->>'account_name' = 'ZZTEST Other'),
    'unassigned accounts are not listed';
  assert jsonb_typeof(team_overview(now() + interval '1 day')->'accounts') = 'array', 'empty window still returns arrays';
end $$;

reset role;

-- 3) Grants: signed-in users only.
do $$ begin
  assert has_function_privilege('authenticated', 'agent_last_call_days()', 'execute'), 'authenticated can run agent_last_call_days';
  assert has_function_privilege('authenticated', 'team_overview(timestamptz)', 'execute'), 'authenticated can run team_overview';
  assert not has_function_privilege('anon', 'agent_last_call_days()', 'execute'), 'anon cannot run agent_last_call_days';
  assert not has_function_privilege('anon', 'team_overview(timestamptz)', 'execute'), 'anon cannot run team_overview';
end $$;

rollback;
