-- ============================================================
-- Regression test for 051_insights_rollup.sql.
-- Run in the Supabase SQL Editor after 051. Everything runs inside one
-- transaction that is ROLLED BACK at the end, so it leaves no rows behind;
-- raises on failure. Fixture names start with 'ZZTEST' and use their own
-- verticals, so the vertical filter isolates them from real calls.
-- ============================================================
begin;
set local timezone = 'UTC';   -- current_date below is the UTC day, as in 051

-- Fixtures: settled days (rolled up) and yesterday (not settled, read live).
insert into canoe_calls (id, created_at, is_test, ivr_name, publisher_name, advertiser_name, vertical_name,
                         connect_duration, result, advertiser_payin, publisher_payout) values
  -- sent by duration, paid
  ('zztest-i1', (current_date - 5)::timestamp at time zone 'UTC' + interval '10 hours', false,
   'ZZTEST Agent A', 'ZZTEST Pub', 'ZZTEST Adv', 'ZZTEST Vertical', 30, 'completed', 12.5, 4),
  -- last second of the day; sent by result text only, not paid
  ('zztest-i2', (current_date - 5)::timestamp at time zone 'UTC' + interval '86399 seconds', false,
   'ZZTEST Agent A', 'ZZTEST Pub', 'ZZTEST Adv', 'ZZTEST Vertical', 0, 'Connected - Transferred', 0, 1),
  -- null / empty names group as '(unknown)'; nothing sent or paid
  ('zztest-i3', (current_date - 4)::timestamp at time zone 'UTC', false,
   null, '', 'ZZTEST Adv', 'ZZTEST Vertical', null, 'no answer', null, null),
  -- test call: excluded everywhere
  ('zztest-i4', (current_date - 4)::timestamp at time zone 'UTC' + interval '12 hours', true,
   'ZZTEST Agent A', 'ZZTEST Pub', 'ZZTEST Adv', 'ZZTEST Vertical', 30, 'connected', 99, 9),
  -- yesterday: not in the rollup, insights_period reads it live
  ('zztest-i5', (current_date - 1)::timestamp at time zone 'UTC' + interval '8 hours', false,
   'ZZTEST Agent A', 'ZZTEST Pub', 'ZZTEST Adv', 'ZZTEST Vertical', 5, null, 20, 8),
  ('zztest-i6', (current_date - 1)::timestamp at time zone 'UTC' + interval '9 hours', false,
   'ZZTEST Agent B', 'ZZTEST Pub', 'ZZTEST Adv', 'ZZTEST Other', 5, null, 7, 1);

select refresh_insights_daily(7);

do $$
declare
  t date := (now() at time zone 'UTC')::date;
  a record; u record; b record;
  got record; want record;
begin
  assert (select sum(raw) from insights_daily where vertical = 'ZZTEST Vertical') = 3,
    'rollup holds the 3 settled non-test fixture calls';
  assert not exists (select 1 from insights_daily where day >= t - 1), 'no unsettled day in the rollup';

  -- Rollup (i1, i2) + live (i5) for one agent/publisher/advertiser.
  select * into a from jsonb_to_recordset(insights_period(t - 5, t, array['ZZTEST Vertical']))
    as x(ivr_name text, publisher_name text, advertiser_name text, raw bigint, sent bigint, paid bigint, revenue numeric, payout numeric)
    where ivr_name = 'ZZTEST Agent A';
  assert a.raw = 3 and a.sent = 3 and a.paid = 2 and a.revenue = 32.5 and a.payout = 13,
    format('Agent A totals: %s', row_to_json(a));
  select * into u from jsonb_to_recordset(insights_period(t - 5, t, array['ZZTEST Vertical']))
    as x(ivr_name text, publisher_name text, advertiser_name text, raw bigint, sent bigint, paid bigint, revenue numeric, payout numeric)
    where ivr_name = '(unknown)';
  assert u.publisher_name = '(unknown)' and u.raw = 1 and u.sent = 0 and u.paid = 0 and u.revenue = 0,
    format('unknown-name totals: %s', row_to_json(u));
  assert jsonb_array_length(insights_period(t - 5, t, array['ZZTEST Vertical'])) = 2, 'two groups in ZZTEST Vertical';

  -- End day inclusive; a one-day period is that whole UTC day.
  assert (select sum((e->>'raw')::bigint) from jsonb_array_elements(insights_period(t - 5, t - 5, array['ZZTEST Vertical'])) e) = 2,
    'one-day period counts both calls of that day';

  -- Vertical filter.
  select * into b from jsonb_to_recordset(insights_period(t - 5, t, array['ZZTEST Other']))
    as x(ivr_name text, raw bigint, revenue numeric);
  assert b.ivr_name = 'ZZTEST Agent B' and b.raw = 1 and b.revenue = 7, format('ZZTEST Other: %s', row_to_json(b));
  assert jsonb_array_length(insights_period(t - 5, t, array['ZZTEST Vertical', 'ZZTEST Other'])) = 3, 'two verticals at once';
  assert insights_period(t - 5, t, array['ZZTEST None']) = '[]'::jsonb, 'no match is an empty array';

  -- Real data: the RPC's totals equal the raw table over the window just refreshed.
  select sum((e->>'raw')::bigint) n, sum((e->>'sent')::bigint) s, sum((e->>'paid')::bigint) p,
         sum((e->>'revenue')::numeric) r, sum((e->>'payout')::numeric) o
    into got from jsonb_array_elements(insights_period(t - 7, t, null)) e;
  select count(*) n,
         count(*) filter (where coalesce(connect_duration,0) > 0 or position('connected' in lower(coalesce(result,''))) > 0) s,
         count(*) filter (where coalesce(advertiser_payin,0) > 0) p,
         coalesce(sum(advertiser_payin),0) r, coalesce(sum(publisher_payout),0) o
    into want from canoe_calls
    where is_test = false
      and created_at >= (t - 7)::timestamp at time zone 'UTC' and created_at < (t + 1)::timestamp at time zone 'UTC';
  assert got.n = want.n and got.s = want.s and got.p = want.p and got.r = want.r and got.o = want.o,
    format('rpc %s vs raw %s', row_to_json(got), row_to_json(want));
end $$;

-- Signed-in users can read a period but not rebuild the rollup.
set local role authenticated;
do $$ begin
  assert jsonb_array_length(insights_period(current_date - 5, current_date, array['ZZTEST Vertical'])) = 2,
    'authenticated can call insights_period';
  begin
    perform refresh_insights_daily(1);
    raise exception 'authenticated must not run refresh_insights_daily';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$ begin
  assert (select schedule from cron.job where jobname = 'refresh-insights-rollup') = '30 7 * * *', 'cron job scheduled';
end $$;

rollback;
