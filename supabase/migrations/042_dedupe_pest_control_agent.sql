-- ============================================================
-- 042_dedupe_pest_control_agent.sql  (one-off data cleanup, not a schema change)
--
-- Canoe emits the Pest Control IVR under two spellings that differ only by a
-- DOUBLE SPACE after "ASCND":
--   canonical : 'ASCND  AI Agent - Pest Control - Outgoing'   (two spaces)
--   variant   : 'ASCND AI Agent - Pest Control - Outgoing'    (one space)
-- agent_ivr_aliases already folds the variant into the canonical. But an
-- `agents` row was ALSO created against the variant, mis-named "Pest Control
-- Compliance" (the real compliance agent is a different IVR,
-- '...Pest Control Compliance - Outgoing'). That row can never match its own
-- count bucket on the Review board — review_counts sums into the canonical key
-- while the board renders the variant key — so it read "—" no matter how many
-- of its 242 calls were reviewed.
--
-- The alias is the correct statement of intent: it is ONE agent. Drop the
-- duplicate `agents` row so the variant's calls report under "Pest Control".
-- (The frontend read-side fix that resolves board lookups through the alias map
-- is in index.html; this migration removes the bad row that fix exposes.)
--
-- Run the blocks in order in the Supabase SQL editor.
-- ============================================================

-- 1) INSPECT FIRST. Confirm exactly two rows and that the one you are about to
--    delete holds nothing you want to keep (qualifying, publisher_campaigns,
--    ivr_targets, notes, canoe_url are all lost with it). If the variant row has
--    hand-entered detail the canonical lacks, copy it across before step 3.
select name, ivr_name, status, routing_type, canoe_url, notes,
       jsonb_array_length(coalesce(to_jsonb(qualifying), '[]'::jsonb))          as n_qualifying,
       jsonb_array_length(coalesce(to_jsonb(publisher_campaigns), '[]'::jsonb)) as n_pub_campaigns,
       jsonb_array_length(coalesce(to_jsonb(ivr_targets), '[]'::jsonb))         as n_ivr_targets
from agents
where ivr_name in (
  'ASCND  AI Agent - Pest Control - Outgoing',
  'ASCND AI Agent - Pest Control - Outgoing'
)
order by ivr_name;

-- 2) Fold any reviewer assignment held under the variant onto the canonical
--    (ivr_name is the PK, so keep the canonical's own assignment if it has one),
--    then drop the now-redundant variant row.
insert into agent_review_assignments (ivr_name, manager_id, assigned_by, assigned_at)
select 'ASCND  AI Agent - Pest Control - Outgoing', manager_id, assigned_by, assigned_at
from agent_review_assignments
where ivr_name = 'ASCND AI Agent - Pest Control - Outgoing'
on conflict (ivr_name) do nothing;

delete from agent_review_assignments
where ivr_name = 'ASCND AI Agent - Pest Control - Outgoing';

-- 3) Drop the duplicate agents row. Scoped by BOTH name and ivr_name so it
--    cannot touch the real '...Pest Control Compliance - Outgoing' agent.
delete from agents
where ivr_name = 'ASCND AI Agent - Pest Control - Outgoing'
  and name = 'Pest Control Compliance';

-- Nothing cascades: agent_reviews / call_reviews / agent_test_calls key off
-- ivr_name as plain text with no FK to agents, and the board resolves those
-- keys through agent_ivr_aliases, so the existing 12 reviews on the variant
-- name keep counting — they just report under "Pest Control" now.

-- 4) Verify: one Pest Control row, one Pest Control Compliance row, and the
--    variant name still aliased to the canonical.
-- select name, ivr_name from agents where ivr_name ilike '%pest control%' order by ivr_name;
-- select ivr_name, canonical_ivr_name from agent_ivr_aliases where ivr_name ilike '%pest control%';
