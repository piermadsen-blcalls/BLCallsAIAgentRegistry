-- ============================================================
-- Regression test for 058_ascnd_pairing_lag_window.sql.
-- Run in the Supabase SQL Editor after 058. Everything runs in one transaction that is
-- rolled back, so it leaves no rows behind; raises on failure. Fixtures sit on 2020-01-06
-- (no real calls that early), ids start with 'zztest-', phones are 555-01xx numbers.
-- ============================================================
begin;

-- 1) Rank: exact and 1h-off unchanged from 049; ASCND may lag Canoe by up to 120s.
do $$ begin
  assert ascnd_pair_rank(0)     = 0,    'exact match';
  assert ascnd_pair_rank(-7)    = 7,    'edge of 7s window';
  assert ascnd_pair_rank(3599)  = 101,  'hl 1h behind (post-DST skew)';
  assert ascnd_pair_rank(-3600) = 100,  'hl 1h ahead';
  assert ascnd_pair_rank(-30)   = 230,  'ASCND 30s behind Canoe';
  assert ascnd_pair_rank(-120)  = 320,  'edge of the lag window';
  assert ascnd_pair_rank(-121)  is null, 'past the lag window';
  assert ascnd_pair_rank(8)     is null, 'ASCND ahead of Canoe by 8s is not a pair';
  assert ascnd_pair_rank(30)    is null, 'ASCND ahead of Canoe by 30s is not a pair';
  assert ascnd_pair_rank(3560)  = 340,  '1h skew plus 40s lag';
  assert ascnd_pair_rank(3608)  is null, 'outside 1h+7s, wrong side for lag';
  assert ascnd_pair_rank(1800)  is null, 'half an hour is never a pair';
  assert ascnd_pair_rank(5) < ascnd_pair_rank(-3600) and ascnd_pair_rank(-3600) < ascnd_pair_rank(-8),
    'exact beats 1h-off beats lagged';
end $$;

-- 2) Pairing. T0 = 2020-01-06 12:00 UTC.
insert into canoe_calls (id, ivr_name, called_from, created_at, disposition, ascnd_transcript) values
  ('zztest-p-lag',      'ASCND ZZTEST agent', '+15550100001', '2020-01-06 12:00:00+00', null,      null),
  ('zztest-p-exact',    'ASCND ZZTEST agent', '+15550100002', '2020-01-06 12:00:00+00', 'D-OLD',   'ZZTEST old'),
  ('zztest-p-rep1',     'ASCND ZZTEST agent', '+15550100003', '2020-01-06 12:00:00+00', null,      null),
  ('zztest-p-rep2',     'ASCND ZZTEST agent', '+15550100003', '2020-01-06 12:00:10+00', null,      null),
  ('zztest-p-early',    'ASCND ZZTEST agent', '+15550100004', '2020-01-06 12:00:00+00', null,      null),
  ('zztest-p-fill',     'ASCND ZZTEST agent', '+15550100005', '2020-01-06 12:00:00+00', null,      'ZZTEST kept'),
  ('zztest-p-skew',     'ASCND ZZTEST agent', '+15550100006', '2020-01-06 12:00:00+00', null,      null),
  ('zztest-p-notx',     'ASCND ZZTEST agent', '+15550100007', '2020-01-06 12:00:00+00', 'D-EMPTY', null),
  ('zztest-p-edge-in',  'ASCND ZZTEST agent', '+15550100008', '2020-01-07 11:59:55+00', null,      null),
  ('zztest-p-edge-out', 'ASCND ZZTEST agent', '+15550100008', '2020-01-07 12:00:20+00', null,      null),
  ('zztest-p-notascnd', 'ZZTEST other IVR',   '+15550100009', '2020-01-06 12:00:00+00', null,      null);

insert into hl_call_data (phone, call_timestamp, disposition, transcript) values
  ('+15550100001', '2020-01-06 12:00:30+00', 'D-LAG',   'ZZTEST lag'),      -- 30s behind
  ('+15550100002', '2020-01-06 12:00:02+00', 'D-NEW',   'ZZTEST new'),      -- already paired: untouched
  ('+15550100003', '2020-01-06 12:00:12+00', 'D-REP',   'ZZTEST rep'),      -- 2s after rep2, 12s after rep1
  ('+15550100004', '2020-01-06 11:59:30+00', 'D-EARLY', 'ZZTEST early'),    -- 30s ahead: not a pair
  ('+15550100005', '2020-01-06 12:00:01+00', 'D-FILL',  null),              -- empty transcript
  ('+15550100006', '2020-01-06 11:00:40+00', 'D-SKEW',  'ZZTEST skew'),     -- 1h early + 40s lag
  ('+15550100007', '2020-01-06 12:00:25+00', 'D-TX',    'ZZTEST notx'),     -- 25s behind
  ('+15550100008', '2020-01-07 12:00:22+00', 'D-EDGE',  'ZZTEST edge'),     -- 2s after edge-out
  ('+15550100009', '2020-01-06 12:00:01+00', 'D-OTHER', 'ZZTEST other');    -- not an ASCND call

do $$
declare n int;
begin
  -- window ends at 2020-01-07 12:00: edge-out only competes, it is not updated
  n := sync_hl_to_canoe_calls('2020-01-06 11:00:00+00', '2020-01-07 12:00:00+00');
  assert n = 5, format('expected 5 calls updated (lag, rep2, fill, skew, notx), got %s', n);

  assert (select ascnd_transcript from canoe_calls where id = 'zztest-p-lag') = 'ZZTEST lag', 'lagged ASCND row pairs';
  assert (select disposition      from canoe_calls where id = 'zztest-p-lag') = 'D-LAG', 'lagged pair carries the disposition';
  assert (select (disposition, ascnd_transcript) = ('D-OLD', 'ZZTEST old') from canoe_calls where id = 'zztest-p-exact'),
    'a call that already has disposition + transcript is left alone';
  assert (select ascnd_transcript from canoe_calls where id = 'zztest-p-rep2') = 'ZZTEST rep', 'the closer repeat call gets the row';
  assert (select ascnd_transcript is null and disposition is null from canoe_calls where id = 'zztest-p-rep1'),
    'one hl row pairs one call only';
  assert (select ascnd_transcript is null from canoe_calls where id = 'zztest-p-early'), 'ASCND 30s ahead is not paired';
  assert (select (disposition, ascnd_transcript) = ('D-FILL', 'ZZTEST kept') from canoe_calls where id = 'zztest-p-fill'),
    'fills missing fields but never nulls a stored transcript';
  assert (select ascnd_transcript from canoe_calls where id = 'zztest-p-skew') = 'ZZTEST skew', '1h skew + lag pairs';
  assert (select ascnd_transcript from canoe_calls where id = 'zztest-p-notx') = 'ZZTEST notx',
    'a call with a disposition but no transcript is re-paired';
  assert (select ascnd_transcript is null from canoe_calls where id = 'zztest-p-edge-in'),
    'an hl row past the window edge stays with its closer call';
  assert (select ascnd_transcript is null from canoe_calls where id = 'zztest-p-edge-out'), 'calls outside the window are not updated';
  assert (select ascnd_transcript is null from canoe_calls where id = 'zztest-p-notascnd'), 'non-ASCND calls are never paired';

  n := sync_hl_to_canoe_calls('2020-01-06 11:00:00+00', '2020-01-07 12:00:00+00');
  assert n = 0, format('a second run changes nothing, got %s', n);

  n := sync_hl_to_canoe_calls('2020-01-07 12:00:00+00', '2020-01-08 00:00:00+00');
  assert n = 1 and (select ascnd_transcript from canoe_calls where id = 'zztest-p-edge-out') = 'ZZTEST edge',
    'the next chunk pairs the edge call';
end $$;

-- 3) Grants unchanged from 049; the backfill record is service-role only.
do $$ begin
  assert has_function_privilege('anon', 'sync_hl_to_canoe_calls(timestamptz, timestamptz)', 'execute'), 'anon keeps execute (Review button)';
  assert has_function_privilege('authenticated', 'sync_hl_to_canoe_calls(timestamptz, timestamptz)', 'execute'), 'authenticated keeps execute';
  assert has_function_privilege('service_role', 'sync_hl_to_canoe_calls(timestamptz, timestamptz)', 'execute'), 'service_role keeps execute';
  assert to_regclass('public.ascnd_pairing_backfill_058') is not null, 'backfill record exists';
  assert not has_table_privilege('anon', 'ascnd_pairing_backfill_058', 'select,insert,update,delete,truncate'), 'backfill record closed to anon';
  assert not has_table_privilege('authenticated', 'ascnd_pairing_backfill_058', 'select,insert,update,delete,truncate'), 'backfill record closed to authenticated';
end $$;

rollback;
