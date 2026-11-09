-- ============================================================
-- 049_ascnd_pairing_dst_tolerant.sql
-- Since ~2026-11-03 04:00 UTC hl_call_data.call_timestamp lands exactly one
-- hour behind the real call time: the hl-call-webhook edge function resolved
-- Pacific time via America/Vancouver, which tzdata 2026 keeps on UTC-7 after
-- the US fall-back (fixed in the function). sync_hl_to_canoe_calls paired on
-- |canoe.created_at - hl.call_timestamp| <= 7s, so it paired nothing and no
-- AI call got an ascnd_transcript -> the Review tab ("Calls to review",
-- ASCND-only) stopped showing new calls.
--
-- Fix: accept a pairing gap within 7s of either 0 or +/-1h, preferring an
-- exact-time match whenever one exists. No hard-coded shift, so it pairs both
-- the rows already stored skewed (11-03 until the function fix is deployed)
-- and correct rows after it, and stays a safety net for future DST surprises.
--
-- Run in Supabase SQL Editor (block 1, then the backfill in block 2).
-- ============================================================

-- 1a) Pairing rank for a gap (seconds, canoe minus hl): lower is better,
--     null = not a pair. 0..7 = exact-time match; 100..107 = one hour off.
create or replace function ascnd_pair_rank(gap_s numeric)
returns numeric
language sql
immutable
as $$
  select case
    when abs(gap_s) <= 7                 then abs(gap_s)
    when abs(abs(gap_s) - 3600) <= 7     then 100 + abs(abs(gap_s) - 3600)
  end;
$$;

-- 1b) Same signature/return as 034; only the candidate window + ordering change.
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
        -- sargable bound for hl_call_data_phone10_ts_idx (+/-1h + 7s)
        and h.call_timestamp between c.created_at - interval '3607 seconds'
                                 and c.created_at + interval '3607 seconds'
        and ascnd_pair_rank(extract(epoch from (c.created_at - h.call_timestamp))) is not null
      order by ascnd_pair_rank(extract(epoch from (c.created_at - h.call_timestamp))) asc
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

-- 2) One-off backfill of the calls missed since the skew began (the nightly
--    sync only re-pairs a rolling 4 days). 2-day chunks, like sync.js Pass 3.
select sync_hl_to_canoe_calls('2026-11-03T00:00:00Z', '2026-11-05T00:00:00Z');
select sync_hl_to_canoe_calls('2026-11-05T00:00:00Z', '2026-11-07T00:00:00Z');
select sync_hl_to_canoe_calls('2026-11-07T00:00:00Z', now());
