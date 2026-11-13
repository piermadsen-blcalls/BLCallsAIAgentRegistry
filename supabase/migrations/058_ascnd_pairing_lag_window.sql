-- ============================================================
-- 058_ascnd_pairing_lag_window.sql
-- About 26% of ASCND AI-agent calls (1,247 of 4,847 in the 30 days to 2026-11-13) had no
-- ascnd_transcript. Diagnosis (read-only, against hl_call_data):
--   417  the transcript IS in hl_call_data, but ASCND's call_timestamp runs 8-120s behind
--        canoe_calls.created_at (most within 30s). sync_hl_to_canoe_calls only pairs within
--        +/-7s (or 1h +/-7s, 049).
--   331  ASCND posted the call with an empty "Voice AI Transcript".
--   494  ASCND posted no record for the call (446 repeat calls from a caller ASCND has one
--        record for, 48 callers it has none for); 339 of them lasted 5s or less.
--     5  other (the nearest hl row is a better match for another call; 1 pairs as-is).
-- Webhook deliveries in the logs are all 200, so nothing is lost on the way in.
--
-- Fix for the first group:
--   * ascnd_pair_rank accepts ASCND lagging Canoe by 8-120s (also on top of the 1h DST
--     skew), ranked after every exact and 1h-exact match. Earlier/other gaps stay unpaired.
--   * sync_hl_to_canoe_calls pairs one hl row to at most one call (mutual best match), so the
--     wider window can't hand one caller's transcript to their repeat call.
--   * it also re-pairs calls that have a disposition but no transcript, and never overwrites a
--     stored value with null (fills only).
--   * one-off backfill of the last 31 days; the rows it changes are kept with their previous
--     values in ascnd_pairing_backfill_058 so the rollback can restore them.
-- Same signatures and grants as 049. The new table is service-role only (RLS on, no
-- policies, no anon/authenticated grants), like 052's tables.
-- Rollback: supabase/rollbacks/058_ascnd_pairing_lag_window_down.sql
-- Test:     supabase/tests/058_ascnd_pairing_lag_window_test.sql
-- ============================================================

-- 1) Pairing rank for a gap (seconds, canoe minus hl): lower is better, null = not a pair.
--    0..7 exact; 100..107 one hour off; 207..320 ASCND 7-120s behind; 307..420 both.
--    The lag branches are only reached once the exact/1h branches have failed (gap > 7s off).
create or replace function ascnd_pair_rank(gap_s numeric)
returns numeric
language sql
immutable
as $$
  select case
    when abs(gap_s) <= 7                    then abs(gap_s)
    when abs(abs(gap_s) - 3600) <= 7        then 100 + abs(abs(gap_s) - 3600)
    when gap_s        between -120 and 0    then 200 - gap_s
    when gap_s - 3600 between -120 and 0    then 300 - (gap_s - 3600)
    when gap_s + 3600 between -120 and 0    then 300 - (gap_s + 3600)
  end;
$$;

-- 2) Same signature/return as 049.
create or replace function sync_hl_to_canoe_calls(from_ts timestamptz, to_ts timestamptz)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  updated int := 0;
begin
  with cand as (
    -- Calls up to 3h outside [from_ts, to_ts) only compete for hl rows, so an hl row near a
    -- chunk edge still goes to its best call.
    select
      c.id   as call_id,
      h.id   as hl_id,
      ascnd_pair_rank(extract(epoch from (c.created_at - h.call_timestamp))) as rk,
      c.created_at >= from_ts and c.created_at < to_ts
        and (c.disposition is null or c.ascnd_transcript is null) as wanted
    from canoe_calls c
    join hl_call_data h
      on right(regexp_replace(coalesce(h.phone,''), '[^0-9]', '', 'g'), 10)
       = right(regexp_replace(coalesce(c.called_from,''), '[^0-9]', '', 'g'), 10)
      -- sargable bound for hl_call_data_phone10_ts_idx (1h+7s early .. 1h+120s late)
     and h.call_timestamp between c.created_at - interval '3607 seconds'
                              and c.created_at + interval '3720 seconds'
    where c.created_at >= from_ts - interval '3 hours'
      and c.created_at <  to_ts   + interval '3 hours'
      and c.ivr_name ilike 'ascnd%'
      and right(regexp_replace(coalesce(c.called_from,''), '[^0-9]', '', 'g'), 10) <> ''
  ),
  ranked as (
    select call_id, hl_id, wanted,
           row_number() over (partition by call_id order by rk, hl_id)   as call_pick,
           row_number() over (partition by hl_id   order by rk, call_id) as hl_pick
    from cand
    where rk is not null
  ),
  matched as (
    select
      r.call_id,
      h.disposition                 as disposition,
      h.disposition_description     as disposition_description,
      h.recording_url               as ascnd_recording_url,
      nullif(h.transcript, '')      as ascnd_transcript,
      h.intent                      as intent,
      h.ai_agent_phone_number       as ai_agent_phone_number
    from ranked r
    join hl_call_data h on h.id = r.hl_id
    where r.wanted and r.call_pick = 1 and r.hl_pick = 1
  )
  update canoe_calls c
  set disposition             = coalesce(m.disposition,             c.disposition),
      disposition_description = coalesce(m.disposition_description, c.disposition_description),
      ascnd_recording_url     = coalesce(m.ascnd_recording_url,     c.ascnd_recording_url),
      ascnd_transcript        = coalesce(m.ascnd_transcript,        c.ascnd_transcript),
      intent                  = coalesce(m.intent,                  c.intent),
      ai_agent_phone_number   = coalesce(m.ai_agent_phone_number,   c.ai_agent_phone_number)
  from matched m
  where c.id = m.call_id
    -- skip no-op writes, so the count is calls that actually gained data
    and (coalesce(m.disposition, c.disposition), coalesce(m.disposition_description, c.disposition_description),
         coalesce(m.ascnd_recording_url, c.ascnd_recording_url), coalesce(m.ascnd_transcript, c.ascnd_transcript),
         coalesce(m.intent, c.intent), coalesce(m.ai_agent_phone_number, c.ai_agent_phone_number))
        is distinct from
        (c.disposition, c.disposition_description, c.ascnd_recording_url, c.ascnd_transcript,
         c.intent, c.ai_agent_phone_number);

  get diagnostics updated = row_count;
  return updated;
end;
$$;

grant execute on function sync_hl_to_canoe_calls(timestamptz, timestamptz) to anon, authenticated, service_role;

-- 3) Backfill the last 31 days (sync.js Pass 3 only re-pairs a rolling 4). Snapshot the rows
--    the backfill may change, run it in 2-day chunks like Pass 3, then keep only rows it changed.
create table if not exists ascnd_pairing_backfill_058 as
select id as call_id, disposition, disposition_description, ascnd_recording_url,
       ascnd_transcript, intent, ai_agent_phone_number
from canoe_calls
where ivr_name ilike 'ascnd%'
  and created_at >= date_trunc('day', now() - interval '31 days')
  and (disposition is null or ascnd_transcript is null);
alter table ascnd_pairing_backfill_058 enable row level security;
revoke all on table ascnd_pairing_backfill_058 from anon, authenticated;

select sum(sync_hl_to_canoe_calls(s, least(s + interval '2 days', now()))) as backfilled
from generate_series(date_trunc('day', now() - interval '31 days'), now(), interval '2 days') s;

delete from ascnd_pairing_backfill_058 b
using canoe_calls c
where c.id = b.call_id
  and (c.disposition, c.disposition_description, c.ascnd_recording_url, c.ascnd_transcript,
       c.intent, c.ai_agent_phone_number)
      is not distinct from
      (b.disposition, b.disposition_description, b.ascnd_recording_url, b.ascnd_transcript,
       b.intent, b.ai_agent_phone_number);
