-- ============================================================
-- Rollback for 063_security_lockdown.sql. Puts back exactly the grants, policies and functions
-- prod had before 063 (read from the live catalog on 2026-11-13, after 062): anon access with the
-- publishable key, RLS off on the two import tables, and "any signed-in user can write" config.
-- This reopens the bug bash items 1-3; use it only to unblock production while 063 is fixed.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

begin;
set local lock_timeout = '5s';

-- ── 5) Functions ──
create or replace function public.recalculate_call_scores()
returns integer
language plpgsql
security definer
as $$
declare
  updated_count integer;
begin
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

grant execute on function public.refresh_agent_metrics_daily(integer)      to authenticated;
grant execute on function public.refresh_agent_counterparty_daily(integer) to authenticated;
grant execute on function public.refresh_outcome_score_daily(integer)      to authenticated;
grant execute on function public.sync_hl_to_canoe_calls(timestamptz, timestamptz) to authenticated;
grant execute on function public.sync_hl_to_calls()                        to authenticated;
grant execute on function public.find_duplicate_callers(text[])            to authenticated;

-- The functions PUBLIC and anon could execute before 063.
grant execute on function
  public.agent_breakdown(text[], timestamptz, timestamptz),
  public.agent_breakdown_all(timestamptz, timestamptz),
  public.agent_counterparties(timestamptz),
  public.agent_metrics(timestamptz, timestamptz),
  public.agent_rollup(timestamptz, timestamptz),
  public.ascnd_pair_rank(numeric),
  public.find_duplicate_callers(text[]),
  public.get_distinct_accounts(),
  public.get_distinct_ivrs(timestamptz),
  public.get_distinct_verticals(),
  public.outcome_score_vectors(timestamptz, timestamptz, text),
  public.pairing_disagreements(text, text, text, timestamptz, timestamptz),
  public.recalculate_call_scores(),
  public.refresh_agent_counterparty_daily(integer),
  public.refresh_agent_metrics_daily(integer),
  public.refresh_outcome_score_daily(integer),
  public.review_counts(timestamptz),
  public.sync_hl_to_calls(),
  public.sync_hl_to_canoe_calls(timestamptz, timestamptz)
to public, anon;

-- ── 4) Signed-in writes on call data ──
revoke update (compliance_reviewed) on public.canoe_calls from authenticated;
grant update on public.canoe_calls to authenticated;

create policy "auth users can insert hl_call_data" on public.hl_call_data
  for insert to authenticated with check (true);
create policy "auth users can update hl_call_data" on public.hl_call_data
  for update to authenticated using (true) with check (true);
create policy "auth users can insert agent_calls_raw" on public.agent_calls_raw
  for insert to authenticated with check (true);
create policy "auth users can update agent_calls_raw" on public.agent_calls_raw
  for update to authenticated using (true) with check (true);

-- ── 3) Config writes back to any signed-in user ──
drop policy if exists "admins can insert account_managers" on public.account_managers;
drop policy if exists "admins can update account_managers" on public.account_managers;
drop policy if exists "admins can delete account_managers" on public.account_managers;
create policy "auth users can insert account_managers" on public.account_managers
  for insert to authenticated with check (true);
create policy "auth users can update account_managers" on public.account_managers
  for update to authenticated using (true) with check (true);
create policy "auth users can delete account_managers" on public.account_managers
  for delete to authenticated using (true);

drop policy if exists "admins can insert account_manager_assignments" on public.account_manager_assignments;
drop policy if exists "admins can update account_manager_assignments" on public.account_manager_assignments;
drop policy if exists "admins can delete account_manager_assignments" on public.account_manager_assignments;
create policy "auth users can insert account_manager_assignments" on public.account_manager_assignments
  for insert to authenticated with check (true);
create policy "auth users can update account_manager_assignments" on public.account_manager_assignments
  for update to authenticated using (true) with check (true);
create policy "auth users can delete account_manager_assignments" on public.account_manager_assignments
  for delete to authenticated using (true);

drop policy if exists "admins can insert manager_alert_settings" on public.manager_alert_settings;
drop policy if exists "admins can update manager_alert_settings" on public.manager_alert_settings;
drop policy if exists "admins can delete manager_alert_settings" on public.manager_alert_settings;
create policy "auth users can insert manager_alert_settings" on public.manager_alert_settings
  for insert to authenticated with check (true);
create policy "auth users can update manager_alert_settings" on public.manager_alert_settings
  for update to authenticated using (true) with check (true);
create policy "auth users can delete manager_alert_settings" on public.manager_alert_settings
  for delete to authenticated using (true);

drop policy if exists "admins can insert ai_prompts" on public.ai_prompts;
drop policy if exists "admins can update ai_prompts" on public.ai_prompts;
drop policy if exists "admins can delete ai_prompts" on public.ai_prompts;
create policy "auth users can insert ai_prompts" on public.ai_prompts
  for insert to authenticated with check (true);
create policy "auth users can update ai_prompts" on public.ai_prompts
  for update to authenticated using (true) with check (true);
create policy "auth users can delete ai_prompts" on public.ai_prompts
  for delete to authenticated using (true);

drop policy if exists "admins can insert outcome_weights" on public.outcome_weights;
drop policy if exists "admins can update outcome_weights" on public.outcome_weights;
create policy "auth users can insert outcome_weights" on public.outcome_weights
  for insert to authenticated with check (true);
create policy "auth users can update outcome_weights" on public.outcome_weights
  for update to authenticated using (true) with check (true);

drop policy if exists "admins can insert agents" on public.agents;
drop policy if exists "admins can update agents" on public.agents;
drop policy if exists "admins can delete agents" on public.agents;
create policy "auth users can insert agents" on public.agents
  for insert to authenticated with check (true);
create policy "auth users can update agents" on public.agents
  for update to authenticated using (true) with check (true);
create policy "auth users can delete agents" on public.agents
  for delete to authenticated using (true);

drop policy if exists "admins can insert agent_review_assignments" on public.agent_review_assignments;
drop policy if exists "admins can update agent_review_assignments" on public.agent_review_assignments;
drop policy if exists "admins can delete agent_review_assignments" on public.agent_review_assignments;
create policy "auth insert agent_review_assignments" on public.agent_review_assignments
  for insert to authenticated with check (true);
create policy "auth update agent_review_assignments" on public.agent_review_assignments
  for update to authenticated using (true) with check (true);
create policy "auth delete agent_review_assignments" on public.agent_review_assignments
  for delete to authenticated using (true);

-- ── 2) is_admin() (nothing else uses it once the policies above are back) ──
drop function if exists public.is_admin();

-- ── 1) anon ──
create policy "anon can read agents"            on public.agents            for select to anon using (true);
create policy "anon can read agent_calls_raw"   on public.agent_calls_raw   for select to anon using (true);
create policy "anon can read agent_ivr_aliases" on public.agent_ivr_aliases for select to anon using (true);
create policy "anon can read agent_test_calls"  on public.agent_test_calls  for select to anon using (true);
create policy "anon can read hl_call_data"      on public.hl_call_data      for select to anon using (true);
create policy "anon can read agent_targets"     on public.agent_targets     for select to anon using (true);
create policy "allow all" on public.ivr_development for all to public using (true) with check (true);
create policy "allow all" on public.ivr_recordings  for all to public using (true) with check (true);
create policy "allow all" on public.ivr_signoffs    for all to public using (true) with check (true);

alter default privileges for role postgres grant execute on functions to public;
alter default privileges for role postgres in schema public grant all on functions to anon;
alter default privileges for role postgres in schema public grant all on sequences to anon;
alter default privileges for role postgres in schema public grant all on tables    to anon;

grant usage, select, update on sequence public.rollup_refresh_requests_id_seq to anon;

-- Every table anon (all privileges) and authenticated (incl. TRUNCATE/REFERENCES/TRIGGER) had
-- before 063. Not on it: agent_call_evals, agent_eval_jobs, ascnd_pairing_backfill_058,
-- new_ivr_detections, rollup_refresh_requests, sync_state.
do $$
declare
  t text;
begin
  foreach t in array array[
    'account_manager_assignments', 'account_managers', 'agent_calls_raw', 'agent_canoe_ivr_ids',
    'agent_changes', 'agent_counterparty_daily', 'agent_ivr_aliases', 'agent_metrics_daily',
    'agent_review_assignments', 'agent_reviews', 'agent_targets', 'agent_test_calls', 'agent_updates',
    'agents', 'ai_prompts', 'alert_log', 'ascnd_transcript_import', 'call_corrections', 'call_reviews',
    'canoe_calls', 'gemini_batch_jobs', 'hl_call_data', 'insights_daily', 'ivr_development',
    'ivr_recordings', 'ivr_signoffs', 'manager_alert_settings', 'model_test_results', 'model_tests',
    'outcome_score_daily', 'outcome_weights', 'training_examples', 'voiceai_import']
  loop
    execute format('grant all on table public.%I to anon', t);
    execute format('grant truncate, references, trigger on table public.%I to authenticated', t);
  end loop;
end $$;

alter table public.ascnd_transcript_import disable row level security;
alter table public.voiceai_import          disable row level security;

commit;
