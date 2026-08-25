-- ============================================================
-- 040_agent_reviews_answers.sql
-- The Review questions were reworked (qualification accuracy / drop-off /
-- understanding / script / wording / top change). Store the answers as a
-- single JSONB blob so the question set can evolve without a schema change.
-- The older typed columns (handling, has_glitches, ...) stay for back-compat
-- but are no longer written.
-- Run in Supabase SQL Editor.
-- ============================================================

alter table agent_reviews add column if not exists answers jsonb;
