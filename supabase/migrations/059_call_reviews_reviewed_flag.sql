-- ============================================================
-- 059_call_reviews_reviewed_flag.sql
-- Un-marking "Reviewed" in the Review workspace deleted the reviewer's call_reviews row, and
-- the reviewer's note on that call lives on the same row, so un-ticking deleted the note
-- (260 of 991 rows carry a note). A row now has a `reviewed` flag: un-marking sets it false
-- and keeps the note. "Reviewed" = a row with reviewed = true, here (review_counts) and in
-- the Review workspace. Every existing row is a review, so the default true keeps its meaning.
-- Rollback: supabase/rollbacks/059_call_reviews_reviewed_flag_down.sql
-- Test:     supabase/tests/059_call_reviews_reviewed_flag_test.sql
-- Applied to prod on 2026-11-13 as `058_call_reviews_reviewed_flag` (renumbered after another
-- worker's 058 landed the same night); the SQL is identical.
-- ============================================================

alter table call_reviews add column if not exists reviewed boolean not null default true;

-- review_counts as it is live on prod (a faster rewrite of 039 that was applied by hand and
-- never committed), plus `where reviewed`.
create or replace function review_counts(since_ts timestamptz)
returns table(ivr_name text, reviewable bigint, reviewed bigint)
language sql
stable
security definer
set search_path = public
as $$
  with r as (
    select ivr_name, count(*)::bigint as reviewable
    from canoe_calls
    where ascnd_transcript is not null and created_at >= since_ts
    group by ivr_name
  ), d as (
    select ivr_name, count(distinct call_id)::bigint as reviewed
    from call_reviews
    where reviewed
    group by ivr_name
  )
  select r.ivr_name, r.reviewable, coalesce(d.reviewed, 0)
  from r left join d using (ivr_name);
$$;

grant execute on function review_counts(timestamptz) to anon, authenticated, service_role;
