-- ============================================================
-- 067_mcp_saved_reports.sql
-- Saved reports for the Claude connector: a named query a user keeps and re-runs, from Claude
-- ("save this as my weekly publisher report") or the registry's Claude tab. New table only; it
-- does not change access to any existing data. Each user sees and changes only their own reports.
--
--   kind       'sql'       definition = { sql }                         (a query on the mcp views)
--              'search'    definition = the search_calls arguments
--              'aggregate' definition = the aggregate_calls arguments
--   parameters [{ name, type, description, default, required }]; {{name}} in the definition is
--              replaced with the value when the report runs (the edge function does this and
--              runs the result through mcp_run_sql from 066, so a report can only read).
--
-- Functions (SECURITY INVOKER, so RLS applies): mcp_reports_list(), mcp_report_save(...) (insert
-- when id is null, else update the given fields), mcp_report_delete(id).
-- Rollback: supabase/rollbacks/067_mcp_saved_reports_down.sql (drops every saved report)
-- Test:     supabase/tests/067_mcp_saved_reports_test.sql
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

begin;
set local lock_timeout = '5s';

create table if not exists public.mcp_saved_reports (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  description text check (length(description) <= 2000),
  kind        text not null check (kind in ('sql', 'search', 'aggregate')),
  definition  jsonb not null check (jsonb_typeof(definition) = 'object'),
  parameters  jsonb not null default '[]'::jsonb check (jsonb_typeof(parameters) = 'array'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists mcp_saved_reports_owner_name_key on public.mcp_saved_reports (owner_id, lower(btrim(name)));

alter table public.mcp_saved_reports enable row level security;
revoke all on table public.mcp_saved_reports from public, anon, authenticated;
grant select, insert, update, delete on table public.mcp_saved_reports to authenticated;
drop policy if exists "owner reads mcp_saved_reports"   on public.mcp_saved_reports;
drop policy if exists "owner inserts mcp_saved_reports" on public.mcp_saved_reports;
drop policy if exists "owner updates mcp_saved_reports" on public.mcp_saved_reports;
drop policy if exists "owner deletes mcp_saved_reports" on public.mcp_saved_reports;
create policy "owner reads mcp_saved_reports" on public.mcp_saved_reports
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "owner inserts mcp_saved_reports" on public.mcp_saved_reports
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "owner updates mcp_saved_reports" on public.mcp_saved_reports
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owner deletes mcp_saved_reports" on public.mcp_saved_reports
  for delete to authenticated using (owner_id = (select auth.uid()));

create or replace function public.mcp_reports_list()
returns setof public.mcp_saved_reports
language sql
stable
set search_path = ''
as $$
  select * from public.mcp_saved_reports
  where owner_id = (select auth.uid())
  order by lower(name);
$$;

-- p_id null = new report (name, kind and definition required). Otherwise only the non-null
-- arguments change; an empty description clears it.
create or replace function public.mcp_report_save(p_id uuid default null, p_name text default null,
  p_description text default null, p_kind text default null, p_definition jsonb default null,
  p_parameters jsonb default null)
returns public.mcp_saved_reports
language plpgsql
volatile
set search_path = ''
as $$
declare
  saved public.mcp_saved_reports;
begin
  if p_id is null then
    if p_name is null or p_kind is null or p_definition is null then
      raise exception 'A new report needs a name, a kind and a definition.' using errcode = '22023';
    end if;
    insert into public.mcp_saved_reports (name, description, kind, definition, parameters)
    values (btrim(p_name), nullif(btrim(p_description), ''), p_kind, p_definition, coalesce(p_parameters, '[]'::jsonb))
    returning * into saved;
  else
    update public.mcp_saved_reports set
      name        = coalesce(btrim(p_name), name),
      description = case when p_description is null then description else nullif(btrim(p_description), '') end,
      kind        = coalesce(p_kind, kind),
      definition  = coalesce(p_definition, definition),
      parameters  = coalesce(p_parameters, parameters),
      updated_at  = now()
    where id = p_id
    returning * into saved;
    if saved.id is null then
      raise exception 'Report not found.' using errcode = 'P0002';
    end if;
  end if;
  return saved;
exception when unique_violation then
  raise exception 'You already have a report named "%".', btrim(p_name) using errcode = '23505';
end;
$$;

create or replace function public.mcp_report_delete(p_id uuid)
returns boolean
language sql
volatile
set search_path = ''
as $$
  with d as (delete from public.mcp_saved_reports where id = p_id returning 1)
  select exists (select 1 from d);
$$;

revoke all on function public.mcp_reports_list() from public, anon;
revoke all on function public.mcp_report_save(uuid, text, text, text, jsonb, jsonb) from public, anon;
revoke all on function public.mcp_report_delete(uuid) from public, anon;
grant execute on function public.mcp_reports_list() to authenticated;
grant execute on function public.mcp_report_save(uuid, text, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.mcp_report_delete(uuid) to authenticated;

commit;
