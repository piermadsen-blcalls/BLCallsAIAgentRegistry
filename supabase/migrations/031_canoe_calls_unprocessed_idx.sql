-- ============================================================
-- 031_canoe_calls_unprocessed_idx.sql
-- process.js fetchUnprocessed() selects ai_processed_at IS NULL calls ordered by
-- created_at. Early in a backfill that's cheap (unprocessed rows are dense). As it
-- drains, unprocessed rows become sparse in the window, so the created_at scan filters
-- ~100k already-processed rows to find them → 57014 statement timeout, which stalled
-- the backfill's submit step (it fetched nothing). Partial index over ONLY the rows
-- fetchUnprocessed actually wants (unprocessed AND transcribed) keeps that lookup fast
-- and shrinks as the backlog drains. Predicate matches the query exactly so the planner
-- uses it (a broader `ai_processed_at is null` predicate still dragged through untranscribed
-- rows: ~5.4s). Result: ~78ms.
-- Run in Supabase SQL Editor.
-- ============================================================

create index if not exists canoe_calls_unprocessed_idx
  on canoe_calls (created_at)
  where ai_processed_at is null and transcription is not null and transcription <> '';
