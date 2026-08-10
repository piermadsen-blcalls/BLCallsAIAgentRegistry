-- ============================================================
-- 021_agent_rollup_perf.sql
-- agent_rollup timed out (57014): a 30-day window is a large fraction of
-- canoe_calls, so the planner seq-scanned the wide heap — twice, once per
-- union branch. Fix:
--   1) a covering partial index so the window scan is index-only (no heap), and
--   2) a MATERIALIZED CTE so canoe_calls is scanned once, not per branch.
-- Plus a statement_timeout safety net.
--
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

create index if not exists canoe_calls_rollup_idx
  on canoe_calls (created_at)
  include (ivr_name, publisher_name, advertiser_name, connect_duration, result, advertiser_payin, publisher_payout)
  where is_test is not true;

create or replace function agent_rollup(from_ts timestamptz, to_ts timestamptz)
returns table (ivr_name text, side text, counterparty text, raw bigint, sent bigint, paid bigint, revenue numeric, payout numeric)
language sql security definer stable as $$
  with base as materialized (
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

alter function agent_rollup(timestamptz, timestamptz) set statement_timeout = '30s';
grant execute on function agent_rollup(timestamptz, timestamptz) to authenticated;
