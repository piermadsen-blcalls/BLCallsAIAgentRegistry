-- ============================================================
-- 035_agent_review_assignments.sql
-- Assign each AI IVR to one account manager as its review owner.
-- One reviewer per agent (ivr_name is the PK). Powers the Review-tab
-- status board (My agents / Needs review / All).
-- RLS mirrors account_manager_assignments (002): authenticated
-- read + insert + update + delete; service role bypasses.
-- Run in Supabase SQL Editor.
-- ============================================================

create table if not exists agent_review_assignments (
  ivr_name    text primary key,                                    -- canonical agent
  manager_id  uuid references account_managers(id) on delete set null,
  assigned_by text,
  assigned_at timestamptz default now()
);

alter table agent_review_assignments enable row level security;

create policy "auth read agent_review_assignments"
  on agent_review_assignments for select to authenticated using (true);
create policy "auth insert agent_review_assignments"
  on agent_review_assignments for insert to authenticated with check (true);
create policy "auth update agent_review_assignments"
  on agent_review_assignments for update to authenticated using (true) with check (true);
create policy "auth delete agent_review_assignments"
  on agent_review_assignments for delete to authenticated using (true);
