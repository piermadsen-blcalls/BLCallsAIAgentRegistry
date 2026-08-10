-- ============================================================
-- 023_ivr_breakdown_idx.sql
-- agent_breakdown (per-agent drawer) filters ivr_name = any(...) + created_at,
-- but the only index was on created_at, so it scanned the whole window to find
-- one agent's calls. This (ivr_name, created_at) covering partial index lets it
-- seek straight to that agent's rows in the window — fractions of a second.
--
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

create index if not exists canoe_calls_ivr_created_idx
  on canoe_calls (ivr_name, created_at)
  include (publisher_name, advertiser_name, connect_duration, result, advertiser_payin)
  where is_test is not true;
