-- ============================================================
-- 034_ascnd_intent_agent_phone.sql
-- ASCND's webhook now also sends `intent` and `ai_agent_phone_number`.
--   1) Add receiving columns on hl_call_data (the ASCND landing table).
--   2) Add matching columns on canoe_calls (the master table).
--   3) Extend sync_hl_to_canoe_calls to carry both onto canoe_calls
--      during the existing phone + time pairing.
--
-- PAIRING KEY IS UNCHANGED — still caller phone (h.phone -> c.called_from)
-- + call time (±7s, nearest wins). ai_agent_phone_number is CARRIED THROUGH,
-- not yet used as a join key: historical hl_call_data rows don't have it, and
-- we want to validate it against canoe_calls.called_to on real data before
-- hardening the join. That is a deliberate follow-up, not this migration.
-- Run in Supabase SQL Editor.
-- ============================================================

-- 1) receive the new webhook fields on the ASCND landing table
alter table hl_call_data
  add column if not exists intent                text,
  add column if not exists ai_agent_phone_number text;

-- 2) carry them onto the master table
alter table canoe_calls
  add column if not exists intent                text,
  add column if not exists ai_agent_phone_number text;

-- 3) extend the pairing to also copy intent + ai_agent_phone_number.
create or replace function sync_hl_to_canoe_calls(from_ts timestamptz, to_ts timestamptz)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  updated int := 0;
begin
  with matched as (
    select
      c.id                      as call_id,
      h.disposition             as disposition,
      h.disposition_description as disposition_description,
      h.recording_url           as ascnd_recording_url,
      h.transcript              as ascnd_transcript,
      h.intent                  as intent,
      h.ai_agent_phone_number   as ai_agent_phone_number
    from canoe_calls c
    cross join lateral (
      select h.*
      from hl_call_data h
      where right(regexp_replace(coalesce(h.phone,''), '[^0-9]', '', 'g'), 10)
          = right(regexp_replace(coalesce(c.called_from,''), '[^0-9]', '', 'g'), 10)
        and abs(extract(epoch from (c.created_at - h.call_timestamp))) <= 7
      order by abs(extract(epoch from (c.created_at - h.call_timestamp))) asc
      limit 1
    ) h
    where c.created_at >= from_ts
      and c.created_at <  to_ts
      and c.disposition is null
      and c.ivr_name ilike 'ascnd%'
      and right(regexp_replace(coalesce(c.called_from,''), '[^0-9]', '', 'g'), 10) <> ''
  )
  update canoe_calls c
  set disposition             = m.disposition,
      disposition_description = m.disposition_description,
      ascnd_recording_url     = m.ascnd_recording_url,
      ascnd_transcript        = m.ascnd_transcript,
      intent                  = m.intent,
      ai_agent_phone_number   = m.ai_agent_phone_number
  from matched m
  where c.id = m.call_id;

  get diagnostics updated = row_count;
  return updated;
end;
$$;

grant execute on function sync_hl_to_canoe_calls(timestamptz, timestamptz) to anon, authenticated, service_role;
