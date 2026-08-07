-- ============================================================
-- 017_scoring_vectors.sql
-- Backing data for the Publisher/Advertiser Scores view.
--
-- Scores are (publisher|advertiser) x vertical, computed two ways
-- from the SAME calls: Canoe (canoe_outcome) and Ours (our_outcome).
-- We return raw outcome-count vectors over the "comparable set"
-- (calls that have BOTH outcomes) and let the client apply weights
-- from outcome_weights (read-time; no per-call score stamping).
--
-- Call once per window: master = now()-90d .. now(); windowed = the
-- dashboard's selected range.
--
-- Run in Supabase SQL Editor.
-- ============================================================

-- Canoe still emits the pre-v3 label `wrong_category` (v3 split it into
-- publisher_wrong_category / advertiser_service_mismatch). Give it the
-- publisher_wrong_category weight so the Canoe-side score isn't full of
-- holes until Canoe adopts v3. Ours never emits it, so this is inert on
-- the Ours side.
insert into outcome_weights (outcome, pub_score, adv_score)
values ('wrong_category', -3, 0)
on conflict (outcome) do nothing;

-- Per (entity, vertical) outcome-count vectors over the comparable set.
-- entity_type: 'publisher' (default) groups by publisher_name; 'advertiser'
-- groups by advertiser_name. `source` is 'canoe' or 'ours'.
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
  with base as (
    select
      case when entity_type = 'advertiser' then advertiser_name
           else publisher_name end                as entity_name,
      coalesce(nullif(vertical_name, ''), '(unknown)') as vertical,
      canoe_outcome,
      our_outcome
    from canoe_calls
    where is_test is not true
      and canoe_outcome is not null
      and our_outcome   is not null
      and created_at >= from_ts
      and created_at <  to_ts
      and case when entity_type = 'advertiser' then advertiser_name
               else publisher_name end is not null
      and case when entity_type = 'advertiser' then advertiser_name
               else publisher_name end <> ''
  )
  select entity_name, vertical, 'canoe'::text as source, canoe_outcome as outcome, count(*)::bigint as n
    from base group by entity_name, vertical, canoe_outcome
  union all
  select entity_name, vertical, 'ours'::text as source, our_outcome as outcome, count(*)::bigint as n
    from base group by entity_name, vertical, our_outcome;
$$;

grant execute on function outcome_score_vectors(timestamptz, timestamptz, text) to authenticated;
