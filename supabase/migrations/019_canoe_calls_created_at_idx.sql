-- ============================================================
-- 019_canoe_calls_created_at_idx.sql
-- alert.js fetches canoe_calls by a created_at window (paginated) each run.
-- Without an index on created_at that's a seq scan over a wide table and
-- intermittently hits the statement timeout (57014) on larger windows.
-- A plain btree on created_at turns it into an index range scan.
--
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

create index if not exists canoe_calls_created_at_idx on canoe_calls (created_at);
