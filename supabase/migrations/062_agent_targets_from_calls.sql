-- ============================================================
-- 062_agent_targets_from_calls.sql
--
-- The Agents drawer's "Publisher campaign IVRs" and "Buyer targets" lists were typed in by hand
-- in May (agents.publisher_campaigns / agents.ivr_targets). Nothing kept them current, the
-- new-IVR setup form never set them, and the targets table had an empty Publisher column and no
-- campaign. They now come from the calls themselves.
--
-- 1) agent_targets: one row per agent, rebuilt from canoe_calls over the last 30 days (rolling,
--    from now). Calls map to agents the way the page does: raw ivr_name, or its canonical name
--    via agent_ivr_aliases. Test calls are skipped.
--    - publisher_campaigns: one entry per publisher + publisher campaign (api_campaign_name, the
--      field the manual rows held, e.g. 'Home Improvements (Variable Rate)').
--    - buyer_targets: one entry per advertiser + buyer campaign (campaign_name, e.g. 'Handyman'),
--      over calls that reached an advertiser. Its vertical is the one most of those calls had;
--      other_verticals counts the rest (splitting by vertical gave Pest Control 138 rows for 35
--      buyers). No publisher column: which publishers fed a buyer is the Publishers breakdown.
--    Each list is sorted by calls and capped at 25 entries; *_total holds the full count.
-- 2) refresh_agent_targets(days_back): ~150 ms for every agent, so sync.js calls it over the API
--    right after check_new_ivrs (060), and a brand-new IVR has both lists from its first calls.
--    A 07:20 UTC pg_cron run (after check-new-ivrs) is the safety net.
-- 3) The hand-entered lists are kept, renamed to *_manual. Nothing reads or writes them now.
--
-- agent_targets is readable like agents (002: anon + authenticated select); only the function
-- (service role) writes it. The page reads it with its own request, so the Agents tab still
-- loads if this table is missing.
-- Rollback: supabase/rollbacks/062_agent_targets_from_calls_down.sql
-- Test:     supabase/tests/062_agent_targets_from_calls_test.sql
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

set lock_timeout = '5s';

-- ── 1) Keep the hand-entered lists ──
alter table agents rename column publisher_campaigns to publisher_campaigns_manual;
alter table agents rename column ivr_targets         to ivr_targets_manual;
comment on column agents.publisher_campaigns_manual is 'Hand-entered May 2026, frozen by 062. The page shows agent_targets.publisher_campaigns.';
comment on column agents.ivr_targets_manual         is 'Hand-entered May 2026, frozen by 062. The page shows agent_targets.buyer_targets.';

-- ── 2) Derived lists ──
create table if not exists agent_targets (
  ivr_name                  text primary key references agents (ivr_name) on update cascade on delete cascade,
  window_days               int    not null,
  calls                     bigint not null default 0,      -- all calls in the window
  routed_calls              bigint not null default 0,      -- calls that reached an advertiser
  publisher_campaigns       jsonb  not null default '[]',   -- [{campaign, publisher, calls}]
  publisher_campaigns_total int    not null default 0,
  buyer_targets             jsonb  not null default '[]',   -- [{advertiser, campaign, vertical, other_verticals, calls}]
  buyer_targets_total       int    not null default 0,
  refreshed_at              timestamptz not null default now()
);
alter table agent_targets enable row level security;
create policy "anon can read agent_targets"
  on agent_targets for select to anon using (true);
create policy "auth users can read agent_targets"
  on agent_targets for select to authenticated using (true);

-- Returns the number of agents with at least one call in the window.
create or replace function refresh_agent_targets(days_back int default 30)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_active int;
begin
  perform pg_advisory_xact_lock(hashtext('refresh_agent_targets'));

  with calls as materialized (
    select a.ivr_name as agent,
           coalesce(nullif(k.api_campaign_name, ''), '(unknown)') as pub_campaign,
           coalesce(nullif(k.publisher_name, ''), '(unknown)')    as publisher,
           nullif(k.advertiser_name, '')                         as advertiser,
           nullif(k.campaign_name, '')                           as buy_campaign,
           coalesce(nullif(k.vertical_name, ''), '(unknown)')     as vertical
    from canoe_calls k
    left join agent_ivr_aliases x on x.ivr_name = k.ivr_name
    join agents a on a.ivr_name = coalesce(x.canonical_ivr_name, k.ivr_name)
    where k.is_test is not true
      and k.created_at >= now() - make_interval(days => days_back)
  ),
  tot as (
    select agent, count(*) as calls, count(*) filter (where advertiser is not null) as routed
    from calls group by 1
  ),
  pc as (
    select agent, pub_campaign, publisher, count(*) as calls,
           row_number() over (partition by agent order by count(*) desc, pub_campaign, publisher) as rn,
           count(*) over (partition by agent) as n
    from calls group by 1, 2, 3
  ),
  pc_list as (
    select agent, max(n)::int as n,
           jsonb_agg(jsonb_build_object('campaign', pub_campaign, 'publisher', publisher, 'calls', calls) order by rn)
             filter (where rn <= 25) as list
    from pc group by 1
  ),
  bv as (
    select agent, advertiser, buy_campaign, vertical, count(*) as calls
    from calls where advertiser is not null group by 1, 2, 3, 4
  ),
  bt as (
    select agent, advertiser, buy_campaign, sum(calls)::bigint as calls,
           (array_agg(vertical order by calls desc, vertical))[1] as vertical,
           count(*) - 1 as other_verticals
    from bv group by 1, 2, 3
  ),
  bt_ranked as (
    select bt.*,
           row_number() over (partition by agent order by calls desc, advertiser, buy_campaign nulls last) as rn,
           count(*) over (partition by agent) as n
    from bt
  ),
  bt_list as (
    select agent, max(n)::int as n,
           jsonb_agg(jsonb_build_object('advertiser', advertiser, 'campaign', buy_campaign, 'vertical', vertical,
                                        'other_verticals', other_verticals, 'calls', calls) order by rn)
             filter (where rn <= 25) as list
    from bt_ranked group by 1
  )
  insert into agent_targets (ivr_name, window_days, calls, routed_calls, publisher_campaigns,
                             publisher_campaigns_total, buyer_targets, buyer_targets_total, refreshed_at)
  select a.ivr_name, days_back, coalesce(t.calls, 0), coalesce(t.routed, 0),
         coalesce(p.list, '[]'), coalesce(p.n, 0), coalesce(b.list, '[]'), coalesce(b.n, 0), now()
  from agents a
  left join tot     t on t.agent = a.ivr_name
  left join pc_list p on p.agent = a.ivr_name
  left join bt_list b on b.agent = a.ivr_name
  on conflict (ivr_name) do update set
    window_days               = excluded.window_days,
    calls                     = excluded.calls,
    routed_calls              = excluded.routed_calls,
    publisher_campaigns       = excluded.publisher_campaigns,
    publisher_campaigns_total = excluded.publisher_campaigns_total,
    buyer_targets             = excluded.buyer_targets,
    buyer_targets_total       = excluded.buyer_targets_total,
    refreshed_at              = excluded.refreshed_at;

  select count(*)::int into v_active from agent_targets where calls > 0;
  return v_active;
end;
$$;
revoke execute on function refresh_agent_targets(int) from public, anon, authenticated;
grant execute on function refresh_agent_targets(int) to service_role;

-- Initial fill (one upsert per agent; a fraction of a second).
select refresh_agent_targets(30);

-- ── 3) Nightly safety net, after check-new-ivrs (07:15). cron.schedule upserts by job name. ──
create extension if not exists pg_cron;
select cron.schedule('refresh-agent-targets', '20 7 * * *', $$select public.refresh_agent_targets(30)$$);
