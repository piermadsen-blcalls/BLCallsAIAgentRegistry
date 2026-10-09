-- ============================================================
-- 043_calls_outcome_vertical_idx.sql
-- MK-175: the Calls tab gained an outcome-group filter (our_outcome IN (...)) and a
-- vertical multi-select (vertical_name IN (...)). Exact-count queries with either filter
-- over a 90-day window timed out (57014, 8s authenticated cap): the only usable index was
-- created_at, so Postgres walked every call in the window and filtered on the wide heap.
-- These two indexes lead with the filtered column, are keyed (col, created_at) so the date
-- range stays a tight index range, and INCLUDE the other filter column so a combined
-- group+vertical count can be answered from the index without touching the heap.
-- Not partial on is_test: crBuildFilters does not filter is_test, so a partial predicate
-- would never match the query.
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

create index if not exists canoe_calls_outcome_created_idx
  on canoe_calls (our_outcome, created_at) include (vertical_name);

create index if not exists canoe_calls_vertical_created_idx
  on canoe_calls (vertical_name, created_at) include (our_outcome);
