-- ============================================================
-- Regression test for 068_mcp_calls_covering_idx.sql: the index exists, is valid and covers
-- every column the connector's aggregate_calls / list_values SQL reads, so those queries can be
-- answered index-only. Read-only; safe on production. (After applying on prod, an EXPLAIN of a
-- 90-day aggregate_calls query should show "Index Only Scan using canoe_calls_mcp_cover_idx".)
-- ============================================================
do $$
declare
  cols text[];
  need text[] := array['created_at', 'publisher_name', 'advertiser_name', 'vertical_name', 'campaign_name', 'ivr_name',
                       'our_outcome', 'result', 'connect_duration', 'advertiser_payin', 'publisher_payout',
                       'publisher_score', 'advertiser_score', 'flags', 'suspicious_call', 'is_test', 'called_from'];
begin
  assert exists (select 1 from pg_index where indexrelid = 'public.canoe_calls_mcp_cover_idx'::regclass and indisvalid),
    'canoe_calls_mcp_cover_idx exists and is valid (a failed CONCURRENTLY build leaves it invalid)';
  select array_agg(a.attname::text) into cols
  from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
  where i.indexrelid = 'public.canoe_calls_mcp_cover_idx'::regclass;
  assert cols @> need, format('covers %s, has %s', need, cols);
  assert (select indnkeyatts from pg_index where indexrelid = 'public.canoe_calls_mcp_cover_idx'::regclass) = 1, 'keyed on created_at only';
  assert (select indpred is null from pg_index where indexrelid = 'public.canoe_calls_mcp_cover_idx'::regclass), 'not partial';
end $$;
