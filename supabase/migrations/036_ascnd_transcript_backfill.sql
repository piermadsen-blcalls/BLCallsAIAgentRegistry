-- ============================================================
-- 036_ascnd_transcript_backfill.sql  (one-off backfill, not a schema change)
-- Loads AI-agent (Voice AI) transcripts from a GoHighLevel contacts export
-- into canoe_calls.ascnd_transcript so the Review tab (ASCND-only) has data,
-- without waiting on the live webhook fix.
--
-- Data path:
--   export CSV (contact_id, voice_ai_transcript)
--     -> ascnd_transcript_import (staging, loaded by scripts/load_ascnd_transcripts.js)
--     -> hl_call_data.transcript        (join on contact_id)
--     -> canoe_calls.ascnd_transcript   (nearest phone+time pairing, last 30d, ascnd%)
--
-- Run the blocks in order in the Supabase SQL editor; run the loader script
-- between step 1 and step 2.
-- ============================================================

-- 1) staging table (run first, then load the CSV into it)
create table if not exists ascnd_transcript_import (
  contact_id          text,
  tag                 text,
  voice_ai_transcript text
);
create index if not exists ascnd_transcript_import_cid_idx on ascnd_transcript_import (contact_id);

-- >>> now load the CSV:  node scripts/load_ascnd_transcripts.js
--     (or Supabase Table editor -> Import data via CSV)

-- 2) push transcripts onto the hl_call_data rows (the phone+time bridge)
update hl_call_data h
set transcript = s.voice_ai_transcript
from ascnd_transcript_import s
where s.contact_id = h.contact_id
  and coalesce(s.voice_ai_transcript, '') <> ''
  and coalesce(h.transcript, '') = '';

-- 3) backfill canoe_calls.ascnd_transcript from hl_call_data (nearest match,
--    last 30 days, AI-agent calls only). Ignores the disposition-null guard so
--    already-paired rows also get the transcript.
update canoe_calls c
set ascnd_transcript = m.transcript
from (
  select c.id as call_id, h.transcript
  from canoe_calls c
  cross join lateral (
    select h.*
    from hl_call_data h
    where right(regexp_replace(coalesce(h.phone,''), '[^0-9]', '', 'g'), 10)
        = right(regexp_replace(coalesce(c.called_from,''), '[^0-9]', '', 'g'), 10)
      and abs(extract(epoch from (c.created_at - h.call_timestamp))) <= 7
      and coalesce(h.transcript, '') <> ''
    order by abs(extract(epoch from (c.created_at - h.call_timestamp))) asc
    limit 1
  ) h
  where c.ivr_name ilike 'ascnd%'
    and c.created_at >= now() - interval '30 days'
) m
where c.id = m.call_id;

-- 4) sanity check: how many AI calls now have a transcript in the last 30 days
-- select count(*) from canoe_calls
-- where ivr_name ilike 'ascnd%' and created_at >= now() - interval '30 days'
--   and ascnd_transcript is not null;

-- 5) optional cleanup once verified
-- drop table ascnd_transcript_import;
