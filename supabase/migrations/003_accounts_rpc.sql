-- ============================================================
-- 003_accounts_rpc.sql
-- Returns distinct publishers and advertisers with call counts.
-- Run in Supabase SQL Editor.
-- ============================================================

create or replace function get_distinct_accounts()
returns table(account_name text, account_type text, call_count bigint)
language sql security definer as $$
  select publisher_name, 'publisher'::text, count(*)::bigint
  from canoe_calls
  where publisher_name is not null and publisher_name != ''
  group by publisher_name
  union all
  select advertiser_name, 'advertiser'::text, count(*)::bigint
  from canoe_calls
  where advertiser_name is not null and advertiser_name != ''
  group by advertiser_name
  order by 1;
$$;

grant execute on function get_distinct_accounts() to authenticated;
