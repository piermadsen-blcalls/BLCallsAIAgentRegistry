-- ============================================================
-- 051_scores_pairings_rpc.sql
-- Scores tab speed. outcome_score_vectors (041) returns long-format rows (entity x vertical x
-- source x outcome): ~22.4k rows / 2.8 MB of JSON for the Master 90d publisher view, which the
-- page folds back into ~1.55k pairings. Its plan is the bigger cost: with the default 2 MB
-- work_mem the 22k-group HashAggregate doesn't fit, so Postgres walks the rollup's primary key in
-- group order and fetches every heap row at random (~104k buffers; 8.7-14 s measured 2026-11-12,
-- over the 8 s statement timeout for signed-in users).
--
-- 1. outcome_score_pairings(): same rollup, same window rules, one row per pairing with the two
--    outcome vectors as jsonb (~1.55k rows / ~0.6 MB). index.html calls it and falls back to
--    outcome_score_vectors while this migration is unapplied.
-- 2. Both functions run with work_mem 16MB and index scans off (function-local settings), so the
--    aggregate hashes in memory over a bitmap scan of outcome_score_daily_type_day_idx:
--    ~4.3k buffers, ~0.35 s (EXPLAIN ANALYZE on prod, read-only, same window).
--
-- SECURITY INVOKER: reads go through the existing "auth users can read outcome_score_daily" RLS
-- policy, so anon gets nothing even though Supabase grants new functions to anon by default;
-- EXECUTE is also revoked from anon/public. No change to existing grants or policies.
--
-- Rollback:
--   drop function if exists outcome_score_pairings(timestamptz, timestamptz, text);
--   alter function outcome_score_vectors(timestamptz, timestamptz, text) reset work_mem;
--   alter function outcome_score_vectors(timestamptz, timestamptz, text) reset enable_indexscan;
-- Run in Supabase SQL Editor (or supabase db query --linked).
-- ============================================================

create or replace function outcome_score_pairings(
  from_ts     timestamptz,
  to_ts       timestamptz,
  entity_type text default 'publisher'
)
returns table (
  entity_name text,
  vertical    text,
  canoe       jsonb,   -- { outcome: calls } from Canoe outcomes
  ours        jsonb    -- { outcome: calls } from Registry (our) outcomes
)
language sql stable
set search_path = ''
set work_mem = '16MB'
set enable_indexscan = off
as $$
  with v as (
    select d.entity_name, d.vertical, d.source, d.outcome, sum(d.n)::bigint as n
    from public.outcome_score_daily d
    where d.entity_type = outcome_score_pairings.entity_type
      and d.day >= (from_ts at time zone 'UTC')::date
      and d.day <  (to_ts   at time zone 'UTC')::date
    group by d.entity_name, d.vertical, d.source, d.outcome
  )
  select v.entity_name, v.vertical,
         coalesce(jsonb_object_agg(v.outcome, v.n) filter (where v.source = 'canoe'), '{}'::jsonb),
         coalesce(jsonb_object_agg(v.outcome, v.n) filter (where v.source = 'ours'),  '{}'::jsonb)
  from v
  group by v.entity_name, v.vertical;
$$;
revoke execute on function outcome_score_pairings(timestamptz, timestamptz, text) from public, anon;
grant execute on function outcome_score_pairings(timestamptz, timestamptz, text) to authenticated;

-- Same plan fix for the long-format RPC (the page's fallback until the line above is applied).
alter function outcome_score_vectors(timestamptz, timestamptz, text) set work_mem = '16MB';
alter function outcome_score_vectors(timestamptz, timestamptz, text) set enable_indexscan = off;
