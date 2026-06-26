-- ============================================================
-- 005_outcome_weights.sql
-- Configurable pub/adv scoring weights per outcome.
-- Run in Supabase SQL Editor.
-- ============================================================

create table outcome_weights (
  outcome    text    primary key,
  pub_score  integer not null default 0,
  adv_score  integer not null default 0
);

alter table outcome_weights enable row level security;

create policy "auth users can read outcome_weights"
  on outcome_weights for select to authenticated using (true);

create policy "auth users can insert outcome_weights"
  on outcome_weights for insert to authenticated with check (true);

create policy "auth users can update outcome_weights"
  on outcome_weights for update to authenticated using (true) with check (true);

-- Seed: Taxonomy v3 scores
insert into outcome_weights (outcome, pub_score, adv_score) values
  ('sale',                        10,   10),
  ('appointment',                 10,   10),
  ('quoted_interested',            3,    3),
  ('quoted_undecided',             2,    2),
  ('quoted_too_expensive',         0,    0),
  ('quoted_not_interested',        0,    0),
  ('quoted_abandoned',            -1,    0),
  ('not_interested',               0,    0),
  ('undecided',                    0,    0),
  ('caller_callback',              0,    0),
  ('caller_hangup',                0,    0),
  ('audio_issue',                  0,    0),
  ('referral',                     0,    0),
  ('ivr_hangup',                   0,    0),
  ('publisher_wrong_category',    -3,    0),
  ('misrouted',                   -3,    0),
  ('caller_confused',             -3,    0),
  ('customer_service',            -2,    0),
  ('soliciting',                  -5,    0),
  ('advertiser_service_mismatch',  0,   -3),
  ('outside_geo',                  0,   -3),
  ('agent_not_available',          0,   -3),
  ('voicemail',                    0,   -3),
  ('outside_hours',                0,   -3),
  ('agent_callback',               0,   -2),
  ('agent_confused',              -3,   -2),
  ('other',                        0,    0),
  ('test',                         0,    0);

-- RPC: bulk recalculate publisher_score + advertiser_score for all processed calls
-- Returns number of rows updated
create or replace function recalculate_call_scores()
returns integer language plpgsql security definer as $$
declare
  updated_count integer;
begin
  update canoe_calls
  set publisher_score  = w.pub_score,
      advertiser_score = w.adv_score
  from outcome_weights w
  where canoe_calls.our_outcome = w.outcome
    and canoe_calls.our_outcome is not null;

  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;
