-- ============================================================
-- 010_pending_transcription_idx.sql
-- Speeds up Pass 2's "rows with a recording but no transcription yet"
-- keyset query (ordered by created_at desc). Partial index stays small —
-- rows leave it as soon as transcription is filled in.
-- Run in Supabase SQL Editor.
-- ============================================================

create index if not exists canoe_calls_pending_transcription_idx
  on canoe_calls (created_at desc)
  where transcription is null and recording_id is not null;
