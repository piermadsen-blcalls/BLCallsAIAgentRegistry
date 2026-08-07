-- ============================================================
-- 018_scoring_vectors_index.sql
-- Speed up outcome_score_vectors(). canoe_calls is wide (transcript
-- columns), so a seq scan to find the "comparable set" (both outcomes
-- present) times out. This partial index covers exactly that set,
-- keyed by created_at for the window filter.
--
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

create index if not exists canoe_calls_comparable_created_idx
  on canoe_calls (created_at)
  where our_outcome is not null
    and canoe_outcome is not null
    and is_test is not true;

-- Safety net for large windows once enrichment scales the comparable set.
alter function outcome_score_vectors(timestamptz, timestamptz, text)
  set statement_timeout = '30s';
