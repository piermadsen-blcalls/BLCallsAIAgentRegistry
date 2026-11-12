-- ============================================================
-- 055_distinct_accounts_skip_scan.sql
-- Settings > Admin > "Publisher & Advertiser Assignments" lists every publisher/advertiser name.
-- get_distinct_accounts() GROUP BYs all of canoe_calls (527k rows) to get ~350 names: mean 3.9 s,
-- max 19 s, and a 500 after 21.5 s in the Nov 9 bug bash, so the table showed the raw error.
--
-- Now a loose index scan: walk the existing publisher_name / advertiser_name btree indexes (015)
-- one distinct value at a time (~350 index probes, ~1.4k buffers instead of a full scan; the
-- same 205 + 149 names on prod, 2026-11-12). Same signature and columns. call_count is returned
-- as null: the page never reads it, and counting is what made this a full scan.
-- No grant changes (CREATE OR REPLACE keeps the existing privileges).
--
-- Rollback (the definition live on prod before this migration, which differs from 003/015):
--   create or replace function public.get_distinct_accounts()
--    returns table(account_name text, account_type text, call_count bigint)
--    language plpgsql security definer set statement_timeout to '20s'
--   as $function$
--   begin
--     set local statement_timeout = 0;
--     return query
--       select publisher_name, 'publisher'::text, count(*)::bigint
--       from canoe_calls
--       where publisher_name is not null and publisher_name != ''
--       group by publisher_name
--       union all
--       select advertiser_name, 'advertiser'::text, count(*)::bigint
--       from canoe_calls
--       where advertiser_name is not null and advertiser_name != ''
--       group by advertiser_name
--       order by 1;
--   end;
--   $function$;
-- Run in Supabase SQL Editor (or supabase db query --linked).
-- ============================================================

create or replace function get_distinct_accounts()
returns table(account_name text, account_type text, call_count bigint)
language sql stable security definer
set search_path = ''
as $$
  with recursive pubs as (
    (select c.publisher_name as name from public.canoe_calls c
      where c.publisher_name > '' order by c.publisher_name limit 1)
    union all
    select (select c.publisher_name from public.canoe_calls c
             where c.publisher_name > p.name order by c.publisher_name limit 1)
    from pubs p where p.name is not null
  ), advs as (
    (select c.advertiser_name as name from public.canoe_calls c
      where c.advertiser_name > '' order by c.advertiser_name limit 1)
    union all
    select (select c.advertiser_name from public.canoe_calls c
             where c.advertiser_name > a.name order by c.advertiser_name limit 1)
    from advs a where a.name is not null
  )
  select name, 'publisher'::text, null::bigint from pubs where name is not null
  union all
  select name, 'advertiser'::text, null::bigint from advs where name is not null
  order by 1;
$$;
