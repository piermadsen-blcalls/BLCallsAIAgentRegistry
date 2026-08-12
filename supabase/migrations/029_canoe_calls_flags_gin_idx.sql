-- ============================================================
-- 029_canoe_calls_flags_gin_idx.sql
-- The Calls tab flag-type dropdown filters with a jsonb containment test
-- (flags @> '["outbound_dial"]'). Over a wide date range that scanned ~100k rows
-- (~12s > 8s statement_timeout → 57014). The partial index from 028 only covers the
-- `flags <> '[]'` (Flagged-only) case; the planner can't use it for @>. A GIN index
-- with jsonb_path_ops (compact, tuned for @>) makes containment lookups near-instant.
-- Run in Supabase SQL Editor.
-- ============================================================

create index if not exists canoe_calls_flags_gin_idx
  on canoe_calls using gin (flags jsonb_path_ops);
