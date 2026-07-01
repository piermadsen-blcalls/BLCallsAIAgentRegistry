-- ============================================================
-- 012_canoe_calls_ascnd_columns.sql
-- Adds the columns needed to make canoe_calls the single master table:
--   - recording_url        : the NORMAL call recording (from PLT, Pass 1)
--   - ascnd_recording_url   : the AI AGENT recording (from hl_call_data)
--   - ascnd_transcript      : transcript of the AI-agent leg (from hl_call_data)
--   - disposition           : ASCND disposition (from hl_call_data)
--   - disposition_description
-- Plus a functional index on hl_call_data for the phone+time pairing join.
-- Run in Supabase SQL Editor.
-- ============================================================

alter table canoe_calls
  add column if not exists recording_url           text,
  add column if not exists ascnd_recording_url     text,
  add column if not exists ascnd_transcript        text,
  add column if not exists disposition             text,
  add column if not exists disposition_description text;

-- Pairing join: normalized phone (last 10 digits) + timestamp.
-- Functional index on the ASCND side so the lateral nearest-match lookup is fast.
create index if not exists hl_call_data_phone10_ts_idx
  on hl_call_data (right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10), call_timestamp);

-- Speeds up the "ASCND agent calls still needing a disposition" scan.
create index if not exists canoe_calls_ascnd_pending_idx
  on canoe_calls (created_at desc)
  where disposition is null and ivr_name ilike 'ascnd%';
