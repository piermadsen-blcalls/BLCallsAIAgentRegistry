-- ============================================================
-- 002_rls.sql
-- Lock down all UNRESTRICTED tables.
-- Run this in Supabase SQL Editor (once).
-- ============================================================

-- ── account_managers ────────────────────────────────────────
alter table account_managers enable row level security;

create policy "auth users can read account_managers"
  on account_managers for select to authenticated using (true);

create policy "auth users can insert account_managers"
  on account_managers for insert to authenticated with check (true);

create policy "auth users can update account_managers"
  on account_managers for update to authenticated using (true) with check (true);

create policy "auth users can delete account_managers"
  on account_managers for delete to authenticated using (true);

-- ── account_manager_assignments ──────────────────────────────
alter table account_manager_assignments enable row level security;

create policy "auth users can read account_manager_assignments"
  on account_manager_assignments for select to authenticated using (true);

create policy "auth users can insert account_manager_assignments"
  on account_manager_assignments for insert to authenticated with check (true);

create policy "auth users can update account_manager_assignments"
  on account_manager_assignments for update to authenticated using (true) with check (true);

create policy "auth users can delete account_manager_assignments"
  on account_manager_assignments for delete to authenticated using (true);

-- ── manager_alert_settings ───────────────────────────────────
alter table manager_alert_settings enable row level security;

create policy "auth users can read manager_alert_settings"
  on manager_alert_settings for select to authenticated using (true);

create policy "auth users can insert manager_alert_settings"
  on manager_alert_settings for insert to authenticated with check (true);

create policy "auth users can update manager_alert_settings"
  on manager_alert_settings for update to authenticated using (true) with check (true);

create policy "auth users can delete manager_alert_settings"
  on manager_alert_settings for delete to authenticated using (true);

-- ── agents ──────────────────────────────────────────────────
-- anon read (used by the Agents tab before login check) + auth write
alter table agents enable row level security;

create policy "anon can read agents"
  on agents for select to anon using (true);

create policy "auth users can read agents"
  on agents for select to authenticated using (true);

create policy "auth users can insert agents"
  on agents for insert to authenticated with check (true);

create policy "auth users can update agents"
  on agents for update to authenticated using (true) with check (true);

create policy "auth users can delete agents"
  on agents for delete to authenticated using (true);

-- ── agent_calls_raw ──────────────────────────────────────────
alter table agent_calls_raw enable row level security;

create policy "anon can read agent_calls_raw"
  on agent_calls_raw for select to anon using (true);

create policy "auth users can read agent_calls_raw"
  on agent_calls_raw for select to authenticated using (true);

-- ── agent_ivr_aliases ────────────────────────────────────────
alter table agent_ivr_aliases enable row level security;

create policy "anon can read agent_ivr_aliases"
  on agent_ivr_aliases for select to anon using (true);

create policy "auth users can read agent_ivr_aliases"
  on agent_ivr_aliases for select to authenticated using (true);

-- ── agent_test_calls ─────────────────────────────────────────
alter table agent_test_calls enable row level security;

create policy "anon can read agent_test_calls"
  on agent_test_calls for select to anon using (true);

create policy "auth users can read agent_test_calls"
  on agent_test_calls for select to authenticated using (true);

-- ── hl_call_data ─────────────────────────────────────────────
alter table hl_call_data enable row level security;

create policy "anon can read hl_call_data"
  on hl_call_data for select to anon using (true);

create policy "auth users can read hl_call_data"
  on hl_call_data for select to authenticated using (true);

create policy "auth users can insert hl_call_data"
  on hl_call_data for insert to authenticated with check (true);

create policy "auth users can update hl_call_data"
  on hl_call_data for update to authenticated using (true) with check (true);
