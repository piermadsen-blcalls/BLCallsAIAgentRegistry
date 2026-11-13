-- ============================================================
-- 057_agent_activity_team_overview.sql
-- Two read-only RPCs for the Agents/Review "Inactive" section and the rebuilt Settings > Team.
--
-- 1) agent_last_call_days(): the last UTC day with a (non-test) call per raw ivr_name, from the
--    agent_metrics_daily rollup (030; full history, refreshed after each sync by 052). The page
--    resolves aliases to the canonical agent and takes the newest day, so a renamed IVR keeps
--    its history. An agent whose newest day is more than 30 days ago (or that has none) is
--    "inactive" and leaves the Agents grid and the Review board's Needs review count; the next
--    call moves it back. ~12k rollup rows, so this is a sub-10ms index scan.
-- 2) team_overview(since_ts): flagged calls (flags <> '[]', same test as the Calls tab's
--    "Flagged only") since since_ts per assigned account and per manager, joined through
--    account_manager_assignments (the Review board's assignment data). A manager's count is
--    distinct calls, so a call on two of their accounts counts once. Reads the partial
--    canoe_calls_flagged_created_idx (028); ~1k flagged calls a week. Replaces the old Team
--    view's arbitrary 5,000-row sample grouped by canoe_calls.account_manager (never filled).
-- Both are SECURITY INVOKER: they read only tables authenticated users can already select.
-- Rollback: supabase/rollbacks/057_agent_activity_team_overview_down.sql.
-- Test: supabase/tests/057_agent_activity_team_overview_test.sql.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

create or replace function agent_last_call_days()
returns table (ivr_name text, last_day date)
language sql stable set search_path = public, pg_temp as $$
  select d.ivr_name, max(d.day)
  from agent_metrics_daily d
  where d.raw > 0
  group by d.ivr_name;
$$;
revoke execute on function agent_last_call_days() from public, anon;
grant execute on function agent_last_call_days() to authenticated;

create or replace function team_overview(since_ts timestamptz)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with f as (
    select c.id, c.publisher_name, c.advertiser_name
    from canoe_calls c
    where c.flags <> '[]'::jsonb and c.created_at >= since_ts and c.is_test is not true
  ), hits as (
    select a.manager_id, a.account_name, a.account_type, f.id
    from account_manager_assignments a
    join f on (a.account_type = 'advertiser' and f.advertiser_name = a.account_name)
           or (a.account_type = 'publisher'  and f.publisher_name  = a.account_name)
  )
  select jsonb_build_object(
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object('account_name', account_name, 'account_type', account_type, 'flagged', n))
      from (select account_name, account_type, count(distinct id) as n from hits group by 1, 2) x), '[]'::jsonb),
    'managers', coalesce((
      select jsonb_agg(jsonb_build_object('manager_id', manager_id, 'flagged', n))
      from (select manager_id, count(distinct id) as n from hits group by 1) y), '[]'::jsonb)
  );
$$;
revoke execute on function team_overview(timestamptz) from public, anon;
grant execute on function team_overview(timestamptz) to authenticated;
