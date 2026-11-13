-- ============================================================
-- 060_new_ivr_detection.sql
--
-- A brand-new AI IVR (one Canoe has never shown under a registered name) was silent: its calls
-- matched no agent, so they counted nowhere until someone registered it by hand. 050's self-heal
-- only covers renames (a known ivr_id under a new name).
--
-- 1) check_new_ivrs(days_back): run by sync.js right after each Canoe sync.
--    a) heal renames first (050), so a renamed IVR becomes an alias, never a new agent;
--    b) register every other AI-agent IVR name seen in the window as an agent with
--       status 'needs_setup', its first-seen time and call count. An AI-agent IVR is one
--       named 'ASCND%', the rule 050's heal and the ASCND pairing already use: every
--       registered agent and every IVR carrying an ASCND transcript is named that way, and no
--       other Canoe IVR is. One name per Canoe ivr_id (the newest); the second heal pass
--       aliases the others to it;
--    c) keep the call count current while an agent still needs setup.
--    Registering the name is enough for its calls to count everywhere (rollups group by raw
--    IVR name and the page maps names to agents at read time), from its first call.
-- 2) new_ivr_detections: one row per detected IVR, ever. A name detected once is never
--    registered again (so deleting it sticks) and is emailed once (scripts/alert.js
--    ALERT_MODE=new_ivrs records who was sent it). Service-role only, like sync_state (052).
-- 3) The nightly pg_cron job moves from 00:45 UTC (before the sync lands, N18) to 07:15 UTC
--    and runs the whole check: a safety net for a sync whose own call failed.
--
-- The page shows needs_setup agents in a "New IVRs" banner on the Agents tab, keeps them out of
-- the Review board's Needs review count, and its setup form sets the status to live (or test).
-- No grants change for anon/authenticated: the two new agents columns are covered by the table's
-- existing policies, and the new table and function are not reachable from the API's client roles.
-- After applying, run the first check once (step 5).
-- Rollback: supabase/rollbacks/060_new_ivr_detection_down.sql
-- Test:     supabase/tests/060_new_ivr_detection_test.sql
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

-- ── 1) Agent fields the banner shows ──
alter table agents add column if not exists first_seen_at timestamptz;   -- first call under this IVR name (set on detection)
alter table agents add column if not exists seen_calls    int;           -- calls under it and its aliases; refreshed while needs_setup

-- ── 2) Detection log + email state ──
create table if not exists new_ivr_detections (
  ivr_name           text primary key,
  ivr_id             text,
  first_seen_at      timestamptz,
  calls_at_detection int not null default 0,
  detected_at        timestamptz not null default now(),
  emailed_to         text[] not null default '{}',   -- account_managers ids already sent this IVR's email
  emailed_at         timestamptz                     -- set once every recipient has it
);
alter table new_ivr_detections enable row level security;
revoke all on table new_ivr_detections from anon, authenticated;

-- ── 3) The check ──
-- Returns {"aliases_added": n, "registered": [ivr names]}.
create or replace function check_new_ivrs(days_back int default 7)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_aliases int;
  v_new     text[];
begin
  v_aliases := heal_renamed_ivr_aliases(days_back);

  with seen as (
    select ivr_name, ivr_id, max(created_at) as last_at
    from canoe_calls
    where created_at >= now() - make_interval(days => days_back)
      and ivr_name ilike 'ascnd%' and is_test is not true
    group by 1, 2
  ),
  cand as (
    select distinct on (coalesce(s.ivr_id, s.ivr_name)) s.ivr_name, s.ivr_id
    from seen s
    where not exists (select 1 from agents a where a.ivr_name = s.ivr_name)
      and not exists (select 1 from agent_ivr_aliases x where x.ivr_name = s.ivr_name)
      and not exists (select 1 from new_ivr_detections d where d.ivr_name = s.ivr_name)
    order by coalesce(s.ivr_id, s.ivr_name), s.last_at desc
  ),
  hist as (   -- all history under the name, not just the window; lateral keeps it an index lookup per name
    select c.ivr_name, c.ivr_id, h.first_seen_at, h.calls
    from cand c
    cross join lateral (
      select min(k.created_at) as first_seen_at, count(*)::int as calls
      from canoe_calls k where k.ivr_name = c.ivr_name and k.is_test is not true
    ) h
  ),
  reg as (
    insert into agents (ivr_name, name, status, routing_type, first_seen_at, seen_calls)
    select ivr_name,
           -- 'ASCND AI Agent - Medicare - Aragon_12133401267 - Outgoing' -> 'Medicare - Aragon'
           coalesce(nullif(btrim(regexp_replace(regexp_replace(regexp_replace(ivr_name,
             '^\s*ascnd\s+ai\s+agent\s*-\s*', '', 'i'), '\s*-\s*outgoing\s*$', '', 'i'), '_\d{7,}', '', 'g')), ''), ivr_name),
           'needs_setup', 'unknown', first_seen_at, calls
    from hist
    on conflict (ivr_name) do nothing
    returning ivr_name
  ),
  det as (
    insert into new_ivr_detections (ivr_name, ivr_id, first_seen_at, calls_at_detection)
    select h.ivr_name, h.ivr_id, h.first_seen_at, h.calls
    from reg r join hist h using (ivr_name)
    on conflict (ivr_name) do nothing
    returning ivr_name
  )
  select coalesce(array_agg(ivr_name order by ivr_name), '{}') into v_new from det;

  -- Learn the new agents' ivr_ids; aliases any other name of the same new IVR.
  if cardinality(v_new) > 0 then
    v_aliases := v_aliases + heal_renamed_ivr_aliases(days_back);
  end if;

  update agents a set seen_calls = n.calls
  from (
    select a2.ivr_name,
           (select count(*)::int from canoe_calls k
            where k.is_test is not true
              and k.ivr_name = any (a2.ivr_name || array(select x.ivr_name from agent_ivr_aliases x
                                                         where x.canonical_ivr_name = a2.ivr_name))) as calls
    from agents a2 where a2.status = 'needs_setup'
  ) n
  where a.ivr_name = n.ivr_name and a.seen_calls is distinct from n.calls;

  return jsonb_build_object('aliases_added', v_aliases, 'registered', to_jsonb(v_new));
end;
$$;
alter function check_new_ivrs(int) set statement_timeout = '5min';
revoke execute on function check_new_ivrs(int) from public, anon, authenticated;
grant execute on function check_new_ivrs(int) to service_role;

-- ── 4) Schedule: after the sync lands, not before it (cron.schedule upserts by job name) ──
create extension if not exists pg_cron;
select cron.unschedule('heal-renamed-ivr-aliases')
where exists (select 1 from cron.job where jobname = 'heal-renamed-ivr-aliases');
select cron.schedule('check-new-ivrs', '15 7 * * *', $$select public.check_new_ivrs(7)$$);

-- ── 5) After applying, run once on its own (outside this file's transaction, which holds a lock
-- on agents for the ALTERs above; the 30-day scan takes a few seconds):
--   select check_new_ivrs(30);
-- As of 2026-11-13 that registers 2 IVRs, each with 1 call and an ASCND transcript:
-- 'ASCND AI Agent - hvac - Incoming' (Nov 4) and 'ASCND AI Agent - incoming - multicategory GLS'
-- (Nov 6). Older unregistered AI IVRs are left alone; to pick them up, run check_new_ivrs(<days>).
