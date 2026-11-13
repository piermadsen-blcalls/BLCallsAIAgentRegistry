-- ============================================================
-- 061: canoe_calls upkeep (free speed fixes from the Nov 12 DB re-measure, audit N13)
--
-- 1) Autovacuum about daily instead of every ~2 weeks. With the default 20% scale factor it
--    waited for ~105k dead rows: last autovacuum was Oct 30, 44k dead rows, only 75% of pages
--    all-visible, so "index-only" scans on recent days visited the heap once per row.
-- 2) fillfactor 90: new pages keep room for HOT updates (only 24.5% of updates were HOT).
-- 3) Drop 5 indexes nothing reads (idx_scan since 2026-04-16 in brackets). Each non-HOT update
--    wrote all 25 indexes; now 20.
-- 4) upsert_canoe_calls(rows): sync.js Pass 1 re-upserts every call of a 2-3 day window each
--    run, and the plain PostgREST upsert rewrote every row (synced_at changed each time). This
--    skips rows whose Canoe fields are unchanged, so synced_at now means "last changed".
--
-- After applying, run once outside a transaction (SQL editor, off-peak):
--   vacuum (analyze) public.canoe_calls;
-- Rollback: supabase/rollbacks/061_canoe_calls_vacuum_and_noop_upsert_down.sql
-- ============================================================

set lock_timeout = '5s';

alter table public.canoe_calls set (
  autovacuum_vacuum_scale_factor        = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor       = 0.02,
  fillfactor                            = 90
);

drop index if exists public.canoe_calls_vertical_id_idx;    -- 7.9 MB [0]
drop index if exists public.canoe_calls_ai_processed_idx;   -- 5.3 MB [0]; canoe_calls_unprocessed_idx serves the queue
drop index if exists public.canoe_calls_publisher_id_idx;   -- 8.2 MB [1, last 2026-06-24]
drop index if exists public.canoe_calls_advertiser_id_idx;  -- 7.4 MB [3, last 2026-06-24]
drop index if exists public.canoe_calls_result_idx;         -- 7.2 MB [15, last 2026-08-15]

-- Same columns as mapPLT() in scripts/sync.js. Returns the number of rows inserted or changed.
-- jsonb_populate_recordset is what PostgREST's own upsert uses, so values coerce the same way;
-- columns not listed keep their defaults on insert and their current values on update.
create or replace function public.upsert_canoe_calls(rows jsonb)
returns integer
language sql
set search_path = ''
as $$
  with w as (
    insert into public.canoe_calls as c (
      id, lead_id, publisher_id, publisher_name, advertiser_id, advertiser_name,
      vertical_id, vertical_name, campaign_id, campaign_name, api_campaign_id, api_campaign_name,
      promo_number_id, promo_number_name, ivr_id, ivr_name, called_from, called_to,
      zip, city, state, line_type, keypresses, ivr_duration, connect_duration, result,
      advertiser_payin, advertiser_bid, publisher_payout, publisher_bid, recording_id, is_test,
      created_at, synced_at)
    select
      id, lead_id, publisher_id, publisher_name, advertiser_id, advertiser_name,
      vertical_id, vertical_name, campaign_id, campaign_name, api_campaign_id, api_campaign_name,
      promo_number_id, promo_number_name, ivr_id, ivr_name, called_from, called_to,
      zip, city, state, line_type, keypresses, ivr_duration, connect_duration, result,
      advertiser_payin, advertiser_bid, publisher_payout, publisher_bid, recording_id, is_test,
      created_at, synced_at
    from jsonb_populate_recordset(null::public.canoe_calls, rows)
    on conflict (id) do update set
      lead_id = excluded.lead_id, publisher_id = excluded.publisher_id,
      publisher_name = excluded.publisher_name, advertiser_id = excluded.advertiser_id,
      advertiser_name = excluded.advertiser_name, vertical_id = excluded.vertical_id,
      vertical_name = excluded.vertical_name, campaign_id = excluded.campaign_id,
      campaign_name = excluded.campaign_name, api_campaign_id = excluded.api_campaign_id,
      api_campaign_name = excluded.api_campaign_name, promo_number_id = excluded.promo_number_id,
      promo_number_name = excluded.promo_number_name, ivr_id = excluded.ivr_id,
      ivr_name = excluded.ivr_name, called_from = excluded.called_from,
      called_to = excluded.called_to, zip = excluded.zip, city = excluded.city,
      state = excluded.state, line_type = excluded.line_type, keypresses = excluded.keypresses,
      ivr_duration = excluded.ivr_duration, connect_duration = excluded.connect_duration,
      result = excluded.result, advertiser_payin = excluded.advertiser_payin,
      advertiser_bid = excluded.advertiser_bid, publisher_payout = excluded.publisher_payout,
      publisher_bid = excluded.publisher_bid, recording_id = excluded.recording_id,
      is_test = excluded.is_test, created_at = excluded.created_at,
      synced_at = excluded.synced_at
    where (c.lead_id, c.publisher_id, c.publisher_name, c.advertiser_id, c.advertiser_name,
           c.vertical_id, c.vertical_name, c.campaign_id, c.campaign_name, c.api_campaign_id,
           c.api_campaign_name, c.promo_number_id, c.promo_number_name, c.ivr_id, c.ivr_name,
           c.called_from, c.called_to, c.zip, c.city, c.state, c.line_type, c.keypresses,
           c.ivr_duration, c.connect_duration, c.result, c.advertiser_payin, c.advertiser_bid,
           c.publisher_payout, c.publisher_bid, c.recording_id, c.is_test, c.created_at)
      is distinct from
          (excluded.lead_id, excluded.publisher_id, excluded.publisher_name, excluded.advertiser_id,
           excluded.advertiser_name, excluded.vertical_id, excluded.vertical_name,
           excluded.campaign_id, excluded.campaign_name, excluded.api_campaign_id,
           excluded.api_campaign_name, excluded.promo_number_id, excluded.promo_number_name,
           excluded.ivr_id, excluded.ivr_name, excluded.called_from, excluded.called_to,
           excluded.zip, excluded.city, excluded.state, excluded.line_type, excluded.keypresses,
           excluded.ivr_duration, excluded.connect_duration, excluded.result,
           excluded.advertiser_payin, excluded.advertiser_bid, excluded.publisher_payout,
           excluded.publisher_bid, excluded.recording_id, excluded.is_test, excluded.created_at)
    returning 1
  )
  select count(*)::int from w;
$$;

revoke all on function public.upsert_canoe_calls(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_canoe_calls(jsonb) to service_role;
