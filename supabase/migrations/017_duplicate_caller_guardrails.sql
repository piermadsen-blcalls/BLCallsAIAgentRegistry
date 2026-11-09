-- ============================================================
-- 017_duplicate_caller_guardrails.sql
-- Tightens find_duplicate_callers so only REAL calls participate
-- in duplicate detection. Previously the matched ("other") side was
-- unfiltered, so a genuine call got flagged duplicate_caller merely
-- because the same number also hit a 1-second, no-transcript dead
-- end in another vertical/publisher within 48h.
--
-- New guardrail: a call counts (on BOTH sides of the match) only if
-- it is over 30 seconds AND has a non-empty transcript. The 48h
-- window and the different-vertical-OR-publisher logic are unchanged.
--
-- Run in Supabase SQL Editor.
-- ============================================================

create or replace function find_duplicate_callers(call_ids text[])
returns table(id text) language sql security definer as $$
  select distinct c.id
  from canoe_calls c
  where c.id = any(call_ids)
    and c.called_from is not null
    and c.duration > 30
    and c.transcription is not null
    and btrim(c.transcription) <> ''
    and exists (
      select 1
      from canoe_calls other
      where other.called_from = c.called_from
        and other.id != c.id
        and other.duration > 30
        and other.transcription is not null
        and btrim(other.transcription) <> ''
        and abs(extract(epoch from (other.created_at - c.created_at))) <= 172800 -- 48 hours
        and (
          other.vertical_id != c.vertical_id
          or other.publisher_id != c.publisher_id
        )
    );
$$;
