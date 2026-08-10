-- ============================================================
-- 024_pairing_disagreements.sql
-- Returns the individual calls where Canoe and Registry gave DIFFERENT outcomes,
-- for one (publisher|advertiser) x vertical pairing — powers the inline
-- "disagreeing calls" list in the Scores drawer. PostgREST can't compare two
-- columns in a filter, so this does it server-side. Uses the 011
-- ai_processed_at partial index (no new index needed).
--
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

create or replace function pairing_disagreements(
  entity_type text, entity_name text, vertical text, from_ts timestamptz, to_ts timestamptz
)
returns table (id text, created_at timestamptz, canoe_outcome text, our_outcome text, recording_url text)
language sql security definer stable as $$
  select id, created_at, canoe_outcome, our_outcome, recording_url
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
