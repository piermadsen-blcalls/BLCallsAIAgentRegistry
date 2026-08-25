-- ============================================================
-- 037_review_counts.sql
-- Per-agent reviewable/reviewed call counts for the Review status board,
-- so you can see how many AI calls are reviewed vs waiting before clicking in.
--   reviewable = AI calls with an ASCND transcript in the window
--   reviewed   = those that have a call_reviews row
-- Run in Supabase SQL Editor.
-- ============================================================

create or replace function review_counts(since_ts timestamptz)
returns table(ivr_name text, reviewable bigint, reviewed bigint)
language sql
stable
security definer
set search_path = public
as $$
  select c.ivr_name,
    count(distinct c.id) filter (where c.ascnd_transcript is not null) as reviewable,
    count(distinct c.id) filter (where c.ascnd_transcript is not null and cr.call_id is not null) as reviewed
  from canoe_calls c
  left join call_reviews cr on cr.call_id = c.id
  where c.ivr_name ilike 'ascnd%'
    and c.created_at >= since_ts
  group by c.ivr_name;
$$;

grant execute on function review_counts(timestamptz) to anon, authenticated, service_role;
