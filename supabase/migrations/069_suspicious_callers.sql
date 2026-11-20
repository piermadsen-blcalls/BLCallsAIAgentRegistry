-- ============================================================
-- 069_suspicious_callers.sql
-- MK-195: data layer for the registry's Suspicious tab, a triage queue for coached or fake callers.
-- Three patterns, each a read-only function for signed-in users, plus a shared verdict table.
--
-- 1) suspicious_caller_key(called_from): the caller as digits, US numbers without the leading 1,
--    so '+1 (604) 555-0182' and '6045550182' are one caller. Null for fewer than 7 digits.
-- 2) coached_verdicts: one verdict per (caller, person) on "is this a coached caller?":
--    coached (Agree) / not_coached (Disagree) / unknown. Every signed-in user reads all of them;
--    a person adds, changes and removes only their own (RLS on the signed-in email). Written
--    through coached_verdict_set / coached_verdict_clear (SECURITY INVOKER, so RLS applies).
-- 3) suspicious_repeat_callers(from_ts, to_ts, ...): numbers with 2+ connected calls in the window,
--    with their ZIPs, verticals and publishers; cross_only keeps those spanning more than one.
--    zip is not in canoe_calls_mcp_cover_idx, so the first pass reads that index only and the
--    rows are fetched for repeat numbers alone.
-- 4) suspicious_conversions(from_ts, to_ts, fast_secs, min_long_pct): appointments and sales whose
--    whole call (duration) was under fast_secs, or min_long_pct+ above their vertical's median
--    conversion length in the window (verticals with 10+ conversions). Ticket defaults: 300 s, and
--    the page's slider starts at 50%.
-- 5) script_matches + refresh_script_matches(): near-identical transcripts within one vertical,
--    trailing 7 days, 40+ words, similarity 55%+ (ticket defaults). Precomputed nightly, read by
--    suspicious_similar_transcripts(min_sim).
--    How similarity is measured (calibrated read-only on prod, 2026-11-20, 7 days, ~4,300
--    transcripts): a transcript carries the buyer's own IVR greeting and hold messages, so raw
--    pg_trgm similarity put ~9,500 pairs over 55% in Dentist alone, all calls to the same office's
--    recording. So (a) lines that appear word-for-word in 3+ calls of the window are dropped as
--    recordings, and (b) similarity is the Jaccard overlap of 3-word sequences, not characters
--    (character trigrams of any two long English texts already overlap ~40%). The remaining
--    transcript must still have 40+ words. Result: 65 pairs across all verticals, in about 8 s.
-- 6) Nightly: pg_cron 'refresh-dashboard-rollup' (07:45 UTC) now calls refresh_dashboard_nightly(),
--    a procedure that runs refresh_dashboard_daily(45) as before, COMMITs it, then refreshes the
--    matches in their own transaction. A matching error is caught and logged as a warning; if the
--    matching is slow or cancelled (the job's statement_timeout is 120 s) the dashboard rollup is
--    already committed. Transaction control needs a procedure without SECURITY DEFINER or a SET
--    clause, and pg_cron sending CALL as its own statement (cron.use_background_workers = off on
--    prod, 2026-11-20). No new cron job.
-- Nothing for anon: every table and function here is revoked from anon and PUBLIC.
-- Rollback: supabase/rollbacks/069_suspicious_callers_down.sql
-- Test:     supabase/tests/069_suspicious_callers_test.sql
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

-- ── 1) Caller key ──
create or replace function suspicious_caller_key(called_from text)
returns text language sql immutable set search_path = '' as $$
  select case when length(d) = 11 and left(d, 1) = '1' then substr(d, 2)
              when length(d) between 7 and 15 then d end
  from (select regexp_replace(coalesce(called_from, ''), '\D', '', 'g') as d) x
$$;

-- ── 2) Verdicts ──
create table if not exists coached_verdicts (
  caller     text        not null check (caller ~ '^\d{7,15}$'),   -- suspicious_caller_key()
  decided_by text        not null,                                -- signed-in email, lower case
  verdict    text        not null check (verdict in ('coached', 'not_coached', 'unknown')),
  source     text        check (source in ('repeat', 'script', 'timing')),   -- sub-tab it was given on
  call_id    text,                                                -- the call being reviewed
  decided_at timestamptz not null default now(),
  primary key (caller, decided_by)
);
alter table coached_verdicts enable row level security;
revoke all on table coached_verdicts from public, anon, authenticated;
grant select, insert, update, delete on table coached_verdicts to authenticated;
drop policy if exists "team reads coached_verdicts"   on coached_verdicts;
drop policy if exists "own insert coached_verdicts"   on coached_verdicts;
drop policy if exists "own update coached_verdicts"   on coached_verdicts;
drop policy if exists "own delete coached_verdicts"   on coached_verdicts;
create policy "team reads coached_verdicts" on coached_verdicts for select to authenticated using (true);
create policy "own insert coached_verdicts" on coached_verdicts for insert to authenticated
  with check (decided_by = lower(auth.jwt() ->> 'email'));
create policy "own update coached_verdicts" on coached_verdicts for update to authenticated
  using (decided_by = lower(auth.jwt() ->> 'email')) with check (decided_by = lower(auth.jwt() ->> 'email'));
create policy "own delete coached_verdicts" on coached_verdicts for delete to authenticated
  using (decided_by = lower(auth.jwt() ->> 'email'));

-- Record or change the signed-in user's verdict on a caller (any form of the number).
create or replace function coached_verdict_set(p_caller text, p_verdict text, p_source text default null, p_call_id text default null)
returns void language sql security invoker set search_path = public, pg_temp as $$
  insert into coached_verdicts (caller, decided_by, verdict, source, call_id, decided_at)
  values (suspicious_caller_key(p_caller), lower(auth.jwt() ->> 'email'), p_verdict, p_source, p_call_id, now())
  on conflict (caller, decided_by) do update
    set verdict = excluded.verdict, source = excluded.source, call_id = excluded.call_id, decided_at = excluded.decided_at
$$;

-- Remove the signed-in user's own verdict on a caller.
create or replace function coached_verdict_clear(p_caller text)
returns void language sql security invoker set search_path = public, pg_temp as $$
  delete from coached_verdicts
  where caller = suspicious_caller_key(p_caller) and decided_by = lower(auth.jwt() ->> 'email')
$$;

-- ── 3) Repeat callers ──
create or replace function suspicious_repeat_callers(from_ts timestamptz, to_ts timestamptz,
  min_calls int default 2, cross_only boolean default true, max_rows int default 300)
returns table (caller text, called_from text, calls int, distinct_zips int, distinct_verticals int,
  distinct_publishers int, zips text[], verticals text[], publishers text[], conversions int, flagged int,
  first_call timestamptz, last_call timestamptz, call_ids text[], total int)
language sql stable set search_path = public, pg_temp as $$
  with nums as materialized (   -- index-only on canoe_calls_mcp_cover_idx
    select suspicious_caller_key(c.called_from) as caller, array_agg(distinct c.called_from) as raw
    from canoe_calls c
    where c.created_at >= from_ts and c.created_at < to_ts and c.is_test is not true and c.result = 'connected'
    group by 1
    having count(*) >= min_calls
  ), calls as (
    select n.caller, c.id, c.created_at, c.called_from, nullif(c.zip, '') as zip, c.vertical_name, c.publisher_name,
      c.our_outcome, (c.flags <> '[]'::jsonb or c.suspicious_call is true) as flagged
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
      count(*) filter (where our_outcome = any(dashboard_conversion_outcomes()))::int as conversions,
      count(*) filter (where flagged)::int as flagged,
      min(created_at) as first_call, max(created_at) as last_call,
      (array_agg(id order by created_at desc))[1:50] as call_ids
    from calls
    group by caller
  )
  select g.*, (count(*) over ())::int as total
  from g
  where not cross_only or g.distinct_zips > 1 or g.distinct_verticals > 1 or g.distinct_publishers > 1
  order by g.distinct_zips desc, g.calls desc, g.last_call desc
  limit max_rows
$$;

-- ── 4) Odd timing ──
create or replace function suspicious_conversions(from_ts timestamptz, to_ts timestamptz,
  fast_secs int default 300, min_long_pct int default 10)
returns table (id text, created_at timestamptz, caller text, called_from text, zip text, city text, state text,
  vertical_name text, publisher_name text, advertiser_name text, duration int, our_outcome text,
  recording_url text, ascnd_recording_url text, typical_secs int, vertical_n int, pct_above int,
  is_fast boolean, is_long boolean)
language sql stable set search_path = public, pg_temp as $$
  with c as materialized (
    select c.id, c.created_at, suspicious_caller_key(c.called_from) as caller, c.called_from, c.zip, c.city, c.state,
      c.vertical_name, c.publisher_name, c.advertiser_name, c.duration, c.our_outcome, c.recording_url, c.ascnd_recording_url
    from canoe_calls c
    where c.our_outcome = any(dashboard_conversion_outcomes())
      and c.created_at >= from_ts and c.created_at < to_ts and c.is_test is not true and c.duration > 0
  ), v as (
    select coalesce(vertical_name, '') as vk, percentile_cont(0.5) within group (order by duration) as typical, count(*)::int as n
    from c group by 1
  ), r as (
    select c.*, round(v.typical)::int as typical_secs, v.n as vertical_n,
      floor((c.duration - v.typical) * 100 / v.typical)::int as pct_above
    from c join v on v.vk = coalesce(c.vertical_name, '')
  )
  select r.*, r.duration < fast_secs as is_fast, (r.vertical_n >= 10 and r.pct_above >= min_long_pct) as is_long
  from r
  where r.duration < fast_secs or (r.vertical_n >= 10 and r.pct_above >= min_long_pct)
  order by r.created_at desc
$$;

-- ── 5) Same script ──
create table if not exists script_matches (
  call_id_a   text        not null,
  call_id_b   text        not null,
  vertical    text        not null,
  similarity  real        not null,   -- 0..1, Jaccard of 3-word sequences after dropping recordings
  same_caller boolean     not null,
  computed_at timestamptz not null default now(),
  primary key (call_id_a, call_id_b),
  check (call_id_a < call_id_b)
);
alter table script_matches enable row level security;
revoke all on table script_matches from public, anon, authenticated;
grant select on table script_matches to authenticated;
drop policy if exists "auth users can read script_matches" on script_matches;
create policy "auth users can read script_matches" on script_matches for select to authenticated using (true);

-- Rebuilds script_matches from the trailing days_back days; returns the number of pairs.
create or replace function refresh_script_matches(days_back int default 7, min_sim real default 0.55,
  min_words int default 40, recording_calls int default 3)
returns int language plpgsql security definer set search_path = public, pg_temp set work_mem = '64MB' as $$
declare
  v_pairs int;
begin
  perform pg_advisory_xact_lock(hashtext('refresh_script_matches'));
  delete from script_matches;
  with docs as materialized (
    select row_number() over ()::int as d, id, coalesce(vertical_name, '') as v, called_from, transcription as t
    from canoe_calls
    where created_at >= now() - make_interval(days => days_back) and is_test is not true
      and length(transcription) >= min_words * 2   -- can't hold min_words words otherwise
  ), lines as materialized (
    select docs.d, docs.v, btrim(regexp_replace(lower(s.l), '[^a-z0-9]+', ' ', 'g')) as nl
    from docs, regexp_split_to_table(docs.t, '\n') s(l)
  ), recordings as materialized (   -- the same line word-for-word in recording_calls+ calls
    select nl from lines group by nl having count(distinct d) >= recording_calls
  ), kept as materialized (
    select l.d, l.v, string_to_array(l.nl, ' ') as a
    from lines l
    where l.nl <> '' and not exists (select 1 from recordings r where r.nl = l.nl)
  ), long_enough as materialized (
    select d from kept group by d having sum(cardinality(a)) >= min_words
  ), sh as materialized (   -- distinct 3-word sequences per call, hashed with the vertical
    select distinct k.d, hashtextextended(k.v || '|' || k.a[i] || ' ' || k.a[i + 1] || ' ' || k.a[i + 2], 0) as g
    from kept k join long_enough using (d), generate_series(1, cardinality(k.a) - 2) i
  ), sz as materialized (
    select d, count(*) as n from sh group by d
  ), shared as materialized (
    select sh.* from sh join (select g from sh group by g having count(*) > 1) x using (g)
  ), pairs as (
    select a.d as da, b.d as db, count(*) as inter
    from shared a join shared b on a.g = b.g and a.d < b.d
    group by 1, 2
  ), j as (
    select p.da, p.db, p.inter::real / (sa.n + sb.n - p.inter) as sim
    from pairs p join sz sa on sa.d = p.da join sz sb on sb.d = p.db
  )
  insert into script_matches (call_id_a, call_id_b, vertical, similarity, same_caller)
  select least(da.id, db.id), greatest(da.id, db.id), da.v, round(j.sim::numeric, 3)::real,
    coalesce(suspicious_caller_key(da.called_from) = suspicious_caller_key(db.called_from), false)
  from j join docs da on da.d = j.da join docs db on db.d = j.db
  where j.sim >= min_sim;
  get diagnostics v_pairs = row_count;
  return v_pairs;
end;
$$;
revoke execute on function refresh_script_matches(int, real, int, int) from public, anon, authenticated;
grant execute on function refresh_script_matches(int, real, int, int) to service_role;

-- Stored matches with both calls' details, most similar first.
create or replace function suspicious_similar_transcripts(min_sim real default 0.55)
returns table (call_id_a text, call_id_b text, similarity real, same_caller boolean, vertical text, computed_at timestamptz,
  a_caller text, a_called_from text, a_publisher text, a_vertical text, a_created_at timestamptz, a_duration int,
  a_recording_url text, a_ascnd_recording_url text, a_outcome text,
  b_caller text, b_called_from text, b_publisher text, b_vertical text, b_created_at timestamptz, b_duration int,
  b_recording_url text, b_ascnd_recording_url text, b_outcome text)
language sql stable set search_path = public, pg_temp as $$
  select m.call_id_a, m.call_id_b, m.similarity, m.same_caller, m.vertical, m.computed_at,
    suspicious_caller_key(a.called_from), a.called_from, a.publisher_name, a.vertical_name, a.created_at, a.duration,
    a.recording_url, a.ascnd_recording_url, a.our_outcome,
    suspicious_caller_key(b.called_from), b.called_from, b.publisher_name, b.vertical_name, b.created_at, b.duration,
    b.recording_url, b.ascnd_recording_url, b.our_outcome
  from script_matches m
  join canoe_calls a on a.id = m.call_id_a
  join canoe_calls b on b.id = m.call_id_b
  where m.similarity >= min_sim
  order by m.similarity desc, a.created_at desc
  limit 500
$$;

-- Signed-in only. (CREATE OR REPLACE keeps grants, so a re-run changes nothing.)
do $$
declare f text;
begin
  foreach f in array array[
    'suspicious_caller_key(text)',
    'coached_verdict_set(text, text, text, text)', 'coached_verdict_clear(text)',
    'suspicious_repeat_callers(timestamptz, timestamptz, int, boolean, int)',
    'suspicious_conversions(timestamptz, timestamptz, int, int)',
    'suspicious_similar_transcripts(real)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ── 6) Nightly: the dashboard rollup, committed, then the matching ──
-- No SECURITY DEFINER and no SET clause: either would forbid the COMMIT. Names are qualified.
create or replace procedure refresh_dashboard_nightly()
language plpgsql as $$
begin
  perform public.refresh_dashboard_daily(45);
  commit;   -- the dashboard rollup is saved before the matching starts
  begin
    perform public.refresh_script_matches();
  exception when others then
    raise warning 'refresh_script_matches failed (dashboard rollup kept): %', sqlerrm;
  end;
end;
$$;
revoke execute on procedure refresh_dashboard_nightly() from public, anon, authenticated;

-- Same job name and time as 064; cron.schedule upserts by name.
select cron.schedule('refresh-dashboard-rollup', '45 7 * * *', $$call public.refresh_dashboard_nightly()$$);
