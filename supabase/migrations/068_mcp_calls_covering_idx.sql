-- ============================================================
-- 068_mcp_calls_covering_idx.sql
-- Speed for the Claude connector's aggregate questions (aggregate_calls, list_values and most
-- run_sql questions): they read a date range of calls and a few columns. canoe_calls rows are
-- wide (summaries and short transcripts sit inline: about 1.4 rows per 8 kB page), so walking the
-- created_at index and fetching each row is slow. Measured on prod 2026-11-17 (read-only EXPLAIN
-- ANALYZE): 7 days by publisher with outcomes 0.45 s; 90 days by day with outcomes 6.7 s, close
-- to the 8 s statement timeout, so a full-history question would time out. The same 90 days read
-- index-only from canoe_calls_rollup_idx (which lacks outcome, vertical and flags) took 0.41 s.
--
-- This index covers every column the connector's filters and metrics use, so those queries are
-- index-only scans. Not partial on is_test: run_sql questions may not filter it. About 150 MB
-- (prod database 1.8 GB). Non-security; no data changes.
--
-- CONCURRENTLY, so the sync keeps writing during the build (a plain CREATE INDEX would block
-- canoe_calls writes for the whole build): run this file on its own, as one statement, outside a
-- transaction. If a concurrent build fails it leaves an INVALID index: drop it (rollback) and rerun.
-- Rollback: supabase/rollbacks/068_mcp_calls_covering_idx_down.sql
-- Test:     supabase/tests/068_mcp_calls_covering_idx_test.sql
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

create index concurrently if not exists canoe_calls_mcp_cover_idx on public.canoe_calls (created_at)
  include (publisher_name, advertiser_name, vertical_name, campaign_name, ivr_name, our_outcome, result,
           connect_duration, advertiser_payin, publisher_payout, publisher_score, advertiser_score,
           flags, suspicious_call, is_test, called_from);
