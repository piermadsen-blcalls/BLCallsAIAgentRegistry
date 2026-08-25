-- ============================================================
-- 041_scoring_vectors_rollup.sql
-- The Scores tab called outcome_score_vectors() (migration 017) on every load, which
-- scanned canoe_calls — a very wide table (full transcripts per row) — for the
-- "comparable set" (calls with BOTH canoe_outcome and our_outcome set) across a 90-day
-- window and grouped at read time. The partial index from 018 was keyed on created_at
-- but did NOT include the projected columns, so Postgres still did a heap fetch per
-- matching row on the wide table — seconds-level, and worse under write load (stale
-- visibility map). Same problem the Agents tab had; same fix (see 030): a pre-aggregated
-- per-(entity,vertical,source,outcome)-per-day rollup the RPC sums instead of scanning raw.
--
-- The rollup key mirrors the RPC's grouping. It covers BOTH entity types (publisher /
-- advertiser) and BOTH sources (canoe / ours) so a single table serves every view.
-- Run in Supabase SQL Editor (or supabase db push).
-- ============================================================

create table if not exists outcome_score_daily (
  entity_type text   not null,   -- 'publisher' | 'advertiser'
  entity_name text   not null,
  vertical    text   not null,
  source      text   not null,   -- 'canoe' | 'ours'
  outcome     text   not null,
  day         date   not null,
  n           bigint not null default 0,
  primary key (entity_type, entity_name, vertical, source, outcome, day)
);
-- The RPC filters by entity_type + day range, then groups; this serves that access path.
create index if not exists outcome_score_daily_type_day_idx
  on outcome_score_daily (entity_type, day);

alter table outcome_score_daily enable row level security;
create policy "auth users can read outcome_score_daily"
  on outcome_score_daily for select to authenticated using (true);

-- Recompute the rollup for a trailing window (default 120 days — comfortably covers the
-- Master 90d view plus a margin for AI-processing/backfill patching recent outcomes).
-- Days older than the window are frozen; a backfill reaching calls older than the window
-- won't be reflected until a full repopulate (see the one-time call below).
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
grant execute on function refresh_outcome_score_daily(int) to service_role;

-- Full-history populate (idempotent: the function deletes + reinserts its window).
select refresh_outcome_score_daily(4000);

-- Cutover: outcome_score_vectors now sums the rollup instead of scanning raw calls.
-- Same signature + return shape as 017, so the Scores tab needs no change. Day-grained
-- (matches the daily refresh cadence); window boundaries may shift by the UTC-vs-local
-- offset, negligible for the 90d / selected-range totals the tab shows.
create or replace function outcome_score_vectors(
  from_ts     timestamptz,
  to_ts       timestamptz,
  entity_type text default 'publisher'
)
returns table (
  entity_name text,
  vertical    text,
  source      text,
  outcome     text,
  n           bigint
)
language sql security definer stable as $$
  select d.entity_name, d.vertical, d.source, d.outcome, coalesce(sum(d.n), 0)::bigint
  from outcome_score_daily d
  where d.entity_type = outcome_score_vectors.entity_type
    and d.day >= (from_ts at time zone 'UTC')::date
    and d.day <  (to_ts   at time zone 'UTC')::date
  group by d.entity_name, d.vertical, d.source, d.outcome;
$$;
grant execute on function outcome_score_vectors(timestamptz, timestamptz, text) to authenticated;

-- Keep the rollup fresh daily at 01:30 UTC (after the 00:00 sync and 01:00 agent rollup)
-- via pg_cron. cron.schedule upserts by job name, so re-running is safe.
create extension if not exists pg_cron;
select cron.schedule('refresh-outcome-score-rollup', '30 1 * * *', $$select public.refresh_outcome_score_daily(120)$$);
