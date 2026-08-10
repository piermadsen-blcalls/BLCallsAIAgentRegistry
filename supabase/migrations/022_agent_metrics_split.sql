-- ============================================================
-- 022_agent_metrics_split.sql
-- Split the Agents-tab load. agent_rollup returned the full (agent x
-- counterparty) breakdown — thousands of rows the client paginated, re-running
-- the whole aggregation per page (minutes). Instead:
--   agent_metrics  — per-agent totals only (GROUP BY ivr_name, a few dozen rows).
--                    Powers the cards + top stats. One tiny call on boot.
--   agent_breakdown — one agent's publisher/advertiser breakdown, loaded lazily
--                    when its drawer is expanded.
-- Both are covered by the 021 index (created_at INCLUDE …) → index-only scans.
--
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

create or replace function agent_metrics(from_ts timestamptz, to_ts timestamptz)
returns table (ivr_name text, raw bigint, sent bigint, paid bigint, revenue numeric, payout numeric)
language sql security definer stable as $$
  select ivr_name,
    count(*)::bigint,
    count(*) filter (where coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0)::bigint,
    count(*) filter (where coalesce(advertiser_payin,0) > 0)::bigint,
    coalesce(sum(advertiser_payin),0)::numeric,
    coalesce(sum(publisher_payout),0)::numeric
  from canoe_calls
  where is_test is not true and ivr_name is not null
    and created_at >= from_ts and created_at < to_ts
  group by ivr_name;
$$;
alter function agent_metrics(timestamptz, timestamptz) set statement_timeout = '30s';
grant execute on function agent_metrics(timestamptz, timestamptz) to authenticated;

create or replace function agent_breakdown(ivrs text[], from_ts timestamptz, to_ts timestamptz)
returns table (side text, counterparty text, raw bigint, sent bigint, paid bigint, revenue numeric)
language sql security definer stable as $$
  with base as materialized (
    select publisher_name, advertiser_name,
      (coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0) as is_sent,
      (coalesce(advertiser_payin,0) > 0) as is_paid,
      coalesce(advertiser_payin,0) as payin
    from canoe_calls
    where is_test is not true and ivr_name = any(ivrs)
      and created_at >= from_ts and created_at < to_ts
  )
  select 'publisher'::text, coalesce(publisher_name,'(unknown)'),
         count(*)::bigint, count(*) filter (where is_sent)::bigint, count(*) filter (where is_paid)::bigint, coalesce(sum(payin),0)::numeric
    from base group by publisher_name
  union all
  select 'advertiser'::text, coalesce(advertiser_name,'(unknown)'),
         count(*)::bigint, count(*) filter (where is_sent)::bigint, count(*) filter (where is_paid)::bigint, coalesce(sum(payin),0)::numeric
    from base group by advertiser_name;
$$;
alter function agent_breakdown(text[], timestamptz, timestamptz) set statement_timeout = '30s';
grant execute on function agent_breakdown(text[], timestamptz, timestamptz) to authenticated;
