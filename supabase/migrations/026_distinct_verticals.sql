-- ============================================================
-- 026_distinct_verticals.sql
-- The verticals dropdown loaded EVERY vertical_name from canoe_calls and deduped
-- client-side — a full scan of ~264k rows that now times out (57014). This adds a
-- btree index on vertical_name + a get_distinct_verticals() RPC using a recursive
-- loose index-scan ("skip scan") so it returns the few dozen distinct values in
-- milliseconds regardless of table size. Mirrors get_distinct_ivrs (020).
--
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

create index if not exists canoe_calls_vertical_name_idx
  on canoe_calls (vertical_name)
  where is_test is not true and vertical_name is not null;

create or replace function get_distinct_verticals()
returns table (vertical_name text)
language sql security definer stable as $$
  with recursive t as (
    (select c.vertical_name
       from canoe_calls c
      where c.vertical_name is not null and c.is_test is not true
      order by c.vertical_name
      limit 1)
    union all
    select (select c.vertical_name
              from canoe_calls c
             where c.vertical_name > t.vertical_name
               and c.vertical_name is not null and c.is_test is not true
             order by c.vertical_name
             limit 1)
      from t
     where t.vertical_name is not null
  )
  select t.vertical_name from t where t.vertical_name is not null;
$$;
alter function get_distinct_verticals() set statement_timeout = '15s';
grant execute on function get_distinct_verticals() to authenticated, anon;
