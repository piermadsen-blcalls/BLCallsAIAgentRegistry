-- ============================================================
-- Regression test for 063_security_lockdown.sql.
-- Run in the Supabase SQL Editor after 063. Everything runs inside one transaction that is
-- ROLLED BACK at the end, so it leaves no rows or objects behind; raises on failure. Each
-- request is played the way PostgREST does it: SET ROLE plus the JWT claims. Fixture emails are
-- zztest-*@example.com and ids 'zztest-'. Reads are LIMIT 1 or fixture rows only (no data shown).
-- recalculate_call_scores is checked from its source, not run: a run rewrites every scored call.
-- ============================================================
begin;

insert into account_managers (manager_name, manager_email, is_admin) values
  ('ZZTEST Admin', 'zztest-admin@example.com', true),
  ('ZZTEST User',  'zztest-user@example.com',  false);
insert into agents (ivr_name, name) values ('ASCND AI Agent - ZZTEST Lockdown - Outgoing', 'ZZ Lockdown');
insert into canoe_calls (id, ivr_name, is_test, created_at)
  values ('zztest-sec1', 'ASCND AI Agent - ZZTEST Lockdown - Outgoing', true, now());
insert into account_manager_assignments (manager_id, account_name, account_type)
  select id, 'ZZTEST Pub', 'publisher' from account_managers where manager_email = 'zztest-user@example.com';
insert into manager_alert_settings (manager_id)
  select id from account_managers where manager_email = 'zztest-user@example.com';

-- ── Catalog: anon has nothing, signed-in users only what the page needs ──
do $$
declare
  f text;
begin
  assert not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 'RLS on everywhere';
  assert not exists (select 1 from pg_policies where schemaname = 'public' and ('anon' = any(roles) or 'public' = any(roles))), 'no anon/public policies';
  assert not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
                       and has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')), 'anon: no table privileges';
  assert not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public'
                       and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'usage, select, update') else false end), 'anon: no sequence privileges';
  assert not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')), 'anon: no function privileges';
  assert not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege('authenticated', c.oid, 'truncate, references, trigger')), 'authenticated: no TRUNCATE/REFERENCES/TRIGGER';

  -- canoe_calls: signed-in users read everything, update only compliance_reviewed.
  assert has_table_privilege('authenticated', 'canoe_calls', 'select'), 'authenticated reads canoe_calls';
  assert has_column_privilege('authenticated', 'canoe_calls', 'compliance_reviewed', 'update'), 'can mark reviewed';
  assert not has_column_privilege('authenticated', 'canoe_calls', 'our_outcome', 'update'), 'cannot rewrite outcomes';
  assert not has_column_privilege('authenticated', 'canoe_calls', 'flags', 'update'), 'cannot rewrite flags';

  -- Every RPC the page calls is still open to signed-in users.
  foreach f in array array[
    'agent_breakdown_all(timestamptz,timestamptz)', 'agent_counterparties(timestamptz)', 'agent_eval_metrics(timestamptz,timestamptz)',
    'agent_last_call_days()', 'agent_metrics(timestamptz,timestamptz)', 'get_distinct_accounts()', 'get_distinct_verticals()',
    'insights_period(date,date,text[])', 'outcome_score_pairings(timestamptz,timestamptz,text)',
    'outcome_score_vectors(timestamptz,timestamptz,text)', 'pairing_disagreements(text,text,text,timestamptz,timestamptz)',
    'recalculate_call_scores()', 'review_counts(timestamptz)', 'team_overview(timestamptz)', 'is_admin()']
  loop
    assert has_function_privilege('authenticated', f, 'execute'), 'authenticated can run ' || f;
  end loop;
  -- Writers are service role / pg_cron only.
  foreach f in array array[
    'refresh_agent_metrics_daily(integer)', 'refresh_agent_counterparty_daily(integer)', 'refresh_outcome_score_daily(integer)',
    'sync_hl_to_canoe_calls(timestamptz,timestamptz)', 'sync_hl_to_calls()', 'find_duplicate_callers(text[])',
    'upsert_canoe_calls(jsonb)', 'request_rollup_refresh(timestamptz,text[])', 'check_new_ivrs(integer)', 'refresh_agent_targets(integer)']
  loop
    assert not has_function_privilege('authenticated', f, 'execute'), 'authenticated cannot run ' || f;
    assert has_function_privilege('service_role', f, 'execute'), 'service_role can run ' || f;
  end loop;
  assert (select prosrc from pg_proc where oid = 'public.recalculate_call_scores()'::regprocedure) like '%is_admin()%admins only%', 'recalculate_call_scores checks admin';
  assert (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.is_admin()'::regprocedure) = 'postgres', 'is_admin owned by postgres';

  -- The service role keeps writing what the scripts and the webhook write.
  assert has_table_privilege('service_role', 'canoe_calls', 'insert, update'), 'service_role writes canoe_calls';
  assert has_table_privilege('service_role', 'hl_call_data', 'insert'), 'service_role writes hl_call_data';
  assert has_table_privilege('service_role', 'manager_alert_settings', 'update'), 'service_role writes manager_alert_settings';
  -- reports_ro keeps its two tables.
  assert has_table_privilege('reports_ro', 'canoe_calls', 'select'), 'reports_ro reads canoe_calls';
  assert has_table_privilege('reports_ro', 'outcome_weights', 'select'), 'reports_ro reads outcome_weights';
end $$;

-- New objects: anon gets nothing by default, signed-in users still get new RPCs and tables.
create function public.zztest_063_fn() returns int language sql as 'select 1';
create table public.zztest_063_tbl (id int);
do $$
begin
  assert not has_function_privilege('anon', 'public.zztest_063_fn()', 'execute'), 'new function: no anon';
  assert has_function_privilege('authenticated', 'public.zztest_063_fn()', 'execute'), 'new function: authenticated';
  assert not has_table_privilege('anon', 'public.zztest_063_tbl', 'select'), 'new table: no anon';
  assert has_table_privilege('authenticated', 'public.zztest_063_tbl', 'select'), 'new table: authenticated';
end $$;

-- ── anon (publishable key, no login) ──
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
do $$
declare
  t text;
begin
  foreach t in array array['hl_call_data', 'canoe_calls', 'ascnd_transcript_import', 'voiceai_import', 'agent_calls_raw',
                           'agents', 'agent_ivr_aliases', 'agent_targets', 'account_managers', 'ai_prompts', 'ivr_development']
  loop
    begin
      execute format('select 1 from public.%I limit 1', t);
      raise exception 'anon can read %', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    insert into public.voiceai_import default values;
    raise exception 'anon can insert voiceai_import';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── signed in, not an admin ──
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","email":"zztest-user@example.com"}';
do $$
declare
  n int;
begin
  assert not public.is_admin(), 'not an admin';
  assert (select count(*) from public.agents where ivr_name = 'ASCND AI Agent - ZZTEST Lockdown - Outgoing') = 1, 'reads agents';
  assert (select count(*) from public.account_managers where manager_email like 'zztest-%@example.com') = 2, 'reads managers';

  update public.account_managers set is_admin = true where manager_email = 'zztest-user@example.com';
  get diagnostics n = row_count; assert n = 0, 'made self admin';
  begin
    insert into public.account_managers (manager_name, manager_email, is_admin) values ('ZZTEST Intruder', 'zztest-x@example.com', true);
    raise exception 'non-admin added a manager';
  exception when insufficient_privilege then null;
  end;
  delete from public.account_managers where manager_email = 'zztest-admin@example.com';
  get diagnostics n = row_count; assert n = 0, 'removed a manager';
  update public.agents set objective = 'zz' where ivr_name = 'ASCND AI Agent - ZZTEST Lockdown - Outgoing';
  get diagnostics n = row_count; assert n = 0, 'edited an agent';
  update public.account_manager_assignments set account_type = 'advertiser' where account_name = 'ZZTEST Pub';
  get diagnostics n = row_count; assert n = 0, 'edited an assignment';
  update public.manager_alert_settings set enabled = not enabled
   where manager_id = (select id from public.account_managers where manager_email = 'zztest-user@example.com');
  get diagnostics n = row_count; assert n = 0, 'edited alert settings';
  begin
    insert into public.ai_prompts (name, outcome_prompt, compliance_prompt, is_active) values ('ZZTEST prompt', 'x', 'x', false);
    raise exception 'non-admin added a prompt';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.outcome_weights (outcome, pub_score, adv_score) values ('zztest_outcome', 1, 1);
    raise exception 'non-admin added a weight';
  exception when insufficient_privilege then null;
  end;

  -- The Calls drawer's "Save correction" still marks a call reviewed; nothing else on the row.
  update public.canoe_calls set compliance_reviewed = true where id = 'zztest-sec1';
  get diagnostics n = row_count; assert n = 1, 'mark reviewed';
  begin
    update public.canoe_calls set our_outcome = 'zztest' where id = 'zztest-sec1';
    raise exception 'non-admin rewrote an outcome';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.hl_call_data default values;
    raise exception 'signed-in user inserted hl_call_data';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from (select 1 from public.voiceai_import limit 1) x) = 0, 'import tables hidden';
  begin
    perform public.refresh_agent_metrics_daily(1);
    raise exception 'signed-in user ran a rollup refresh';
  exception when insufficient_privilege then null;
  end;

  -- Reviewer writes are unchanged.
  insert into public.call_reviews (call_id, ivr_name, reviewed_by, reviewed)
    values ('zztest-sec1', 'ASCND AI Agent - ZZTEST Lockdown - Outgoing', 'ZZTEST User', true);
  insert into public.agent_updates (ivr_name, author, note)
    values ('ASCND AI Agent - ZZTEST Lockdown - Outgoing', 'ZZTEST User', 'zztest');
end $$;

-- ── signed in as an admin (email case differs from account_managers) ──
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","email":"ZZTEST-Admin@Example.com"}';
do $$
declare
  n int;
begin
  assert public.is_admin(), 'admin (case-insensitive email)';
  update public.agents set objective = 'zz' where ivr_name = 'ASCND AI Agent - ZZTEST Lockdown - Outgoing';
  get diagnostics n = row_count; assert n = 1, 'admin edits agents';
  update public.account_managers set is_admin = true where manager_email = 'zztest-user@example.com';
  get diagnostics n = row_count; assert n = 1, 'admin sets is_admin';
  update public.account_manager_assignments set account_type = 'advertiser' where account_name = 'ZZTEST Pub';
  get diagnostics n = row_count; assert n = 1, 'admin edits assignments';
  delete from public.manager_alert_settings
   where manager_id = (select id from public.account_managers where manager_email = 'zztest-user@example.com');
  get diagnostics n = row_count; assert n = 1, 'admin edits alert settings';
  insert into public.ai_prompts (name, outcome_prompt, compliance_prompt, is_active) values ('ZZTEST prompt', 'x', 'x', false);
  insert into public.outcome_weights (outcome, pub_score, adv_score) values ('zztest_outcome', 1, 1);
  insert into public.account_managers (manager_name, manager_email) values ('ZZTEST New', 'zztest-new@example.com');
  -- Admins also update only compliance_reviewed directly; scores change through recalculate_call_scores.
  begin
    update public.canoe_calls set our_outcome = 'zztest' where id = 'zztest-sec1';
    raise exception 'admin rewrote an outcome directly';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── reports_ro (direct login) ──
set local role reports_ro;
do $$
begin
  perform 1 from public.canoe_calls limit 1;
  perform 1 from public.outcome_weights limit 1;
end $$;

set local role postgres;
select 'ALL 063 TESTS PASSED' as result;
rollback;
