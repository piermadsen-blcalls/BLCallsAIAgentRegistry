-- Rollback for 052_rollup_refresh_after_sync.sql. Restores the refresh functions as of
-- 030 / 045 / 041 and their 01:00 / 01:15 / 01:30 UTC schedules, and removes the refresh
-- queue, its cron job and sync_state. Rollup rows rebuilt by 053 stay (they match canoe_calls).
-- Deploy the scripts/ revert first or with it: the old scripts never call the removed objects,
-- and the new ones only warn if they are missing.

select cron.unschedule('refresh-rollup-queue')
where exists (select 1 from cron.job where jobname = 'refresh-rollup-queue');
select cron.schedule('refresh-agent-rollup',              '0 1 * * *',  $$select public.refresh_agent_metrics_daily(45)$$);
select cron.schedule('refresh-agent-counterparty-rollup', '15 1 * * *', $$select public.refresh_agent_counterparty_daily(45)$$);
select cron.schedule('refresh-outcome-score-rollup',      '30 1 * * *', $$select public.refresh_outcome_score_daily(120)$$);

drop function if exists run_rollup_refresh_queue();
drop function if exists run_rollup_refresh(text);
drop function if exists request_rollup_refresh(timestamptz, text[]);
drop table if exists rollup_refresh_requests;
drop table if exists sync_state;

create or replace function refresh_agent_metrics_daily(days_back int default 45)
returns void language plpgsql security definer as $$
begin
  delete from agent_metrics_daily where day >= (now() - make_interval(days => days_back))::date;
  insert into agent_metrics_daily (ivr_name, day, raw, sent, paid, revenue, payout)
  select ivr_name, (created_at at time zone 'UTC')::date,
    count(*)::bigint,
    count(*) filter (where coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0)::bigint,
    count(*) filter (where coalesce(advertiser_payin,0) > 0)::bigint,
    coalesce(sum(advertiser_payin),0)::numeric,
    coalesce(sum(publisher_payout),0)::numeric
  from canoe_calls
  where is_test is not true and ivr_name is not null
    and created_at >= (now() - make_interval(days => days_back))
  group by 1, 2;
end;
$$;

create or replace function refresh_agent_counterparty_daily(days_back int default 45)
returns void language plpgsql security definer as $$
begin
  delete from agent_counterparty_daily where day >= (now() - make_interval(days => days_back))::date;
  insert into agent_counterparty_daily (ivr_name, day, side, counterparty, calls, sent, paid, revenue)
  with base as materialized (
    select ivr_name, (created_at at time zone 'UTC')::date as day, publisher_name, advertiser_name,
      (coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0) as is_sent,
      (coalesce(advertiser_payin,0) > 0) as is_paid,
      coalesce(advertiser_payin,0) as payin
    from canoe_calls
    where is_test is not true and ivr_name is not null
      and created_at >= (now() - make_interval(days => days_back))
  )
  select ivr_name, day, 'publisher', coalesce(publisher_name,'(unknown)'),
         count(*)::bigint, count(*) filter (where is_sent)::bigint, count(*) filter (where is_paid)::bigint, coalesce(sum(payin),0)::numeric
    from base group by 1, 2, 4
  union all
  select ivr_name, day, 'advertiser', coalesce(advertiser_name,'(unknown)'),
         count(*)::bigint, count(*) filter (where is_sent)::bigint, count(*) filter (where is_paid)::bigint, coalesce(sum(payin),0)::numeric
    from base group by 1, 2, 4;
end;
$$;
alter function refresh_agent_counterparty_daily(int) set statement_timeout = '5min';

create or replace function refresh_outcome_score_daily(days_back int default 120)
returns void language plpgsql security definer as $$
begin
  delete from outcome_score_daily where day >= (now() - make_interval(days => days_back))::date;
  insert into outcome_score_daily (entity_type, entity_name, vertical, source, outcome, day, n)
  with base as (
    select
      publisher_name,
      advertiser_name,
      coalesce(nullif(vertical_name, ''), '(unknown)') as vertical,
      canoe_outcome,
      our_outcome,
      (created_at at time zone 'UTC')::date as day
    from canoe_calls
    where is_test is not true
      and canoe_outcome is not null
      and our_outcome   is not null
      and created_at >= (now() - make_interval(days => days_back))
  ),
  unpivoted as (
    select 'publisher'::text as entity_type, publisher_name as entity_name, vertical, 'canoe'::text as source, canoe_outcome as outcome, day
      from base where publisher_name is not null and publisher_name <> ''
    union all
    select 'publisher', publisher_name, vertical, 'ours', our_outcome, day
      from base where publisher_name is not null and publisher_name <> ''
    union all
    select 'advertiser', advertiser_name, vertical, 'canoe', canoe_outcome, day
      from base where advertiser_name is not null and advertiser_name <> ''
    union all
    select 'advertiser', advertiser_name, vertical, 'ours', our_outcome, day
      from base where advertiser_name is not null and advertiser_name <> ''
  )
  select entity_type, entity_name, vertical, source, outcome, day, count(*)::bigint
  from unpivoted
  group by entity_type, entity_name, vertical, source, outcome, day;
end;
$$;
