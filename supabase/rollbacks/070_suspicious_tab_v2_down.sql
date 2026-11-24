-- ============================================================
-- Rollback for 070_suspicious_tab_v2.sql. Puts the Suspicious tab's data layer back to 069:
-- suspicious_conversions and the 069 suspicious_repeat_callers (with conversions, without the
-- 30-day money) return, script_matches, refresh_script_matches, suspicious_similar_transcripts and
-- the nightly procedure come back (the job calls the procedure again), suspicious_odd_timing goes.
-- script_matches comes back empty; the next 07:45 UTC run fills it. Verdicts are not touched.
-- Revert the page's Suspicious tab with it.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

-- ── 1) Odd timing back to conversions only (069) ──
drop function if exists suspicious_odd_timing(timestamptz, timestamptz, int, int);
create or replace function suspicious_conversions(from_ts timestamptz, to_ts timestamptz,
  min_secs int default 600, max_rows int default 2000)
returns table (id text, created_at timestamptz, caller text, called_from text, zip text, city text, state text,
  ivr_name text, vertical_name text, publisher_name text, advertiser_name text, duration int, our_outcome text,
  recording_url text, ascnd_recording_url text, typical_secs int, vertical_n int, pct_above int, total int)
language sql stable set search_path = public, pg_temp as $$
  with c as materialized (
    select c.id, c.created_at, suspicious_caller_key(c.called_from) as caller, c.called_from, c.zip, c.city, c.state,
      c.ivr_name, c.vertical_name, c.publisher_name, c.advertiser_name, c.duration, c.our_outcome, c.recording_url, c.ascnd_recording_url
    from canoe_calls c
    where c.our_outcome = any(dashboard_conversion_outcomes())
      and c.created_at >= from_ts and c.created_at < to_ts and c.is_test is not true and c.duration > 0
  ), v as (
    select coalesce(vertical_name, '') as vk, percentile_cont(0.5) within group (order by duration) as typical, count(*)::int as n
    from c group by 1
  )
  select c.*, round(v.typical)::int as typical_secs, v.n as vertical_n,
    floor((c.duration - v.typical) * 100 / v.typical)::int as pct_above,
    (count(*) over ())::int as total
  from c join v on v.vk = coalesce(c.vertical_name, '')
  where c.duration >= min_secs
  order by c.duration desc, c.created_at desc
  limit max_rows
$$;

-- ── 2) Repeat callers back to 069 (conversions count, no money) ──
drop function if exists suspicious_repeat_callers(timestamptz, timestamptz, int, boolean, int);
create or replace function suspicious_repeat_callers(from_ts timestamptz, to_ts timestamptz,
  min_calls int default 2, cross_only boolean default true, max_rows int default 300)
returns table (caller text, called_from text, calls int, distinct_zips int, distinct_verticals int,
  distinct_publishers int, zips text[], verticals text[], publishers text[], conversions int, flagged int,
  first_call timestamptz, last_call timestamptz, call_ids text[], total int)
language sql stable set search_path = public, pg_temp as $$
  with nums as materialized (
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

-- ── 3) Same script back (069), empty until the next nightly run ──
create table if not exists script_matches (
  call_id_a   text        not null,
  call_id_b   text        not null,
  vertical    text        not null,
  similarity  real        not null,
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

create or replace function refresh_script_matches(days_back int default 7, min_sim real default 0.30,
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
      and length(transcription) >= min_words * 2
  ), lines as materialized (
    select docs.d, docs.v, btrim(regexp_replace(lower(s.l), '[^a-z0-9]+', ' ', 'g')) as nl
    from docs, regexp_split_to_table(docs.t, '\n') s(l)
  ), recordings as materialized (
    select nl from lines group by nl having count(distinct d) >= recording_calls
  ), kept as materialized (
    select l.d, l.v, string_to_array(l.nl, ' ') as a
    from lines l
    where l.nl <> '' and not exists (select 1 from recordings r where r.nl = l.nl)
  ), long_enough as materialized (
    select d from kept group by d having sum(cardinality(a)) >= min_words
  ), sh as materialized (
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

create or replace function suspicious_similar_transcripts(min_sim real default 0.55)
returns table (call_id_a text, call_id_b text, similarity real, same_caller boolean, vertical text, computed_at timestamptz,
  a_caller text, a_called_from text, a_publisher text, a_vertical text, a_created_at timestamptz, a_duration int,
  a_recording_url text, a_ascnd_recording_url text, a_outcome text, a_ivr_name text,
  b_caller text, b_called_from text, b_publisher text, b_vertical text, b_created_at timestamptz, b_duration int,
  b_recording_url text, b_ascnd_recording_url text, b_outcome text, b_ivr_name text)
language sql stable set search_path = public, pg_temp as $$
  select m.call_id_a, m.call_id_b, m.similarity, m.same_caller, m.vertical, m.computed_at,
    suspicious_caller_key(a.called_from), a.called_from, a.publisher_name, a.vertical_name, a.created_at, a.duration,
    a.recording_url, a.ascnd_recording_url, a.our_outcome, a.ivr_name,
    suspicious_caller_key(b.called_from), b.called_from, b.publisher_name, b.vertical_name, b.created_at, b.duration,
    b.recording_url, b.ascnd_recording_url, b.our_outcome, b.ivr_name
  from script_matches m
  join canoe_calls a on a.id = m.call_id_a
  join canoe_calls b on b.id = m.call_id_b
  where m.similarity >= min_sim
  order by m.similarity desc, a.created_at desc
  limit 1000
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'suspicious_repeat_callers(timestamptz, timestamptz, int, boolean, int)',
    'suspicious_conversions(timestamptz, timestamptz, int, int)',
    'suspicious_similar_transcripts(real)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

create or replace procedure refresh_dashboard_nightly()
language plpgsql as $$
begin
  perform public.refresh_dashboard_daily(45);
  commit;
  begin
    perform public.refresh_script_matches();
  exception when others then
    raise warning 'refresh_script_matches failed (dashboard rollup kept): %', sqlerrm;
  end;
end;
$$;
revoke execute on procedure refresh_dashboard_nightly() from public, anon, authenticated;
select cron.schedule('refresh-dashboard-rollup', '45 7 * * *', $$call public.refresh_dashboard_nightly()$$);
