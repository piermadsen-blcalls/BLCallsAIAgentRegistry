-- ============================================================
-- Rollback for 066_mcp_connector_access.sql. Removes the connector's read door (mcp_run_sql,
-- mcp_whoami, mcp_describe), the mcp views, the private helpers, the query log (its rows are
-- lost) and the mcp_reader role. The Claude connector stops working until 066 is re-applied.
-- Roll back 067 first if it is applied (the reports UI and tools need 066 to run reports).
-- Run in Supabase SQL Editor as postgres (or supabase db query --linked -f).
-- ============================================================

begin;
set local lock_timeout = '5s';

drop function if exists public.mcp_run_sql(text, integer, boolean, text);
drop function if exists public.mcp_whoami();
drop function if exists public.mcp_describe();
drop function if exists mcp_private.exec_readonly(text, integer, boolean);
drop function if exists mcp_private.require_caller();
drop schema if exists mcp_private;

drop view if exists mcp.calls;
drop view if exists mcp.agents;
drop view if exists mcp.agent_aliases;
drop view if exists mcp.outcome_weights;
drop view if exists mcp.account_assignments;
drop schema if exists mcp;

drop table if exists public.mcp_query_log;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mcp_reader') then
    drop role mcp_reader;
  end if;
end $$;

commit;
