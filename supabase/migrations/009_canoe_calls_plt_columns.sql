-- ============================================================
-- 009_canoe_calls_plt_columns.sql
-- Add phone-lead-transaction fields to canoe_calls.
-- Run in Supabase SQL Editor.
-- ============================================================

alter table canoe_calls
  add column if not exists recording_id        text,
  add column if not exists ivr_id              text,
  add column if not exists ivr_name            text,
  add column if not exists ivr_duration        integer,
  add column if not exists connect_duration    integer,
  add column if not exists result              text,
  add column if not exists advertiser_payin    numeric,
  add column if not exists publisher_payout    numeric,
  add column if not exists advertiser_bid      numeric,
  add column if not exists publisher_bid       numeric,
  add column if not exists line_type           text,
  add column if not exists is_test             boolean default false;

create index if not exists canoe_calls_recording_id_idx on canoe_calls (recording_id) where recording_id is not null;
create index if not exists canoe_calls_result_idx       on canoe_calls (result);
