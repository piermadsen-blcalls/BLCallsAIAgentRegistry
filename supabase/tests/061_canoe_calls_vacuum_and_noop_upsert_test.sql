-- ============================================================
-- Regression test for 061_canoe_calls_vacuum_and_noop_upsert.sql.
-- Run in the Supabase SQL Editor after 061. Everything runs in one transaction that is rolled
-- back, so it leaves no rows behind; raises on failure. Fixture ids start with 'zztest-'.
-- ============================================================
begin;

do $$
declare
  n int;
  t1 tid; t2 tid;
  s1 timestamptz;
  row1 jsonb := '{"id":"zztest-u1","publisher_name":"ZZTEST Pub","ivr_name":"ZZTEST IVR",
                  "ivr_duration":"42","advertiser_payin":10,"is_test":false,
                  "created_at":"2026-11-10T10:00:00Z","synced_at":"2026-11-11T03:00:00Z"}';
begin
  -- Table settings and dropped indexes.
  assert (select reloptions from pg_class where oid = 'public.canoe_calls'::regclass)
    @> array['autovacuum_vacuum_scale_factor=0.02', 'autovacuum_vacuum_insert_scale_factor=0.02',
             'autovacuum_analyze_scale_factor=0.02', 'fillfactor=90'], 'canoe_calls reloptions';
  assert not exists (select 1 from pg_indexes where schemaname = 'public' and indexname in (
    'canoe_calls_vertical_id_idx', 'canoe_calls_ai_processed_idx', 'canoe_calls_publisher_id_idx',
    'canoe_calls_advertiser_id_idx', 'canoe_calls_result_idx')), 'dead indexes still present';
  assert not has_function_privilege('anon', 'public.upsert_canoe_calls(jsonb)', 'execute'), 'anon can execute';
  assert not has_function_privilege('authenticated', 'public.upsert_canoe_calls(jsonb)', 'execute'), 'authenticated can execute';

  -- 1) New row: inserted, string numbers coerce like PostgREST, unlisted columns get defaults.
  n := public.upsert_canoe_calls(jsonb_build_array(row1));
  assert n = 1, 'insert count';
  assert (select ivr_duration from public.canoe_calls where id = 'zztest-u1') = 42, 'ivr_duration coerced';
  assert (select flags from public.canoe_calls where id = 'zztest-u1') = '[]'::jsonb, 'flags default lost';
  assert (select compliance_reviewed from public.canoe_calls where id = 'zztest-u1') = false, 'compliance_reviewed default lost';
  select synced_at into s1 from public.canoe_calls where id = 'zztest-u1';

  -- Pass 2 fills a column the upsert does not list; it must survive later upserts.
  update public.canoe_calls set transcription = 'ZZTEST transcript' where id = 'zztest-u1';
  select ctid into t1 from public.canoe_calls where id = 'zztest-u1';

  -- 2) Same Canoe fields, new synced_at (a re-sync): no write at all.
  n := public.upsert_canoe_calls(jsonb_build_array(row1 || '{"synced_at":"2026-11-12T03:00:00Z","advertiser_payin":"10.00"}'));
  assert n = 0, 'unchanged row was rewritten';
  select ctid into t2 from public.canoe_calls where id = 'zztest-u1';
  assert t1 = t2, 'unchanged row got a new tuple version';
  assert (select synced_at from public.canoe_calls where id = 'zztest-u1') = s1, 'synced_at moved on a no-op';

  -- 3) A Canoe field changed: row updated, synced_at advances, other columns kept.
  n := public.upsert_canoe_calls(jsonb_build_array(row1 || '{"synced_at":"2026-11-12T03:00:00Z","advertiser_payin":25}'));
  assert n = 1, 'changed row was skipped';
  assert (select advertiser_payin from public.canoe_calls where id = 'zztest-u1') = 25, 'payin not updated';
  assert (select synced_at from public.canoe_calls where id = 'zztest-u1') = '2026-11-12T03:00:00Z', 'synced_at not advanced';
  assert (select transcription from public.canoe_calls where id = 'zztest-u1') = 'ZZTEST transcript', 'transcription lost';

  -- 4) A field going to null counts as a change (IS DISTINCT FROM, not <>).
  n := public.upsert_canoe_calls(jsonb_build_array((row1 - 'publisher_name') || '{"advertiser_payin":25}'));
  assert n = 1, 'null change was skipped';
  assert (select publisher_name from public.canoe_calls where id = 'zztest-u1') is null, 'publisher_name not nulled';

  raise notice '061 test passed';
end $$;

rollback;
