-- ============================================================
-- 053_rollup_backfill.sql
-- One-time rebuild of the three daily rollups over their full history, AFTER 052 is applied.
-- The old refresh functions (before 052) dropped the first ~hour of the boundary day every
-- night, and the loss became permanent once the day aged out of the refresh window. As of
-- 2026-11-12 (read-only check against canoe_calls):
--   agent_metrics_daily       92 days short, 3,086 calls / $21,984.79 (2026-06-29 .. 09-28)
--   agent_counterparty_daily  27 days short, 1,166 calls per side     (2026-09-02 .. 09-28)
--   outcome_score_daily        6 days short                           (05-31..06-02, 07-13..07-15)
-- Each refresh deletes and re-inserts its window from canoe_calls (the source of truth), so
-- this is idempotent and safe to re-run. Rough cost: ~1-4 min each on the current instance;
-- run it outside the 06:45-07:10 UTC nightly refreshes (they would just wait on the lock).
-- Rollback: none needed (the rollups are derived data; re-running a refresh reproduces them).
-- Check afterwards: the "rollup vs raw" queries in supabase/tests/052_rollup_refresh_after_sync_test.sql.
-- Run in Supabase SQL Editor (or supabase db query --linked -f), one statement at a time.
-- ============================================================

select refresh_agent_metrics_daily(4000);
select refresh_agent_counterparty_daily(4000);
select refresh_outcome_score_daily(4000);
