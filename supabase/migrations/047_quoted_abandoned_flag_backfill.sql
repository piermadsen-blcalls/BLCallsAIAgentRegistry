-- ============================================================
-- 047_quoted_abandoned_flag_backfill.sql
-- MK-184 (decided with Vicky 2026-10-16): quoted_abandoned is an outcome AND a compliance
-- flag. scripts/process.js now adds the flag at scoring time (addOutcomeFlags); this
-- backfills calls scored before that. It shows in flag filters / "Flagged only" / flagged
-- counts, but NOT in the AM digest (alert.js AI_FLAGS excludes it).
-- Apply AFTER the process.js change is on main, so no newly scored call misses it.
-- Idempotent. ~2,457 rows at time of writing.
-- ============================================================

update canoe_calls
set flags = coalesce(flags, '[]'::jsonb) || '["quoted_abandoned"]'::jsonb
where our_outcome = 'quoted_abandoned'
  and not (coalesce(flags, '[]'::jsonb) ? 'quoted_abandoned');
