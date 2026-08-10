-- ============================================================
-- 020_agent_rollup.sql
-- Server-side aggregation for the Agents tab. It was pulling every call in the
-- window to the browser over dozens of paginated round-trips (10s+ load). These
-- aggregate canoe_calls server-side so the tab loads in one (small) call each.
--
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

-- Per (ivr_name, side, counterparty) rollup. Publisher-side rows also carry payout
-- so the client can derive per-agent totals + margin; advertiser-side rows feed the
-- advertiser breakdown. is_sent/is_paid mirror the frontend's isSent()/isPaid().
create or replace function agent_rollup(from_ts timestamptz, to_ts timestamptz)
returns table (ivr_name text, side text, counterparty text, raw bigint, sent bigint, paid bigint, revenue numeric, payout numeric)
language sql security definer stable as $$
  with base as (
    select ivr_name, publisher_name, advertiser_name,
      (coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0) as is_sent,
      (coalesce(advertiser_payin,0) > 0) as is_paid,
      coalesce(advertiser_payin,0)  as payin,
      coalesce(publisher_payout,0)  as payout
    from canoe_calls
    where is_test is not true and ivr_name is not null
      and created_at >= from_ts and created_at < to_ts
  )
  select ivr_name, 'publisher'::text, coalesce(publisher_name,'(unknown)'),
         count(*)::bigint, count(*) filter (where is_sent)::bigint, count(*) filter (where is_paid)::bigint,
         sum(payin)::numeric, sum(payout)::numeric
    from base group by ivr_name, publisher_name
  union all
  select ivr_name, 'advertiser'::text, coalesce(advertiser_name,'(unknown)'),
         count(*)::bigint, count(*) filter (where is_sent)::bigint, count(*) filter (where is_paid)::bigint,
         sum(payin)::numeric, 0::numeric
    from base group by ivr_name, advertiser_name
  order by 1, 2, 3;
$$;
grant execute on function agent_rollup(timestamptz, timestamptz) to authenticated;

-- Distinct ivr_names seen since a date — for the unregistered-agent check (was
-- scanning ~60 days of rows client-side).
create or replace function get_distinct_ivrs(since_ts timestamptz)
returns table (ivr_name text)
language sql security definer stable as $$
  select distinct ivr_name from canoe_calls
  where is_test is not true and ivr_name is not null and created_at >= since_ts;
$$;
grant execute on function get_distinct_ivrs(timestamptz) to authenticated;
