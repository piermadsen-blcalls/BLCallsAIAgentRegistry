-- ============================================================
-- 070_suspicious_tab_v2.sql
-- MK-196: Suspicious tab v2 (on top of 069). Three changes the first use of MK-195 asked for.
--
-- 1) Odd timing by agent: suspicious_odd_timing(from_ts, to_ts, min_pct, max_rows) replaces
--    suspicious_conversions (dropped). Every connected call in the window, each compared with the
--    typical call for the same AI agent, highest "% over typical" first; min_pct filters by that
--    percentage (the page's slider).
--    "Typical" = the median of the agent's connected calls over the trailing 30 days (to_ts - 30 days
--    .. to_ts). Connected = result = 'connected' (checked against recordings on 2026-11-23: 20/20;
--    connect_duration > 0 was wrong on every duplicate call) with a recorded duration > 0 (1,087
--    connected calls a month have no duration). The agent is the canonical IVR name
--    (agent_ivr_aliases). An agent with fewer than 20 such calls, or no IVR name, uses its vertical's
--    typical instead (typical_from says which, typical_n how many calls it rests on).
-- 2) Repeat callers carry the caller's 30-day money: payin_30d / payout_30d / margin_30d, summed
--    over every non-test call from that number (any format) in to_ts - 30 days .. to_ts, whatever
--    the page's window. advertiser_payin and publisher_payout are filled on every call (zero when
--    unpaid), so the sum needs no null handling. The conversions count is gone: "N became an
--    appointment or sale" was not accurate.
-- 3) Same script removed. The nightly 'refresh-dashboard-rollup' job goes back to 064's
--    refresh_dashboard_daily(45); the procedure refresh_dashboard_nightly, refresh_script_matches,
--    suspicious_similar_transcripts and script_matches are dropped. Every match it found was
--    advertiser-side recorded audio, not coached callers. coached_verdicts is untouched: verdicts
--    given on the Same script sub-tab (source = 'script') stay, and 'script' stays a valid source.
-- Nothing for anon: both functions are revoked from anon and PUBLIC.
-- Rollback: supabase/rollbacks/070_suspicious_tab_v2_down.sql
-- Test:     supabase/tests/070_suspicious_tab_v2_test.sql
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

-- ── 1) Odd timing: every connected call against its agent's typical length ──
drop function if exists suspicious_conversions(timestamptz, timestamptz, int, int);
create or replace function suspicious_odd_timing(from_ts timestamptz, to_ts timestamptz,
  min_pct int default 0, max_rows int default 2000)
returns table (id text, created_at timestamptz, caller text, called_from text, zip text, city text, state text,
  ivr_name text, agent_key text, vertical_name text, publisher_name text, advertiser_name text, duration int,
  our_outcome text, recording_url text, ascnd_recording_url text,
  typical_secs int, typical_n int, typical_from text, pct_above int, total int)
language sql stable set search_path = public, pg_temp as $$
  with base as materialized (   -- connected calls with a duration: the window, plus the 30 days "typical" rests on
    select c.id, c.created_at, c.called_from, c.zip, c.city, c.state, c.ivr_name,
      coalesce(al.canonical_ivr_name, c.ivr_name) as agent_key, coalesce(c.vertical_name, '') as vk,
      c.vertical_name, c.publisher_name, c.advertiser_name, c.duration, c.our_outcome, c.recording_url, c.ascnd_recording_url
    from canoe_calls c
    left join agent_ivr_aliases al on al.ivr_name = c.ivr_name
    where c.created_at >= least(from_ts, to_ts - interval '30 days') and c.created_at < to_ts
      and c.is_test is not true and c.result = 'connected' and c.duration > 0
  ), by_agent as (
    select agent_key, percentile_cont(0.5) within group (order by duration) as typical, count(*)::int as n
    from base where agent_key is not null and created_at >= to_ts - interval '30 days'
    group by 1
  ), by_vertical as (
    select vk, percentile_cont(0.5) within group (order by duration) as typical, count(*)::int as n
    from base where created_at >= to_ts - interval '30 days'
    group by 1
  ), scored as (
    select b.*,
      case when a.n >= 20 then a.typical else v.typical end as typical,
      case when a.n >= 20 then a.n       else v.n       end as typical_n,
      case when a.n >= 20 then 'agent'   else 'vertical' end as typical_from
    from base b
    left join by_agent a on a.agent_key = b.agent_key
    join by_vertical v on v.vk = b.vk
    where b.created_at >= from_ts
  )
  select s.id, s.created_at, suspicious_caller_key(s.called_from), s.called_from, s.zip, s.city, s.state,
    s.ivr_name, s.agent_key, s.vertical_name, s.publisher_name, s.advertiser_name, s.duration, s.our_outcome,
    s.recording_url, s.ascnd_recording_url,
    round(s.typical)::int, s.typical_n, s.typical_from,
    floor((s.duration - s.typical) * 100 / s.typical)::int as pct_above,
    (count(*) over ())::int as total
  from scored s
  where floor((s.duration - s.typical) * 100 / s.typical) >= min_pct
  order by pct_above desc, s.duration desc, s.created_at desc
  limit max_rows
$$;

-- ── 2) Repeat callers: 30-day money per caller, no conversions count ──
drop function if exists suspicious_repeat_callers(timestamptz, timestamptz, int, boolean, int);   -- return type changed
create or replace function suspicious_repeat_callers(from_ts timestamptz, to_ts timestamptz,
  min_calls int default 2, cross_only boolean default true, max_rows int default 300)
returns table (caller text, called_from text, calls int, distinct_zips int, distinct_verticals int,
  distinct_publishers int, zips text[], verticals text[], publishers text[], flagged int,
  first_call timestamptz, last_call timestamptz, call_ids text[],
  payin_30d numeric, payout_30d numeric, margin_30d numeric, total int)
language sql stable set search_path = public, pg_temp as $$
  with nums as materialized (   -- index-only on canoe_calls_mcp_cover_idx
    select suspicious_caller_key(c.called_from) as caller, array_agg(distinct c.called_from) as raw
    from canoe_calls c
    where c.created_at >= from_ts and c.created_at < to_ts and c.is_test is not true and c.result = 'connected'
    group by 1
    having count(*) >= min_calls
  ), calls as (
    select n.caller, c.id, c.created_at, c.called_from, nullif(c.zip, '') as zip, c.vertical_name, c.publisher_name,
      (c.flags <> '[]'::jsonb or c.suspicious_call is true) as flagged
    from nums n join canoe_calls c on c.called_from = any(n.raw)
    where n.caller is not null
      and c.created_at >= from_ts and c.created_at < to_ts and c.is_test is not true and c.result = 'connected'
  ), g as (
    select caller, min(called_from) as called_from, count(*)::int as calls,
      count(distinct zip)::int as distinct_zips, count(distinct vertical_name)::int as distinct_verticals,
      count(distinct publisher_name)::int as distinct_publishers,
      coalesce(array_agg(distinct zip) filter (where zip is not null), '{}') as zips,
      coalesce(array_agg(distinct vertical_name) filter (where vertical_name is not null), '{}') as verticals,
      coalesce(array_agg(distinct publisher_name) filter (where publisher_name is not null), '{}') as publishers,
      count(*) filter (where flagged)::int as flagged,
      min(created_at) as first_call, max(created_at) as last_call,
      (array_agg(id order by created_at desc))[1:50] as call_ids
    from calls
    group by caller
  ), money as (   -- every call from the number in the trailing 30 days, in any format, paid or not
    select suspicious_caller_key(c.called_from) as caller,
      sum(coalesce(c.advertiser_payin, 0)) as payin, sum(coalesce(c.publisher_payout, 0)) as payout
    from canoe_calls c
    where c.created_at >= to_ts - interval '30 days' and c.created_at < to_ts and c.is_test is not true
      and suspicious_caller_key(c.called_from) in (select caller from g)
    group by 1
  )
  select g.*, coalesce(m.payin, 0), coalesce(m.payout, 0), coalesce(m.payin, 0) - coalesce(m.payout, 0),
    (count(*) over ())::int as total
  from g left join money m on m.caller = g.caller
  where not cross_only or g.distinct_zips > 1 or g.distinct_verticals > 1 or g.distinct_publishers > 1
  order by g.distinct_zips desc, g.calls desc, g.last_call desc
  limit max_rows
$$;

-- Signed-in only.
do $$
declare f text;
begin
  foreach f in array array[
    'suspicious_repeat_callers(timestamptz, timestamptz, int, boolean, int)',
    'suspicious_odd_timing(timestamptz, timestamptz, int, int)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ── 3) Same script: out of the nightly job and out of the database. Verdicts stay. ──
-- Same job name and time as 064 and 069; cron.schedule upserts by name.
select cron.schedule('refresh-dashboard-rollup', '45 7 * * *', $$select public.refresh_dashboard_daily(45)$$);
drop procedure if exists refresh_dashboard_nightly();
drop function if exists suspicious_similar_transcripts(real);
drop function if exists refresh_script_matches(int, real, int, int);
drop table if exists script_matches;
