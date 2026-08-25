-- ============================================================
-- 038_agent_canoe_url_and_updates.sql
-- 1) agents.canoe_url — a link to the IVR in Canoe (populated from a CSV Pier
--    provides), shown in the agent drawer so an AM can pull the current config.
-- 2) agent_updates — an append-only log where an account manager records
--    updates / change requests for an agent (they still enter them manually).
-- RLS mirrors the existing authenticated read/insert pattern.
-- Run in Supabase SQL Editor.
-- ============================================================

alter table agents add column if not exists canoe_url text;

create table if not exists agent_updates (
  id         uuid primary key default gen_random_uuid(),
  ivr_name   text not null,          -- canonical agent
  author     text,
  note       text,
  created_at timestamptz default now()
);
create index if not exists agent_updates_ivr_idx on agent_updates (ivr_name, created_at desc);

alter table agent_updates enable row level security;
create policy "auth read agent_updates"   on agent_updates for select to authenticated using (true);
create policy "auth insert agent_updates" on agent_updates for insert to authenticated with check (true);
