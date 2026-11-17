-- ============================================================
-- Regression test for 067_mcp_saved_reports.sql.
-- Everything runs inside one transaction that is ROLLED BACK at the end; raises on failure.
-- Requests are played the way PostgREST does it: SET ROLE authenticated plus the JWT claims.
-- Users are made-up ids (00000000-0000-4000-8000-0000000067xx); reports are named 'ZZTEST *'.
-- ============================================================
begin;

do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.mcp_saved_reports'::regclass), 'RLS on';
  assert not has_table_privilege('anon', 'public.mcp_saved_reports', 'select, insert, update, delete'), 'anon: nothing';
  assert not has_table_privilege('authenticated', 'public.mcp_saved_reports', 'truncate, references, trigger'), 'no truncate';
  assert not has_function_privilege('anon', 'public.mcp_report_save(uuid, text, text, text, jsonb, jsonb)', 'execute'), 'anon cannot save';
  assert has_function_privilege('authenticated', 'public.mcp_reports_list()', 'execute'), 'signed-in users list';
end $$;

set local role authenticated;

-- ── User A creates, updates and lists ──
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006701"}', true);
do $$
declare
  r public.mcp_saved_reports;
  r2 public.mcp_saved_reports;
begin
  r := public.mcp_report_save(null, '  ZZTEST Weekly publishers ', 'Calls by publisher', 'aggregate',
         '{"group_by":["publisher"],"metrics":["calls"],"filters":{"start_date":"{{start}}"}}',
         '[{"name":"start","type":"date","required":true}]');
  assert r.owner_id = '00000000-0000-4000-8000-000000006701' and r.name = 'ZZTEST Weekly publishers', format('created: %s', row_to_json(r));
  r2 := public.mcp_report_save(null, 'ZZTEST Raw', null, 'sql', '{"sql":"select 1 as one"}', null);
  assert r2.parameters = '[]'::jsonb and r2.description is null, 'defaults';

  -- Names are unique per user, ignoring case and spaces
  begin perform public.mcp_report_save(null, 'zztest weekly PUBLISHERS', null, 'sql', '{"sql":"select 1"}', null);
    raise exception 'zz: duplicate name accepted';
  exception when unique_violation then null; end;
  begin perform public.mcp_report_save(null, 'ZZTEST Bad kind', null, 'chart', '{}', null);
    raise exception 'zz: bad kind accepted';
  exception when check_violation then null; end;
  begin perform public.mcp_report_save(null, 'ZZTEST No def', null, 'sql', null, null);
    raise exception 'zz: missing definition accepted';
  exception when invalid_parameter_value then null; end;

  -- Partial update: only the given fields change; '' clears the description
  r := public.mcp_report_save(r.id, null, '', null, null, null);
  assert r.description is null and r.kind = 'aggregate' and r.name = 'ZZTEST Weekly publishers', format('partial update: %s', row_to_json(r));
  r := public.mcp_report_save(r.id, 'ZZTEST Weekly pubs', null, null, '{"group_by":["publisher"],"metrics":["calls","connect_rate"]}', null);
  assert r.name = 'ZZTEST Weekly pubs' and r.definition -> 'metrics' ? 'connect_rate' and r.updated_at >= r.created_at, 'renamed and redefined';

  assert (select array_agg(name order by lower(name)) from public.mcp_reports_list()) = array['ZZTEST Raw', 'ZZTEST Weekly pubs'], 'A lists both';
end $$;

-- ── User B sees, changes and deletes none of A's reports ──
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006702"}', true);
do $$
declare
  a_id uuid;
begin
  assert not exists (select 1 from public.mcp_reports_list()), 'B lists nothing';
  assert not exists (select 1 from public.mcp_saved_reports), 'B reads nothing directly';
  -- B may reuse A's report name
  perform public.mcp_report_save(null, 'ZZTEST Raw', null, 'sql', '{"sql":"select 2"}', null);
  -- B cannot plant a report on A
  begin
    insert into public.mcp_saved_reports (owner_id, name, kind, definition)
    values ('00000000-0000-4000-8000-000000006701', 'ZZTEST Planted', 'sql', '{"sql":"select 1"}');
    raise exception 'zz: planted a report on another user';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
create temp table zz_a as select id from public.mcp_saved_reports where owner_id = '00000000-0000-4000-8000-000000006701' and name = 'ZZTEST Raw';
grant select on zz_a to authenticated;
set local role authenticated;
do $$
declare
  a_id uuid := (select id from zz_a);
begin
  begin perform public.mcp_report_save(a_id, 'ZZTEST Hijack', null, null, null, null);
    raise exception 'zz: B updated A''s report';
  exception when no_data_found then null; end;
  assert public.mcp_report_delete(a_id) = false, 'B cannot delete A''s report';
end $$;

-- ── A deletes their own ──
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000006701"}', true);
do $$
begin
  assert public.mcp_report_delete((select id from zz_a)) = true, 'A deletes their report';
  assert (select count(*) from public.mcp_reports_list()) = 1, 'one left for A';
end $$;

-- ── Signed out: nothing ──
reset role;
set local role anon;
do $$
begin
  begin perform public.mcp_reports_list(); raise exception 'zz: anon listed reports';
  exception when insufficient_privilege then null; end;
end $$;

rollback;
