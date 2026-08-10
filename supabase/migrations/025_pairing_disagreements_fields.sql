-- ============================================================
-- 025_pairing_disagreements_fields.sql
-- Widen pairing_disagreements to return the same call fields the Call Reporting
-- table shows (publisher, advertiser, duration, disposition) alongside the two
-- outcomes + recording, so the Scores drawer list matches Call Reporting.
-- (Caller/phone deliberately excluded — consumer lead data.)
-- Return-type change requires drop + create.
--
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

drop function if exists pairing_disagreements(text, text, text, timestamptz, timestamptz);

create function pairing_disagreements(
  entity_type text, entity_name text, vertical text, from_ts timestamptz, to_ts timestamptz
)
returns table (
  id text, created_at timestamptz, publisher_name text, advertiser_name text,
  ivr_duration integer, disposition text, canoe_outcome text, our_outcome text, recording_url text
)
language sql security definer stable as $$
  select id, created_at, publisher_name, advertiser_name,
         ivr_duration::integer, disposition, canoe_outcome, our_outcome, recording_url
  from canoe_calls
  where is_test is not true
    and ai_processed_at is not null
    and canoe_outcome is not null and our_outcome is not null
    and canoe_outcome <> our_outcome
    and coalesce(nullif(vertical_name, ''), '(unknown)') = vertical
    and (case when entity_type = 'advertiser' then advertiser_name else publisher_name end) = entity_name
    and created_at >= from_ts and created_at < to_ts
  order by created_at desc
  limit 500;
$$;
alter function pairing_disagreements(text, text, text, timestamptz, timestamptz) set statement_timeout = '20s';
grant execute on function pairing_disagreements(text, text, text, timestamptz, timestamptz) to authenticated;
