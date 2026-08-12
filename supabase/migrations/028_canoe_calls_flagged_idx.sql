-- ============================================================
-- 028_canoe_calls_flagged_idx.sql
-- The Calls tab "Flagged only" view (and flagged counts) over a wide date range
-- scanned ~100k rows applying the jsonb `flags <> '[]'` filter one-by-one (~12s),
-- over the authenticated role's 8s statement_timeout → 57014 canceled statement.
-- A partial index on created_at for flagged rows only lets those queries touch
-- just the flagged rows (a few hundred), keeping counts EXACT and fast.
-- Run in Supabase SQL Editor.
-- ============================================================

create index if not exists canoe_calls_flagged_created_idx
  on canoe_calls (created_at desc)
  where flags <> '[]'::jsonb;
