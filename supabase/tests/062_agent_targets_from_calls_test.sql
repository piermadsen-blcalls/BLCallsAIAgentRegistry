-- ============================================================
-- Regression test for 062_agent_targets_from_calls.sql.
-- Run in the Supabase SQL Editor after 062. Everything runs inside one transaction that is
-- ROLLED BACK at the end, so it leaves no rows behind; raises on failure. Fixture names start
-- with 'ASCND AI Agent - ZZTEST' / 'ZZTEST' and ids with 'zztest-' so they can't collide with
-- real data. Real agents are refreshed too, then rolled back.
-- ============================================================
begin;

insert into agents (ivr_name, name) values
  ('ASCND AI Agent - ZZTEST Main - Outgoing',  'ZZ Main'),
  ('ASCND AI Agent - ZZTEST Quiet - Outgoing', 'ZZ Quiet');
insert into agent_ivr_aliases (ivr_name, canonical_ivr_name) values
  ('ASCND AI Agent - ZZTEST Main_15550000001 - Outgoing', 'ASCND AI Agent - ZZTEST Main - Outgoing');

insert into canoe_calls (id, ivr_name, is_test, created_at, api_campaign_name, publisher_name, advertiser_name, campaign_name, vertical_name) values
  -- ZZPub A / Camp One: 3 calls (one under the alias), two reach ZZBuyer X / Handyman
  ('zztest-t1', 'ASCND AI Agent - ZZTEST Main - Outgoing',             false, now() - interval '2 days', 'ZZ Camp One', 'ZZPub A', 'ZZBuyer X', 'ZZ Handyman', 'Handyman'),
  ('zztest-t2', 'ASCND AI Agent - ZZTEST Main_15550000001 - Outgoing', false, now() - interval '1 day',  'ZZ Camp One', 'ZZPub A', 'ZZBuyer X', 'ZZ Handyman', 'HVAC'),
  ('zztest-t3', 'ASCND AI Agent - ZZTEST Main - Outgoing',             false, now() - interval '1 day',  'ZZ Camp One', 'ZZPub A', null,        null,          'Handyman'),
  -- ZZPub B / Camp Two: 1 call to ZZBuyer X / Handyman again (vertical Handyman wins 2:1)
  ('zztest-t4', 'ASCND AI Agent - ZZTEST Main - Outgoing',             false, now() - interval '3 days', 'ZZ Camp Two', 'ZZPub B', 'ZZBuyer X', 'ZZ Handyman', 'Handyman'),
  -- buyer with no buyer campaign, and a publisher with no name
  ('zztest-t5', 'ASCND AI Agent - ZZTEST Main - Outgoing',             false, now() - interval '3 days', 'ZZ Camp Two', null,      'ZZBuyer Y', null,          null),
  -- skipped: test call, older than the window, and an unregistered IVR
  ('zztest-t6', 'ASCND AI Agent - ZZTEST Main - Outgoing',             true,  now() - interval '1 day',  'ZZ Camp Skip', 'ZZPub C', 'ZZBuyer Z', 'ZZ Skip', 'Skip'),
  ('zztest-t7', 'ASCND AI Agent - ZZTEST Main - Outgoing',             false, now() - interval '40 days','ZZ Camp Old',  'ZZPub C', 'ZZBuyer Z', 'ZZ Old',  'Old'),
  ('zztest-t8', 'ASCND AI Agent - ZZTEST Nobody - Outgoing',           false, now() - interval '1 day',  'ZZ Camp One', 'ZZPub A', 'ZZBuyer X', 'ZZ Handyman', 'Handyman');

do $$
declare
  n   int := refresh_agent_targets(30);
  t   agent_targets;
  q   agent_targets;
begin
  assert n >= 1, 'at least the fixture agent is active';
  select * into t from agent_targets where ivr_name = 'ASCND AI Agent - ZZTEST Main - Outgoing';
  select * into q from agent_targets where ivr_name = 'ASCND AI Agent - ZZTEST Quiet - Outgoing';

  -- 1) Totals: 5 calls in the window (alias included; test, old and unregistered skipped)
  assert t.window_days = 30, 'window_days';
  assert t.calls = 5, format('calls 5, got %s', t.calls);
  assert t.routed_calls = 4, format('routed_calls 4, got %s', t.routed_calls);

  -- 2) Publisher campaigns: sorted by calls, unnamed publisher shown as (unknown)
  assert t.publisher_campaigns_total = 3, format('3 publisher campaigns, got %s', t.publisher_campaigns_total);
  assert t.publisher_campaigns = '[
    {"campaign": "ZZ Camp One", "publisher": "ZZPub A",   "calls": 3},
    {"campaign": "ZZ Camp Two", "publisher": "(unknown)", "calls": 1},
    {"campaign": "ZZ Camp Two", "publisher": "ZZPub B",   "calls": 1}]'::jsonb,
    format('publisher_campaigns, got %s', t.publisher_campaigns);

  -- 3) Buyer targets: one row per advertiser + campaign, majority vertical, others counted
  assert t.buyer_targets_total = 2, format('2 buyer targets, got %s', t.buyer_targets_total);
  assert t.buyer_targets = '[
    {"advertiser": "ZZBuyer X", "campaign": "ZZ Handyman", "vertical": "Handyman",  "other_verticals": 1, "calls": 3},
    {"advertiser": "ZZBuyer Y", "campaign": null,          "vertical": "(unknown)", "other_verticals": 0, "calls": 1}]'::jsonb,
    format('buyer_targets, got %s', t.buyer_targets);

  -- 4) Every agent gets a row; one with no calls has empty lists
  assert q.calls = 0 and q.publisher_campaigns = '[]' and q.buyer_targets = '[]'
         and q.publisher_campaigns_total = 0 and q.buyer_targets_total = 0, 'quiet agent empty';
  assert (select count(*) from agent_targets) = (select count(*) from agents), 'one row per agent';
  assert not exists (select 1 from agent_targets where ivr_name like '%ZZTEST Nobody%'), 'unregistered IVR has no row';
end $$;

-- 5) Re-run reflects new calls and the 25-entry cap; a deleted agent's row goes with it.
insert into canoe_calls (id, ivr_name, is_test, created_at, api_campaign_name, publisher_name)
select 'zztest-c' || i, 'ASCND AI Agent - ZZTEST Main - Outgoing', false, now() - interval '1 hour',
       'ZZ Cap ' || lpad(i::text, 2, '0'), 'ZZPub Cap'
from generate_series(1, 30) i;
delete from agents where ivr_name = 'ASCND AI Agent - ZZTEST Quiet - Outgoing';
do $$
declare
  t agent_targets;
begin
  perform refresh_agent_targets(30);
  select * into t from agent_targets where ivr_name = 'ASCND AI Agent - ZZTEST Main - Outgoing';
  assert t.calls = 35, format('calls 35, got %s', t.calls);
  assert t.publisher_campaigns_total = 33, format('33 publisher campaigns, got %s', t.publisher_campaigns_total);
  assert jsonb_array_length(t.publisher_campaigns) = 25, 'list capped at 25';
  assert t.publisher_campaigns->0->>'campaign' = 'ZZ Camp One', 'biggest first';
  assert not exists (select 1 from agent_targets where ivr_name = 'ASCND AI Agent - ZZTEST Quiet - Outgoing'),
    'deleted agent row cascaded';
end $$;

-- 6) The hand-entered lists are kept under their new names, and the API roles can't refresh.
do $$
begin
  assert exists (select 1 from information_schema.columns where table_name = 'agents' and column_name = 'publisher_campaigns_manual'), 'publisher_campaigns_manual kept';
  assert exists (select 1 from information_schema.columns where table_name = 'agents' and column_name = 'ivr_targets_manual'), 'ivr_targets_manual kept';
  assert not exists (select 1 from information_schema.columns where table_name = 'agents' and column_name in ('publisher_campaigns', 'ivr_targets')), 'old names gone';
  assert not has_function_privilege('anon', 'refresh_agent_targets(int)', 'execute'), 'anon cannot refresh';
  assert not has_function_privilege('authenticated', 'refresh_agent_targets(int)', 'execute'), 'authenticated cannot refresh';
  assert has_table_privilege('anon', 'agent_targets', 'select'), 'anon can read';
end $$;

select 'ALL 062 TESTS PASSED' as result;
rollback;
