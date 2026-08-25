-- ============================================================
-- 039_review_counts_fast.sql
-- The 037 review_counts RPC timed out (57014): count(distinct) over a
-- left join + a non-sargable ilike 'ascnd%'. Rewrite it leaner and add a
-- partial index. Since only AI-agent calls ever have ascnd_transcript, the
-- `ascnd_transcript is not null` predicate already scopes to ASCND calls,
-- so we can drop the ilike, the join, and the distinct entirely.
-- Run in Supabase SQL Editor.
-- ============================================================

-- Partial index over just the transcript-bearing rows (~22k), by date.
create index if not exists canoe_calls_ascnd_transcript_idx
  on canoe_calls (created_at)
  where ascnd_transcript is not null;

create or replace function review_counts(since_ts timestamptz)
returns table(ivr_name text, reviewable bigint, reviewed bigint)
language sql
stable
security definer
set search_path = public
as $$
  select c.ivr_name,
    count(*) as reviewable,
    count(*) filter (
      where exists (select 1 from call_reviews cr where cr.call_id = c.id)
    ) as reviewed
  from canoe_calls c
  where c.ascnd_transcript is not null
    and c.created_at >= since_ts
  group by c.ivr_name;
$$;

grant execute on function review_counts(timestamptz) to anon, authenticated, service_role;
