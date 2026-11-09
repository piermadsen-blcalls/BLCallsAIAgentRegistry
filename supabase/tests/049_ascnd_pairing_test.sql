-- ============================================================
-- Regression test for 049_ascnd_pairing_dst_tolerant.sql (read-only).
-- Reproduces the 2026-11-03 outage: the ASCND webhook's call_timestamp ran
-- one hour behind canoe_calls.created_at, and the old +/-7s rule paired 0
-- calls. Run in the Supabase SQL Editor after 049; raises on failure,
-- writes nothing.
-- ============================================================
do $$
declare
  pick numeric;
begin
  -- exact-time pairs (sender correct): rank = seconds apart
  assert ascnd_pair_rank(0)    = 0,   'exact match';
  assert ascnd_pair_rank(-7)   = 7,   'edge of 7s window';
  assert ascnd_pair_rank(8)    is null, 'outside 7s window';

  -- the outage: hl one hour behind canoe (observed gap ~3599s) must pair
  assert ascnd_pair_rank(3599) = 101, 'hl 1h behind (post-DST skew)';
  assert ascnd_pair_rank(-3600) = 100, 'hl 1h ahead (opposite DST flip)';
  assert ascnd_pair_rank(3608) is null, 'outside 1h+7s window';
  assert ascnd_pair_rank(1800) is null, 'half an hour is never a pair';

  -- an exact-time candidate beats a 1h-off one, even a "tighter" 1h-off one
  select gap into pick from (values (5::numeric), (3600::numeric)) v(gap)
  where ascnd_pair_rank(gap) is not null order by ascnd_pair_rank(gap) limit 1;
  assert pick = 5, 'prefer exact-time candidate over 1h-off';
end $$;
