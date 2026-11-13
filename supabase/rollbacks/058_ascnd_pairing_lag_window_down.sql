-- Rollback for 058_ascnd_pairing_lag_window.sql. Puts back the calls the 058 backfill changed
-- (their previous values are in ascnd_pairing_backfill_058), restores ascnd_pair_rank and
-- sync_hl_to_canoe_calls exactly as of 049, and drops the backfill record. Calls paired by
-- sync runs after 058 keep their data (049 only ever fills calls with no disposition).

update canoe_calls c
set disposition             = b.disposition,
    disposition_description = b.disposition_description,
    ascnd_recording_url     = b.ascnd_recording_url,
    ascnd_transcript        = b.ascnd_transcript,
    intent                  = b.intent,
    ai_agent_phone_number   = b.ai_agent_phone_number
from ascnd_pairing_backfill_058 b
where c.id = b.call_id;

drop table if exists ascnd_pairing_backfill_058;

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
