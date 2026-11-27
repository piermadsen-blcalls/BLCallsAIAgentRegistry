-- ============================================================
-- Rollback for 071_suspicious_tab_v3.sql. Puts the Suspicious tab's data layer back to 070:
-- suspicious_odd_timing returns; the transcript search, the Decided lists, the coached calls,
-- the Canoe block table and its two functions and the caller-key index go. Verdicts are kept;
-- the source check goes back to 069's three values, so verdicts given on the Transcript keywords
-- sub-tab or from a Decided list lose their source (set to null) but stay.
-- The Canoe block ticks are lost with the table. Revert the page's Suspicious tab with it.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

-- ── 1) The v3 reads and the Canoe block ──
drop function if exists suspicious_coached_calls(int);
drop function if exists suspicious_decided_callers(text);
drop function if exists suspicious_transcript_search(timestamptz, timestamptz, text[], text, int);
drop function if exists canoe_block_set(text);
drop function if exists canoe_block_clear(text);
drop table if exists canoe_blocks;
drop index if exists canoe_calls_caller_key_idx;

-- ── 2) Verdict sources back to 069 ──
update coached_verdicts set source = null where source not in ('repeat', 'script', 'timing');
alter table coached_verdicts drop constraint if exists coached_verdicts_source_check;
alter table coached_verdicts add constraint coached_verdicts_source_check
  check (source in ('repeat', 'script', 'timing'));

-- ── 3) Odd timing back (070) ──
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
revoke execute on function suspicious_odd_timing(timestamptz, timestamptz, int, int) from public, anon;
grant execute on function suspicious_odd_timing(timestamptz, timestamptz, int, int) to authenticated, service_role;
