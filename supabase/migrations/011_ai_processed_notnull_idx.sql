-- ============================================================
-- 011_ai_processed_notnull_idx.sql
-- Compliance tab's compLoadStats filters `ai_processed_at IS NOT NULL`.
-- With canoe_calls now ~190k rows and no AI-processed rows yet, that query
-- full-scans and hits the statement timeout (57014). This complements the
-- existing IS NULL partial index (from 001) with the NOT NULL side.
-- Run in Supabase SQL Editor.
-- ============================================================

create index if not exists canoe_calls_ai_processed_notnull_idx
  on canoe_calls (ai_processed_at desc)
  where ai_processed_at is not null;
