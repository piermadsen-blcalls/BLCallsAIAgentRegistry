-- ============================================================
-- 050_renamed_ivr_aliases.sql
--
-- On 2026-10-07 Canoe renamed every ASCND AI IVR, adding the agent's phone
-- number (DID) to the name:
--   before: 'ASCND AI Agent - Pest Control - Outgoing'
--   after : 'ASCND AI Agent - Pest Control_13854693345 - Outgoing'
-- None of the new names were in `agents` or `agent_ivr_aliases`, so from the
-- week of Oct 12 every registered agent reads 0 calls on the Agents tab, the
-- Review board and the Review panes (Calls to Review). Alias resolution happens
-- at read time, so adding alias rows fixes history at once; no rollup rebuild.
--
-- 1) Register the 6 IVRs that have no existing agent.
-- 2) Alias all 35 renamed names (seen in Canoe since Oct 7) to their agent:
--    28 match by stripping the _<DID> suffix, Multi-Category (GLS) matches on
--    Canoe's ivr_id (its old name has a different word order), and 4 point at
--    the agents registered in step 1 under their pre-rename name.
-- 3) Self-healing for the next rename: Canoe's ivr_id is stable across renames.
--    Learn ivr_id -> agent from calls under registered names, then alias any
--    unregistered ASCND name whose ivr_id is already known. Runs daily (pg_cron).
--    Brand-new IVRs (new ivr_id) still need registering by hand.
--
-- Every canonical below is an `agents.ivr_name` (the frontend resolves aliases
-- one hop, so an alias must never point at another alias).
-- Idempotent: safe to re-run. Paste the whole file into the Supabase SQL editor.
-- Test: supabase/tests/050_renamed_ivr_aliases_test.sql
-- ============================================================

-- ── 1) New agents ──────────────────────────────────────────────────────────
-- Registered under the pre-rename name where one exists, so their September
-- history counts too. Vertical/routing are best guesses: confirm in the UI.
insert into agents (ivr_name, name, vertical, status, routing_type, notes) values
  ('ASCND AI Agent - home service compliance - Outgoing',      'home service compliance',           'Home Services', 'live', 'unknown', 'Registered by migration 050 (Oct 7 Canoe rename). Confirm vertical + routing.'),
  ('ASCND AI Agent - Check For Transfers + marketplace - Outgoing', 'Check For Transfers + marketplace', 'Other',      'live', 'unknown', 'Registered by migration 050 (Oct 7 Canoe rename). Confirm vertical + routing.'),
  ('ASCND AI Agent - Pest Control BH Direct - Outgoing',       'Pest Control BH Direct',            'Home Services', 'live', 'unknown', 'Registered by migration 050 (Oct 7 Canoe rename). Confirm vertical + routing.'),
  ('ASCND AI Agent - Insurance (auto+home) - Outgoing',        'Insurance (auto+home)',             'Insurance',     'live', 'unknown', 'Registered by migration 050 (Oct 7 Canoe rename). Confirm vertical + routing.'),
  -- No pre-rename name: first seen under the new naming.
  ('ASCND  AI Agent - Wildlife Removal Saved Listing_12135893428 - Outgoing', 'Wildlife Removal Saved Listing', 'Home Services', 'live', 'unknown', 'Registered by migration 050 (new after the Oct 7 Canoe rename). Confirm vertical + routing.'),
  ('ASCND AI Agent - Medicare - Aragon_12133401267 - Outgoing', 'Medicare - Aragon',                 'Insurance',     'live', 'unknown', 'Registered by migration 050 (new after the Oct 7 Canoe rename, MK-189). Confirm vertical + routing.')
on conflict (ivr_name) do nothing;

-- ── 2) Renamed name -> agent ───────────────────────────────────────────────
insert into agent_ivr_aliases (ivr_name, canonical_ivr_name) values
  -- matched by stripping _<DID> (case + whitespace folded)
  ('ASCND  AI Agent - Pest Control (check for transfers)_12138753933 - Outgoing', 'ASCND  AI Agent - Pest Control - Outgoing'),
  ('ASCND AI Agent - Pest Control_13854693345 - Outgoing', 'ASCND  AI Agent - Pest Control - Outgoing'),
  ('ASCND Ai Agent - appliance repair_12138452562 - outgoing', 'ASCND Ai Agent - appliance repair - outgoing'),
  ('ASCND AI Agent - Auto Accident Personal Injury Lawyer (Check for Transfers)_12136582370 - Outgoing', 'ASCND AI Agent - Auto Accident Personal Injury Lawyer (Check for Transfers) - Outgoing'),
  ('ASCND AI Agent - Auto Ins (Check 4 ins +Transfers)_12136353865 - Outgoing', 'ASCND AI Agent - Auto Ins (Check 4 ins +Transfers) - Outgoing'),
  ('ASCND AI Agent - Auto Ins compliance_15054777993 - Outgoing', 'ASCND AI Agent - Auto Ins compliance - Outgoing'),
  ('ASCND AI Agent - Bathroom Remodeling_12136480864 - Outgoing', 'ASCND AI Agent - Bathroom Remodeling - Outgoing'),
  ('ASCND AI Agent - Check For Transfers (Generic)_12135832643 - Outgoing', 'ASCND AI Agent - Check For Transfers (Generic) - Outgoing'),
  ('ASCND AI Agent - Dental (Check for Transfers)_12135101511 - Outgoing', 'ASCND Ai Agent - Dental (Check for Transfers) - Outgoing'),
  ('ASCND AI Agent - Dentist (Check for Transfers)_12137273319 - Outgoing', 'ASCND AI Agent - Dentist (Check for Transfers) - Outgoing'),
  ('ASCND Ai Agent - electrician_12135945908 - outgoing', 'ASCND Ai Agent - electrician - outgoing'),
  ('ASCND AI Agent - Electrician Compliance_19843418170 - outgoing', 'ASCND Ai Agent - electrician compliance - outgoing'),
  ('ASCND AI Agent - Fiat Compliance_12135395663 - Outgoing', 'ASCND AI Agent - Fiat Compliance - Outgoing'),
  ('ASCND AI Agent - Final Expense_12138348712 - Outgoing', 'ASCND AI Agent - Final Expense - Outgoing'),
  ('ASCND Ai Agent - foundation_12138452015 - outgoing', 'ASCND Ai Agent - foundation - outgoing'),
  ('ASCND AI Agent - Gutters (Check for Transfers)_12135562636 - Outgoing', 'ASCND AI Agent - Gutters (Check for Transfers) - Outgoing'),
  ('ASCND AI Agent - Home Improvements_13855037537 - Outgoing', 'ASCND AI Agent - Home Improvements - Outgoing'),
  ('ASCND AI Agent - Home Insurance_12135274694 - Outgoing', 'ASCND AI Agent - Home Insurance - Outgoing'),
  ('ASCND Ai Agent - hvac_12135261230 - outgoing', 'ASCND Ai Agent - hvac - outgoing'),
  ('ASCND Ai Agent - hvac compliance_14246552605 - outgoing', 'ASCND Ai Agent - hvac compliance - outgoing'),
  ('ASCND AI Agent - Lawyer_13855583804 - Outgoing', 'ASCND AI Agent - Lawyer - Outgoing'),
  ('ASCND AI Agent - Moving_12136956404 - Outgoing', 'ASCND AI Agent - Moving - Outgoing'),
  ('ASCND AI Agent - Pest Control Compliance_15863524632 - Outgoing', 'ASCND AI Agent - Pest Control Compliance - Outgoing'),
  ('ASCND AI Agent - Pest Control D2M_12134973334 - Outgoing', 'ASCND AI Agent - Pest Control D2M - Outgoing'),
  ('ASCND AI Agent - Plumber Compliance_17542901303 - Outgoing', 'ASCND AI Agent - Plumber Compliance - Outgoing'),
  ('ASCND AI Agent - Roofing (Check for Transfers)_12137726114 - Outgoing', 'ASCND AI Agent - Roofing (Check for Transfers) - Outgoing'),
  ('ASCND Ai Agent - water damage_12138451615 - outgoing', 'ASCND AI Agent - water damage - outgoing'),
  ('ASCND AI Agent - Windows_12136586541 - Outgoing', 'ASCND AI Agent - Windows - Outgoing'),
  -- matched on ivr_id (same Canoe IVR, old name had a different word order)
  ('ASCND AI Agent - Multi-Category (GLS)_13853556134 - Outgoing', 'ASCND AI Agent - Outgoing - Multi-Category (GLS)'),
  -- renamed IVRs whose agent is registered in step 1
  ('ASCND AI Agent - home service compliance_12136721980 - Outgoing', 'ASCND AI Agent - home service compliance - Outgoing'),
  ('ASCND AI Agent - Check For Transfers + marketplace_12139315396 - Outgoing', 'ASCND AI Agent - Check For Transfers + marketplace - Outgoing'),
  ('ASCND AI Agent - Pest Control BH Direct_13853967493 - Outgoing', 'ASCND AI Agent - Pest Control BH Direct - Outgoing'),
  ('ASCND AI Agent - Insurance (auto+home)_12135834624 - Outgoing', 'ASCND AI Agent - Insurance (auto+home) - Outgoing')
on conflict (ivr_name) do nothing;

-- ── 3) Self-healing: key renames on Canoe's stable ivr_id ──────────────────
create table if not exists agent_canoe_ivr_ids (
  ivr_id             text primary key,
  canonical_ivr_name text not null,
  created_at         timestamptz default now()
);
alter table agent_canoe_ivr_ids enable row level security;
drop policy if exists "auth users can read agent_canoe_ivr_ids" on agent_canoe_ivr_ids;
create policy "auth users can read agent_canoe_ivr_ids"
  on agent_canoe_ivr_ids for select to authenticated using (true);

-- Learn, then heal, over calls in the trailing window. Returns aliases added.
--  learn: an ivr_id seen under a registered name (agent or alias) maps to that
--         agent. Ids seen under two different agents are ambiguous and skipped.
--  heal : an unregistered ASCND name whose ivr_id is mapped becomes an alias of
--         that agent. Non-AI Canoe IVRs ("Skip IVR", ...) are never touched.
create or replace function heal_renamed_ivr_aliases(days_back int default 7)
returns int language plpgsql security definer set search_path = public as $$
declare added int;
begin
  create temp table _ivr_seen on commit drop as
    select ivr_name, ivr_id, count(*) as calls
    from canoe_calls
    where created_at >= now() - make_interval(days => days_back)
      and ivr_id is not null and ivr_name ilike 'ascnd%'
    group by 1, 2;

  insert into agent_canoe_ivr_ids (ivr_id, canonical_ivr_name)
  select s.ivr_id, min(k.canon)
  from _ivr_seen s
  join (select ivr_name as n, ivr_name as canon from agents
        union all
        select al.ivr_name, al.canonical_ivr_name
        from agent_ivr_aliases al join agents a on a.ivr_name = al.canonical_ivr_name) k
    on k.n = s.ivr_name
  group by s.ivr_id
  having count(distinct k.canon) = 1
  on conflict (ivr_id) do nothing;

  insert into agent_ivr_aliases (ivr_name, canonical_ivr_name)
  select distinct on (s.ivr_name) s.ivr_name, m.canonical_ivr_name
  from _ivr_seen s
  join agent_canoe_ivr_ids m on m.ivr_id = s.ivr_id
  join agents a on a.ivr_name = m.canonical_ivr_name
  where not exists (select 1 from agents x where x.ivr_name = s.ivr_name)
    and not exists (select 1 from agent_ivr_aliases x where x.ivr_name = s.ivr_name)
  order by s.ivr_name, s.calls desc
  on conflict (ivr_name) do nothing;
  get diagnostics added = row_count;

  drop table _ivr_seen;
  return added;
end;
$$;
alter function heal_renamed_ivr_aliases(int) set statement_timeout = '5min';
revoke execute on function heal_renamed_ivr_aliases(int) from public, anon, authenticated;
grant execute on function heal_renamed_ivr_aliases(int) to service_role;

-- Initial learn over all ASCND history (ASCND calls start 2026-05-31), after the
-- aliases above. Expected to add 0 aliases now that step 2 covers every rename.
select heal_renamed_ivr_aliases(200) as aliases_added;

-- Daily at 00:45 UTC, after the 00:00 sync. A 7-day window tolerates a late or
-- failed sync. cron.schedule upserts by job name, so re-running is safe.
create extension if not exists pg_cron;
select cron.schedule('heal-renamed-ivr-aliases', '45 0 * * *', $$select public.heal_renamed_ivr_aliases(7)$$);

-- ── Verify (read-only) ─────────────────────────────────────────────────────
-- Every ASCND name with calls since Oct 7 is now registered or aliased, except
-- two one-call '- Incoming' names (hvac, multicategory GLS) and any genuinely new
-- IVR that appears after this migration.
-- select ivr_name, count(*) from canoe_calls
-- where created_at >= '2026-10-07' and ivr_name ilike 'ascnd%'
--   and ivr_name not in (select ivr_name from agents union select ivr_name from agent_ivr_aliases)
-- group by 1 order by 2 desc;
