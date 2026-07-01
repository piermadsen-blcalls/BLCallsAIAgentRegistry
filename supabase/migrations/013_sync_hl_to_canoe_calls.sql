-- ============================================================
-- 013_sync_hl_to_canoe_calls.sql
-- Pairs ASCND data (hl_call_data) onto canoe_calls, mirroring the
-- existing sync_hl_to_calls RPC but targeting the master table.
--
-- Match key: normalized phone (last 10 digits) + call time within ±7s,
-- nearest match wins. Scoped to ASCND AI-agent calls only (ivr_name
-- like 'ascnd%'), since only those have ASCND data — this keeps the
-- scan small and avoids pointlessly re-checking non-AI calls.
--
-- lookback_days bounds how far back to enrich (default 35, enough for the
-- 30-day window). Pass a large number for a full backfill.
-- Run in Supabase SQL Editor.
-- ============================================================

create or replace function sync_hl_to_canoe_calls(lookback_days int default 35)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  updated int := 0;
  cutoff  timestamptz := now() - make_interval(days => lookback_days);
begin
  with matched as (
    select
      c.id                     as call_id,
      h.disposition            as disposition,
      h.disposition_description as disposition_description,
      h.recording_url          as ascnd_recording_url,
      h.transcript             as ascnd_transcript
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
    where c.created_at >= cutoff
      and c.disposition is null
      and c.ivr_name ilike 'ascnd%'
      and right(regexp_replace(coalesce(c.called_from,''), '[^0-9]', '', 'g'), 10) <> ''
  )
  update canoe_calls c
  set disposition             = m.disposition,
      disposition_description = m.disposition_description,
      ascnd_recording_url     = m.ascnd_recording_url,
      ascnd_transcript        = m.ascnd_transcript
  from matched m
  where c.id = m.call_id;

  get diagnostics updated = row_count;
  return updated;
end;
$$;

grant execute on function sync_hl_to_canoe_calls(int) to anon, authenticated, service_role;
