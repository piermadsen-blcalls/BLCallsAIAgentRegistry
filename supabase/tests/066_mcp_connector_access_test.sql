-- ============================================================
-- Regression test for 066_mcp_connector_access.sql.
-- Everything runs inside one transaction that is ROLLED BACK at the end; raises on failure.
-- Each request is played the way PostgREST does it: SET ROLE authenticated plus the JWT claims.
-- Fixtures: auth users/sessions with ids 00000000-0000-4000-8000-0000000066xx, calls 'zztest-mcp*'.
-- Run it off production (PGlite or a branch): it writes fixture rows into auth.users/sessions.
-- On PGlite, apply 066 as a non-superuser postgres, as on Supabase: a superuser skips the schema
-- CREATE check behind 066's owner change (the merged 066 failed on prod for that, 2026-11-20).
-- ============================================================
begin;

insert into auth.users (id, email, banned_until) values
  ('00000000-0000-4000-8000-000000006601', 'zztest-mcp-a@example.com', null),
  ('00000000-0000-4000-8000-000000006602', 'zztest-mcp-b@example.com', null),
  ('00000000-0000-4000-8000-000000006603', 'zztest-mcp-banned@example.com', now() + interval '1 day');
insert into auth.sessions (id, user_id, not_after, oauth_client_id) values
  ('00000000-0000-4000-8000-0000000066a1', '00000000-0000-4000-8000-000000006601', null, '00000000-0000-4000-8000-0000000066c1'),
  ('00000000-0000-4000-8000-0000000066a2', '00000000-0000-4000-8000-000000006602', null, null),
  ('00000000-0000-4000-8000-0000000066a3', '00000000-0000-4000-8000-000000006603', null, null),
  ('00000000-0000-4000-8000-0000000066a4', '00000000-0000-4000-8000-000000006602', now() - interval '1 minute', null);
insert into agent_ivr_aliases (ivr_name, canonical_ivr_name) values ('ZZTEST MCP Old IVR', 'ZZTEST MCP IVR');
insert into outcome_weights (outcome, pub_score, adv_score) values ('zztest_mcp_outcome', 1, 1);
-- 06:30 UTC on Nov 10 is Nov 9 in Mountain Time.
insert into canoe_calls (id, created_at, ivr_name, publisher_name, advertiser_name, vertical_name, called_from,
                         result, connect_duration, advertiser_payin, publisher_payout, our_outcome, flags, suspicious_call, is_test)
values
  ('zztest-mcp1', '2026-11-10 06:30:00+00', 'ZZTEST MCP Old IVR', 'ZZTEST Pub', 'ZZTEST Adv', 'ZZTEST V', '+15550106601',
   'connected', 95, 40, 12, 'appointment', '["geo_mismatch"]', false, false),
  ('zztest-mcp2', '2026-11-10 18:00:00+00', 'ZZTEST MCP IVR', 'ZZTEST Pub', null, 'ZZTEST V', '+15550106602',
   'abandoned', 0, 0, 0, 'caller_hangup', '[]', false, false),
  ('zztest-mcp3', '2026-11-11 18:00:00+00', 'ZZTEST MCP IVR', 'ZZTEST Pub', 'ZZTEST Adv', 'ZZTEST V', '+15550106603',
   'connected', 30, 0, 5, null, '[]', true, false);

-- ── Catalog: mcp_reader reaches only the mcp views, read-only; entry points are authenticated-only ──
do $$
begin
  assert has_table_privilege('mcp_reader', 'mcp.calls', 'select'), 'mcp_reader reads mcp.calls';
  assert not has_table_privilege('mcp_reader', 'mcp.outcome_weights', 'update'), 'mcp_reader cannot write a view';
  assert not has_table_privilege('mcp_reader', 'public.canoe_calls', 'select'), 'mcp_reader cannot read canoe_calls directly';
  assert not has_table_privilege('mcp_reader', 'public.mcp_query_log', 'select'), 'mcp_reader cannot read the query log';
  assert not has_schema_privilege('authenticated', 'mcp', 'usage'), 'signed-in users cannot reach the mcp views directly';
  assert not has_schema_privilege('authenticated', 'mcp_private', 'usage'), 'signed-in users cannot reach mcp_private';
  assert has_function_privilege('authenticated', 'public.mcp_run_sql(text, integer, boolean, text)', 'execute'), 'authenticated runs mcp_run_sql';
  assert not has_function_privilege('anon', 'public.mcp_run_sql(text, integer, boolean, text)', 'execute'), 'anon cannot run mcp_run_sql';
  assert not has_function_privilege('anon', 'public.mcp_whoami()', 'execute'), 'anon cannot run mcp_whoami';
  assert not has_function_privilege('anon', 'public.mcp_describe()', 'execute'), 'anon cannot run mcp_describe';
  assert not has_function_privilege('authenticated', 'mcp_private.exec_readonly(text, integer, boolean)', 'execute'), 'exec_readonly is private';
  assert (select pg_get_userbyid(proowner) from pg_proc where oid = 'mcp_private.exec_readonly(text, integer, boolean)'::regprocedure) = 'mcp_reader', 'exec_readonly runs as mcp_reader';
  assert not has_schema_privilege('mcp_reader', 'mcp_private', 'create'), 'the CREATE needed for the owner change is revoked again';
  assert (select relrowsecurity from pg_class where oid = 'public.mcp_query_log'::regclass), 'RLS on mcp_query_log';
  assert not has_table_privilege('authenticated', 'public.mcp_query_log', 'insert, update, delete, truncate'), 'nobody signed in writes the log';
end $$;

-- ── User A through the connector (OAuth token: has client_id) ──
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006601","session_id":"00000000-0000-4000-8000-0000000066a1","email":"zztest-mcp-a@example.com","client_id":"00000000-0000-4000-8000-0000000066c1","is_anonymous":false}', true);

do $$
declare
  r jsonb;
  row1 jsonb;
begin
  r := public.mcp_whoami();
  assert r ->> 'email' = 'zztest-mcp-a@example.com' and r ->> 'client_id' = '00000000-0000-4000-8000-0000000066c1', format('whoami: %s', r);

  -- Reads and the registry definitions
  r := public.mcp_run_sql($q$select count(*) as n from calls where id like 'zztest-mcp%'$q$);
  assert r -> 'rows' -> 0 ->> 'n' = '3' and (r ->> 'truncated')::boolean = false, format('count: %s', r);
  r := public.mcp_run_sql($q$select id, day, agent, connected, paid, scored, qualified, flagged from calls where id like 'zztest-mcp%' order by id$q$);
  row1 := r -> 'rows' -> 0;
  assert row1 ->> 'day' = '2026-11-09', format('06:30 UTC is the previous Mountain day: %s', row1);
  assert row1 ->> 'agent' = 'ZZTEST MCP IVR', format('alias resolved: %s', row1);
  assert (row1 ->> 'connected')::boolean and (row1 ->> 'paid')::boolean and (row1 ->> 'qualified')::boolean and (row1 ->> 'flagged')::boolean, format('call 1: %s', row1);
  assert not (r -> 'rows' -> 1 ->> 'connected')::boolean and not (r -> 'rows' -> 1 ->> 'qualified')::boolean
     and (r -> 'rows' -> 1 ->> 'scored')::boolean, format('call 2: %s', r -> 'rows' -> 1);
  assert (r -> 'rows' -> 2 ->> 'flagged')::boolean and not (r -> 'rows' -> 2 ->> 'scored')::boolean, format('call 3 suspicious, unscored: %s', r -> 'rows' -> 2);
  r := public.mcp_run_sql($q$with x as (select publisher_name, count(*) filter (where connected) as c from calls where id like 'zztest-mcp%' group by 1) select * from x$q$);
  assert r -> 'rows' -> 0 ->> 'c' = '2', format('WITH query: %s', r);

  -- Row cap
  r := public.mcp_run_sql($q$select id from calls where id like 'zztest-mcp%' order by id$q$, 2);
  assert jsonb_array_length(r -> 'rows') = 2 and (r ->> 'truncated')::boolean and (r ->> 'row_count')::int = 2, format('cap: %s', r);

  -- Plan only
  r := public.mcp_run_sql($q$select id from calls where id = 'zztest-mcp1'$q$, 10, true);
  assert jsonb_typeof(r -> 'plan') = 'array' and r -> 'rows' is null, format('explain: %s', r);

  -- Writes are impossible: read-only transaction, and mcp_reader has no write privilege
  -- 25006 = refused by the read-only transaction, before the privilege check (mcp_reader has no
  -- UPDATE either: see the catalog checks above).
  r := public.mcp_run_sql($q$with u as (update outcome_weights set pub_score = 99 where outcome = 'zztest_mcp_outcome' returning 1) select * from u$q$);
  assert r ->> 'sqlstate' = '25006', format('update through a view: %s', r);
  r := public.mcp_run_sql($q$with d as (delete from calls where id = 'zztest-mcp1' returning id) select * from d$q$);
  assert r ? 'error', format('delete through a view: %s', r);
  r := public.mcp_run_sql($q$select 1 as one; delete from outcome_weights where outcome = 'zztest_mcp_outcome'$q$);
  assert r ? 'error', format('second statement: %s', r);

  -- Nothing outside the mcp views
  r := public.mcp_run_sql($q$select id from public.canoe_calls limit 1$q$);
  assert r ->> 'sqlstate' = '42501', format('canoe_calls directly: %s', r);
  r := public.mcp_run_sql($q$select manager_email from public.account_managers limit 1$q$);
  assert r ->> 'sqlstate' = '42501', format('another public table: %s', r);
  r := public.mcp_run_sql($q$select id from canoe_calls limit 1$q$);
  assert r ->> 'sqlstate' = '42P01', format('search_path is mcp only: %s', r);
  r := public.mcp_run_sql($q$select * from public.mcp_query_log$q$);
  assert r ->> 'sqlstate' = '42501', format('query log: %s', r);

  -- Refused before running (raised)
  begin perform public.mcp_run_sql('insert into outcome_weights values (''x'', 1, 1)'); raise exception 'zz: insert accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.mcp_run_sql('select pg_sleep(0)'); raise exception 'zz: pg_sleep accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.mcp_run_sql('select pg_advisory_lock(1)'); raise exception 'zz: advisory lock accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.mcp_run_sql('select set_config(''transaction_read_only'', ''off'', true)'); raise exception 'zz: set_config accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.mcp_run_sql('select query_to_xml(''select 1'', true, true, '''')'); raise exception 'zz: query_to_xml accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.mcp_run_sql('select U&"\0070g_sleep"(0)'); raise exception 'zz: unicode escape accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.mcp_run_sql('   '); raise exception 'zz: empty accepted';
  exception when invalid_parameter_value then null; end;

  assert current_setting('transaction_read_only') = 'off', 'the caller''s transaction is not left read-only';

  -- Describe
  r := public.mcp_describe();
  assert exists (select 1 from jsonb_array_elements(r -> 'views') v where v ->> 'name' = 'calls'
                   and exists (select 1 from jsonb_array_elements(v -> 'columns') c where c ->> 'name' = 'qualified' and c ->> 'description' like '%appointment%')),
    'describe lists calls with column meanings';
  assert exists (select 1 from jsonb_array_elements(r -> 'outcomes') o where o ->> 'outcome' = 'zztest_mcp_outcome'), 'describe lists outcomes';

  -- Log: every query that ran (or failed while running) is logged with the OAuth client; the ones
  -- refused before running are not (they raise, so the request fails)
  assert (select count(*) from public.mcp_query_log where user_id = '00000000-0000-4000-8000-000000006601') = 12,
    format('log rows: %s', (select count(*) from public.mcp_query_log where user_id = '00000000-0000-4000-8000-000000006601'));
  assert (select count(*) from public.mcp_query_log where client_id = '00000000-0000-4000-8000-0000000066c1' and error is not null) = 7, 'errors logged';
  assert (select row_count from public.mcp_query_log where query like 'select count(*) as n%') = 1, 'row count logged';
end $$;

-- ── User B (a page session, no client_id) sees only their own log rows ──
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006602","session_id":"00000000-0000-4000-8000-0000000066a2","email":"zztest-mcp-b@example.com"}', true);
do $$
begin
  assert (public.mcp_whoami() ->> 'client_id') is null, 'page session has no client';
  assert not exists (select 1 from public.mcp_query_log where user_id = '00000000-0000-4000-8000-000000006601'), 'B cannot read A''s log';
end $$;

-- ── Refused callers ──
do $$
declare
  claims text[] := array[
    '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006602","session_id":"00000000-0000-4000-8000-0000000066a4"}',   -- session expired
    '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006602","session_id":"00000000-0000-4000-8000-0000000066ff"}',   -- session gone (revoked)
    '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006602","session_id":"00000000-0000-4000-8000-0000000066a1"}',   -- someone else's session
    '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006603","session_id":"00000000-0000-4000-8000-0000000066a3"}',   -- banned user
    '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006602","session_id":"00000000-0000-4000-8000-0000000066a2","is_anonymous":true}',
    '{"role":"anon"}',
    '{}'];
  c text;
begin
  foreach c in array claims loop
    perform set_config('request.jwt.claims', c, true);
    begin perform public.mcp_whoami(); raise exception 'zz: whoami accepted %', c;
    exception when insufficient_privilege then null; end;
    begin perform public.mcp_run_sql('select 1 as one'); raise exception 'zz: run_sql accepted %', c;
    exception when insufficient_privilege then null; end;
    begin perform public.mcp_describe(); raise exception 'zz: describe accepted %', c;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;

reset role;
do $$
begin
  assert (select pub_score from outcome_weights where outcome = 'zztest_mcp_outcome') = 1, 'outcome_weights unchanged';
  assert (select count(*) from canoe_calls where id like 'zztest-mcp%') = 3, 'calls unchanged';
end $$;

rollback;
