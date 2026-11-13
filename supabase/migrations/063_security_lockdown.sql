-- ============================================================
-- 063: security lockdown (Nov 9 bug bash items 1-3, re-verified 2026-11-13)
--
-- Who uses the database, and with which key (inventoried 2026-11-13 from the code, 7 days of API
-- and function logs, pg_stat_statements and n8n):
--   - index.html: publishable key + the user's session (role authenticated). Signed out it only
--     ever reads behind the login screen; nothing needs to work without a login.
--   - scripts/ (sync, process, alert, agent_eval, load_ascnd_transcripts, backfill) via GitHub
--     Actions, and the hl-call-webhook edge function (ASCND/GHL -> hl_call_data): service role.
--     service_role bypasses RLS and keeps every grant it has; nothing here changes it.
--   - pg_cron jobs (rollups, check_new_ivrs, agent targets): run as postgres, the owner.
--   - reports_ro: direct Postgres login for an external report; keeps SELECT on canoe_calls and
--     outcome_weights. It loses EXECUTE on functions, which it only had through PUBLIC.
--   - No n8n workflow or other caller uses this project.
--
-- What changes:
-- 1) anon (the publishable key without a login) gets nothing in public: no table, sequence or
--    function privileges, and no anon/public policies. RLS goes on for the two tables that had it
--    off (ascnd_transcript_import, voiceai_import). Default privileges stop granting anon, and
--    PUBLIC no longer gets EXECUTE on new functions, so later migrations can't reopen this.
-- 2) public.is_admin(): true when the signed-in user's email is an admin in account_managers.
-- 3) Admin-only writes on the config tables: account_managers (incl. is_admin), ai_prompts,
--    outcome_weights, manager_alert_settings, account_manager_assignments, agents and
--    agent_review_assignments. Everyone signed in can still read them.
-- 4) canoe_calls: signed-in users may update only compliance_reviewed (the Calls drawer's
--    "Save correction"). hl_call_data and agent_calls_raw: no signed-in writes (only the service
--    role writes them). No TRUNCATE/REFERENCES/TRIGGER for signed-in users anywhere.
-- 5) Functions: the rollup refreshes, the hl pairing and find_duplicate_callers are service role
--    / pg_cron only. recalculate_call_scores (Settings > weights save) refuses non-admins.
--
-- Unchanged: the read policies the page uses, the reviewer writes (call_reviews, agent_reviews,
-- agent_updates, call_corrections, training_examples, model_tests), and every service-role path.
-- Separate dashboard step: Authentication > Sign In / Providers > turn off "Allow new users to
-- sign up" (this migration can't change Auth settings).
--
-- Rollback: supabase/rollbacks/063_security_lockdown_down.sql
-- Test:     supabase/tests/063_security_lockdown_test.sql, then scripts/check_anon_access.js
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

begin;
set local lock_timeout = '5s';

-- ── 1) anon: nothing in public ──
alter table public.ascnd_transcript_import enable row level security;
alter table public.voiceai_import          enable row level security;

revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon, public;

alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
-- PostgreSQL's own default gives PUBLIC (so anon) EXECUTE on every new function. Schema-level
-- defaults can't take that back, so this one is for all of postgres's new functions.
-- authenticated and service_role keep EXECUTE on new functions from the schema default.
alter default privileges for role postgres revoke execute on functions from public;

drop policy if exists "anon can read agents"            on public.agents;
drop policy if exists "anon can read agent_calls_raw"   on public.agent_calls_raw;
drop policy if exists "anon can read agent_ivr_aliases" on public.agent_ivr_aliases;
drop policy if exists "anon can read agent_test_calls"  on public.agent_test_calls;
drop policy if exists "anon can read hl_call_data"      on public.hl_call_data;
drop policy if exists "anon can read agent_targets"     on public.agent_targets;
-- Empty, unused tables with an "allow all" policy for every role. No policy = no access.
drop policy if exists "allow all" on public.ivr_development;
drop policy if exists "allow all" on public.ivr_recordings;
drop policy if exists "allow all" on public.ivr_signoffs;

-- ── 2) is_admin() ──
-- The JWT's email, matched case-insensitively. SECURITY DEFINER so policies on account_managers
-- can call it without recursing through their own RLS. No session (service role, SQL) = false.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(bool_or(m.is_admin), false)
  from public.account_managers m
  where m.manager_email is not null
    and lower(m.manager_email) = lower(auth.jwt() ->> 'email');
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- ── 3) Admin-only config writes (reads stay open to everyone signed in) ──
drop policy if exists "auth users can insert account_managers" on public.account_managers;
drop policy if exists "auth users can update account_managers" on public.account_managers;
drop policy if exists "auth users can delete account_managers" on public.account_managers;
drop policy if exists "admins can insert account_managers"     on public.account_managers;
drop policy if exists "admins can update account_managers"     on public.account_managers;
drop policy if exists "admins can delete account_managers"     on public.account_managers;
create policy "admins can insert account_managers" on public.account_managers
  for insert to authenticated with check ((select public.is_admin()));
create policy "admins can update account_managers" on public.account_managers
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins can delete account_managers" on public.account_managers
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "auth users can insert account_manager_assignments" on public.account_manager_assignments;
drop policy if exists "auth users can update account_manager_assignments" on public.account_manager_assignments;
drop policy if exists "auth users can delete account_manager_assignments" on public.account_manager_assignments;
drop policy if exists "admins can insert account_manager_assignments"     on public.account_manager_assignments;
drop policy if exists "admins can update account_manager_assignments"     on public.account_manager_assignments;
drop policy if exists "admins can delete account_manager_assignments"     on public.account_manager_assignments;
create policy "admins can insert account_manager_assignments" on public.account_manager_assignments
  for insert to authenticated with check ((select public.is_admin()));
create policy "admins can update account_manager_assignments" on public.account_manager_assignments
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins can delete account_manager_assignments" on public.account_manager_assignments
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "auth users can insert manager_alert_settings" on public.manager_alert_settings;
drop policy if exists "auth users can update manager_alert_settings" on public.manager_alert_settings;
drop policy if exists "auth users can delete manager_alert_settings" on public.manager_alert_settings;
drop policy if exists "admins can insert manager_alert_settings"     on public.manager_alert_settings;
drop policy if exists "admins can update manager_alert_settings"     on public.manager_alert_settings;
drop policy if exists "admins can delete manager_alert_settings"     on public.manager_alert_settings;
create policy "admins can insert manager_alert_settings" on public.manager_alert_settings
  for insert to authenticated with check ((select public.is_admin()));
create policy "admins can update manager_alert_settings" on public.manager_alert_settings
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins can delete manager_alert_settings" on public.manager_alert_settings
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "auth users can insert ai_prompts" on public.ai_prompts;
drop policy if exists "auth users can update ai_prompts" on public.ai_prompts;
drop policy if exists "auth users can delete ai_prompts" on public.ai_prompts;
drop policy if exists "admins can insert ai_prompts"     on public.ai_prompts;
drop policy if exists "admins can update ai_prompts"     on public.ai_prompts;
drop policy if exists "admins can delete ai_prompts"     on public.ai_prompts;
create policy "admins can insert ai_prompts" on public.ai_prompts
  for insert to authenticated with check ((select public.is_admin()));
create policy "admins can update ai_prompts" on public.ai_prompts
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins can delete ai_prompts" on public.ai_prompts
  for delete to authenticated using ((select public.is_admin()));

-- outcome_weights never had a delete policy (the page upserts); it still has none.
drop policy if exists "auth users can insert outcome_weights" on public.outcome_weights;
drop policy if exists "auth users can update outcome_weights" on public.outcome_weights;
drop policy if exists "admins can insert outcome_weights"     on public.outcome_weights;
drop policy if exists "admins can update outcome_weights"     on public.outcome_weights;
create policy "admins can insert outcome_weights" on public.outcome_weights
  for insert to authenticated with check ((select public.is_admin()));
create policy "admins can update outcome_weights" on public.outcome_weights
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- agents: the new-IVR setup form and the Review page's IVR objective (both admin-only on the page).
drop policy if exists "auth users can insert agents" on public.agents;
drop policy if exists "auth users can update agents" on public.agents;
drop policy if exists "auth users can delete agents" on public.agents;
drop policy if exists "admins can insert agents"     on public.agents;
drop policy if exists "admins can update agents"     on public.agents;
drop policy if exists "admins can delete agents"     on public.agents;
create policy "admins can insert agents" on public.agents
  for insert to authenticated with check ((select public.is_admin()));
create policy "admins can update agents" on public.agents
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins can delete agents" on public.agents
  for delete to authenticated using ((select public.is_admin()));

-- Review assignments (035): nothing on the page writes them any more.
drop policy if exists "auth insert agent_review_assignments"       on public.agent_review_assignments;
drop policy if exists "auth update agent_review_assignments"       on public.agent_review_assignments;
drop policy if exists "auth delete agent_review_assignments"       on public.agent_review_assignments;
drop policy if exists "admins can insert agent_review_assignments" on public.agent_review_assignments;
drop policy if exists "admins can update agent_review_assignments" on public.agent_review_assignments;
drop policy if exists "admins can delete agent_review_assignments" on public.agent_review_assignments;
create policy "admins can insert agent_review_assignments" on public.agent_review_assignments
  for insert to authenticated with check ((select public.is_admin()));
create policy "admins can update agent_review_assignments" on public.agent_review_assignments
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins can delete agent_review_assignments" on public.agent_review_assignments
  for delete to authenticated using ((select public.is_admin()));

-- ── 4) Signed-in writes on call data ──
revoke update on public.canoe_calls from authenticated;
grant update (compliance_reviewed) on public.canoe_calls to authenticated;

-- Only the webhook (service role) writes hl_call_data; sync Pass 3 copies it into canoe_calls.
drop policy if exists "auth users can insert hl_call_data"    on public.hl_call_data;
drop policy if exists "auth users can update hl_call_data"    on public.hl_call_data;
drop policy if exists "auth users can insert agent_calls_raw" on public.agent_calls_raw;
drop policy if exists "auth users can update agent_calls_raw" on public.agent_calls_raw;

-- PostgREST never issues these; RLS doesn't cover TRUNCATE.
revoke truncate, references, trigger on all tables in schema public from authenticated;

-- ── 5) Functions ──
revoke execute on function public.refresh_agent_metrics_daily(integer)      from authenticated;
revoke execute on function public.refresh_agent_counterparty_daily(integer) from authenticated;
revoke execute on function public.refresh_outcome_score_daily(integer)      from authenticated;
revoke execute on function public.sync_hl_to_canoe_calls(timestamptz, timestamptz) from authenticated;
revoke execute on function public.sync_hl_to_calls()                        from authenticated;
revoke execute on function public.find_duplicate_callers(text[])            from authenticated;

-- Same body as before (005), plus the admin check and a fixed search_path. Signed-in callers
-- must be admins; the service role and SQL (no JWT) are not limited.
create or replace function public.recalculate_call_scores()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  if auth.jwt() ->> 'role' = 'authenticated' and not public.is_admin() then
    raise exception 'recalculate_call_scores: admins only' using errcode = '42501';
  end if;
  set local statement_timeout = 0;
  update canoe_calls
  set publisher_score  = w.pub_score,
      advertiser_score = w.adv_score
  from outcome_weights w
  where canoe_calls.our_outcome = w.outcome
    and canoe_calls.our_outcome is not null;

  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

-- ── Self-check: abort (nothing applied) if anything is still open to anon ──
do $$
declare
  bad text;
begin
  select string_agg(tablename || ': ' || policyname, ', ') into bad
  from pg_policies where schemaname = 'public' and ('anon' = any(roles) or 'public' = any(roles));
  if bad is not null then raise exception '063: anon/public policies remain: %', bad; end if;

  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if bad is not null then raise exception '063: RLS still off on: %', bad; end if;

  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'usage, select, update')
             when c.relkind in ('r', 'p', 'v', 'm', 'f')
               then has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')
             else false end;
  if bad is not null then raise exception '063: anon still has privileges on: %', bad; end if;

  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then raise exception '063: anon can still execute: %', bad; end if;

  -- is_admin() reads account_managers as its owner; only postgres (BYPASSRLS) sees every row.
  if (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.is_admin()'::regprocedure) <> 'postgres' then
    raise exception '063: is_admin() must be owned by postgres; run this in the SQL editor as postgres';
  end if;
end $$;

commit;
