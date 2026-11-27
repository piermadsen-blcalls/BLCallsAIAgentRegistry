-- ============================================================
-- 071_suspicious_tab_v3.sql
-- MK-199: Suspicious tab v3 (on top of 069 and 070). Six changes daily use of MK-196 asked for.
--
-- 1) canoe_blocks: a record that a caller has been blocked in Canoe. One row per caller (the same
--    digits key as coached_verdicts), shared by the team: anyone signed in can tick or untick, and the
--    row says who ticked it and when. Written through canoe_block_set / canoe_block_clear
--    (SECURITY INVOKER, so RLS applies). Ticking records; it does not block anything in Canoe.
-- 2) coached_verdicts.source gains 'keywords' (a verdict given on the Transcript keywords sub-tab)
--    and 'decided' (one changed from a Decided list). 'timing' stays valid: the Odd timing sub-tab is
--    gone from the page but its verdicts are kept.
-- 3) canoe_calls_caller_key_idx: an index on suspicious_caller_key(called_from) for non-test calls.
--    The Decided lists, the coached caller stats and the CSV export read every synced call of a caller
--    across all time; 069/070 avoided this by matching the raw number variants inside one window.
--    Plain CREATE INDEX (the SQL editor runs the file in one transaction, which CONCURRENTLY forbids);
--    it holds a share lock on canoe_calls while it builds. To avoid the lock, run that one statement
--    alone with CONCURRENTLY and skip it here.
-- 4) suspicious_transcript_search(from_ts, to_ts, keywords, agent_key, max_rows): connected, non-test
--    calls in the window whose transcript contains every keyword (ILIKE, so capitals do not matter
--    and part of a word matches: 'spider' finds 'spiders'; % _ \ in a keyword are matched literally),
--    optionally for one agent (canonical IVR name via agent_ivr_aliases, as 070), newest first.
--    Returns the row's fields and a snippet around the first keyword, not the transcript (the page
--    loads a transcript when a row is opened, as before). Plain matching, not AI.
-- 5) suspicious_decided_callers(p_verdict): one row per caller anyone gave that verdict ('coached' =
--    Agree, 'unknown'), whatever the window: the caller's calls across all time (count, verticals,
--    first/last, every call id newest first), every verdict (who, what, when) as json, the Canoe
--    block (who, when), and the 30-day pieces of the "why it's here" sentence (connected calls, ZIPs,
--    verticals, publishers; pay-in, payout and margin over every call), the same rules as 070's
--    suspicious_repeat_callers.
-- 6) suspicious_coached_calls(max_rows): one row per non-test call, across all time, from every caller
--    anyone marked Agree, with the call's agent, vertical, publisher, advertiser, ZIP, length, outcome
--    and AI summary. No transcript and no recording link. The page counts the connected ones inside
--    its window for the Coached caller stats sub-tab and builds the CSV from all of them, in the
--    browser; nothing is stored.
-- 7) suspicious_odd_timing is dropped: the Odd timing sub-tab is replaced (it was not finding coached
--    callers). coached_verdicts is untouched.
-- Nothing for anon: every table and function here is revoked from anon and PUBLIC.
-- Rollback: supabase/rollbacks/071_suspicious_tab_v3_down.sql
-- Test:     supabase/tests/071_suspicious_tab_v3_test.sql
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

-- ── 1) Blocked in Canoe ──
create table if not exists canoe_blocks (
  caller     text        primary key check (caller ~ '^\d{7,15}$'),   -- suspicious_caller_key()
  blocked_by text        not null,                                    -- signed-in email, lower case
  blocked_at timestamptz not null default now()
);
alter table canoe_blocks enable row level security;
revoke all on table canoe_blocks from public, anon, authenticated;
grant select, insert, update, delete on table canoe_blocks to authenticated;
drop policy if exists "team reads canoe_blocks"   on canoe_blocks;
drop policy if exists "own insert canoe_blocks"   on canoe_blocks;
drop policy if exists "own update canoe_blocks"   on canoe_blocks;
drop policy if exists "team deletes canoe_blocks" on canoe_blocks;
create policy "team reads canoe_blocks" on canoe_blocks for select to authenticated using (true);
create policy "own insert canoe_blocks" on canoe_blocks for insert to authenticated
  with check (blocked_by = lower(auth.jwt() ->> 'email'));
create policy "own update canoe_blocks" on canoe_blocks for update to authenticated
  using (true) with check (blocked_by = lower(auth.jwt() ->> 'email'));
create policy "team deletes canoe_blocks" on canoe_blocks for delete to authenticated using (true);

-- Tick: the caller (any form of the number) is blocked in Canoe, by the signed-in user, now.
create or replace function canoe_block_set(p_caller text)
returns void language sql security invoker set search_path = public, pg_temp as $$
  insert into canoe_blocks (caller, blocked_by, blocked_at)
  values (suspicious_caller_key(p_caller), lower(auth.jwt() ->> 'email'), now())
  on conflict (caller) do update set blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at
$$;

-- Untick. Anyone signed in can clear a tick, not only the person who ticked it.
create or replace function canoe_block_clear(p_caller text)
returns void language sql security invoker set search_path = public, pg_temp as $$
  delete from canoe_blocks where caller = suspicious_caller_key(p_caller)
$$;

-- ── 2) Verdict sources: the two new places a verdict can be given ──
alter table coached_verdicts drop constraint if exists coached_verdicts_source_check;
alter table coached_verdicts add constraint coached_verdicts_source_check
  check (source in ('repeat', 'script', 'timing', 'keywords', 'decided'));

-- ── 3) Every call of a caller, across all time ──
create index if not exists canoe_calls_caller_key_idx
  on canoe_calls (suspicious_caller_key(called_from)) where is_test is not true;

-- ── 4) Transcript keywords ──
create or replace function suspicious_transcript_search(from_ts timestamptz, to_ts timestamptz,
  keywords text[], agent_key text default null, max_rows int default 300)
returns table (id text, created_at timestamptz, caller text, called_from text, zip text, city text, state text,
  ivr_name text, agent_key text, vertical_name text, publisher_name text, advertiser_name text, duration int,
  our_outcome text, our_summary text, recording_url text, ascnd_recording_url text, snippet text, total int)
language sql stable set search_path = public, pg_temp as $$
  with kws as (   -- one row: the ILIKE patterns (special characters escaped) and the first keyword
    select array_agg('%' || replace(replace(replace(k, '\', '\\'), '%', '\%'), '_', '\_') || '%' order by ord) as pats,
      (array_agg(lower(k) order by ord))[1] as first_kw
    from (select btrim(k) as k, ord from unnest(keywords) with ordinality as u(k, ord)) x
    where k <> ''
  ), hits as materialized (
    select c.id, c.created_at, c.called_from, c.zip, c.city, c.state, c.ivr_name,
      coalesce(al.canonical_ivr_name, c.ivr_name) as agent_key, c.vertical_name, c.publisher_name, c.advertiser_name,
      c.duration, c.our_outcome, c.our_summary, c.recording_url, c.ascnd_recording_url, c.transcription
    from canoe_calls c
    left join agent_ivr_aliases al on al.ivr_name = c.ivr_name
    cross join kws
    where c.created_at >= from_ts and c.created_at < to_ts and c.is_test is not true and c.result = 'connected'
      and c.transcription is not null and cardinality(kws.pats) > 0
      and c.transcription ilike all (kws.pats)
      and (coalesce(agent_key, '') = '' or coalesce(al.canonical_ivr_name, c.ivr_name) = agent_key)
  )
  select h.id, h.created_at, suspicious_caller_key(h.called_from), h.called_from, h.zip, h.city, h.state, h.ivr_name,
    h.agent_key, h.vertical_name, h.publisher_name, h.advertiser_name, h.duration, h.our_outcome, h.our_summary,
    h.recording_url, h.ascnd_recording_url,
    -- up to 70 characters either side of the first keyword's first appearance, on one line
    (case when s.start > 1 then '…' else '' end)
      || regexp_replace(substr(h.transcription, s.start, s.len), '\s+', ' ', 'g')
      || (case when s.start + s.len <= length(h.transcription) then '…' else '' end) as snippet,
    (count(*) over ())::int as total
  from hits h
  cross join kws
  cross join lateral (
    select greatest(1, position(kws.first_kw in lower(h.transcription)) - 70) as start,
      140 + length(kws.first_kw) as len
  ) s
  order by h.created_at desc
  limit max_rows
$$;

-- ── 5) The Decided lists ──
create or replace function suspicious_decided_callers(p_verdict text)
returns table (caller text, called_from text, calls int, verticals text[], first_call timestamptz, last_call timestamptz,
  call_ids text[], verdicts jsonb, blocked_by text, blocked_at timestamptz,
  calls_30d int, zips_30d text[], verticals_30d text[], publishers_30d text[],
  payin_30d numeric, payout_30d numeric, margin_30d numeric, total int)
language sql stable set search_path = public, pg_temp as $$
  with vk as (
    select distinct v.caller from coached_verdicts v where v.verdict = p_verdict
  ), calls as (   -- every non-test call from the number, any format, across all time (canoe_calls_caller_key_idx)
    select vk.caller, c.id, c.created_at, c.called_from, nullif(c.zip, '') as zip, c.vertical_name, c.publisher_name,
      c.result, c.advertiser_payin, c.publisher_payout,
      c.created_at >= now() - interval '30 days' as recent
    from vk join canoe_calls c on suspicious_caller_key(c.called_from) = vk.caller
    where c.is_test is not true
  ), g as (
    select caller, min(called_from) as called_from, count(*)::int as calls,
      coalesce(array_agg(distinct vertical_name) filter (where vertical_name is not null), '{}') as verticals,
      min(created_at) as first_call, max(created_at) as last_call,
      array_agg(id order by created_at desc) as call_ids,
      count(*) filter (where recent and result = 'connected')::int as calls_30d,
      coalesce(array_agg(distinct zip) filter (where recent and result = 'connected' and zip is not null), '{}') as zips_30d,
      coalesce(array_agg(distinct vertical_name) filter (where recent and result = 'connected' and vertical_name is not null), '{}') as verticals_30d,
      coalesce(array_agg(distinct publisher_name) filter (where recent and result = 'connected' and publisher_name is not null), '{}') as publishers_30d,
      coalesce(sum(coalesce(advertiser_payin, 0)) filter (where recent), 0) as payin_30d,
      coalesce(sum(coalesce(publisher_payout, 0)) filter (where recent), 0) as payout_30d
    from calls
    group by caller
  )
  select vk.caller, g.called_from, coalesce(g.calls, 0), coalesce(g.verticals, '{}'), g.first_call, g.last_call,
    coalesce(g.call_ids, '{}'),
    (select jsonb_agg(jsonb_build_object('by', v.decided_by, 'verdict', v.verdict, 'at', v.decided_at) order by v.decided_at)
       from coached_verdicts v where v.caller = vk.caller) as verdicts,
    b.blocked_by, b.blocked_at,
    coalesce(g.calls_30d, 0), coalesce(g.zips_30d, '{}'), coalesce(g.verticals_30d, '{}'), coalesce(g.publishers_30d, '{}'),
    coalesce(g.payin_30d, 0), coalesce(g.payout_30d, 0), coalesce(g.payin_30d, 0) - coalesce(g.payout_30d, 0),
    (count(*) over ())::int as total
  from vk
  left join g on g.caller = vk.caller
  left join canoe_blocks b on b.caller = vk.caller
  order by g.last_call desc nulls last, vk.caller
$$;

-- ── 6) Every call of every coached caller (stats and the CSV) ──
create or replace function suspicious_coached_calls(max_rows int default 20000)
returns table (caller text, id text, created_at timestamptz, called_from text, ivr_name text, agent_key text,
  vertical_name text, publisher_name text, advertiser_name text, zip text, duration int, result text,
  our_outcome text, our_summary text, total int)
language sql stable set search_path = public, pg_temp as $$
  with vk as (
    select distinct v.caller from coached_verdicts v where v.verdict = 'coached'
  )
  select vk.caller, c.id, c.created_at, c.called_from, c.ivr_name, coalesce(al.canonical_ivr_name, c.ivr_name),
    c.vertical_name, c.publisher_name, c.advertiser_name, nullif(c.zip, ''), c.duration, c.result,
    c.our_outcome, c.our_summary, (count(*) over ())::int as total
  from vk
  join canoe_calls c on suspicious_caller_key(c.called_from) = vk.caller
  left join agent_ivr_aliases al on al.ivr_name = c.ivr_name
  where c.is_test is not true
  order by vk.caller, c.created_at desc
  limit max_rows
$$;

-- Signed-in only. (CREATE OR REPLACE keeps grants, so a re-run changes nothing.)
do $$
declare f text;
begin
  foreach f in array array[
    'canoe_block_set(text)', 'canoe_block_clear(text)',
    'suspicious_transcript_search(timestamptz, timestamptz, text[], text, int)',
    'suspicious_decided_callers(text)',
    'suspicious_coached_calls(int)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ── 7) Odd timing: out of the database. Verdicts stay. ──
drop function if exists suspicious_odd_timing(timestamptz, timestamptz, int, int);
