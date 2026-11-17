-- ============================================================
-- Rollback for 067_mcp_saved_reports.sql. Drops the report functions and the table: every
-- user's saved reports are lost (export them first if they matter:
-- select * from mcp_saved_reports).
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

begin;
set local lock_timeout = '5s';

drop function if exists public.mcp_reports_list();
drop function if exists public.mcp_report_save(uuid, text, text, text, jsonb, jsonb);
drop function if exists public.mcp_report_delete(uuid);
drop table if exists public.mcp_saved_reports;

commit;
