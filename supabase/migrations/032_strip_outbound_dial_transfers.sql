-- ============================================================
-- 032_strip_outbound_dial_transfers.sql
-- Transfer verticals expect an outbound dial, so the model's `outbound_dial` flag on
-- them is noise (it clutters the account-manager summary emails). process.js now strips
-- it at scoring time (buildResultPatch; transfer verticals matched by "transfer" in the
-- vertical name). This one-time UPDATE removes it from already-scored transfer calls so
-- past + rolling summaries drop it too (~135 rows). alert.js reads flags straight from
-- the row, so no alert.js change is needed.
-- Run in Supabase SQL Editor (or supabase db query --linked).
-- ============================================================

update canoe_calls
set flags = flags - 'outbound_dial'
where vertical_name ilike '%transfer%' and flags @> '["outbound_dial"]'::jsonb;
