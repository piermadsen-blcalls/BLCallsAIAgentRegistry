-- Rollback for 059_call_reviews_reviewed_flag.sql. Restores review_counts as it was live on
-- prod before 059 and drops the `reviewed` column. Deploy the index.html revert with it: the
-- new page reads and writes the column.
-- Without the column every row counts as reviewed again, so un-marked rows that hold no note
-- are removed first (the old page deleted exactly these rows on un-mark). Un-marked rows that
-- hold a note, or an "AI got this wrong" mark (call_reviews.eval_disagree, migration 056), are
-- kept and read as reviewed again, which is the pre-059 behavior minus the lost note.

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'call_reviews' and column_name = 'eval_disagree') then
    delete from call_reviews where not reviewed and note is null and eval_disagree is not true;
  else
    delete from call_reviews where not reviewed and note is null;
  end if;
end $$;

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
    group by ivr_name
  )
  select r.ivr_name, r.reviewable, coalesce(d.reviewed, 0)
  from r left join d using (ivr_name);
$$;

grant execute on function review_counts(timestamptz) to anon, authenticated, service_role;

alter table call_reviews drop column if exists reviewed;
