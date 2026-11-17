-- ============================================================
-- Rollback for 068_mcp_calls_covering_idx.sql. Drops the index; the connector keeps working,
-- with long-range aggregates slower again. Run on its own, outside a transaction.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

drop index concurrently if exists public.canoe_calls_mcp_cover_idx;
