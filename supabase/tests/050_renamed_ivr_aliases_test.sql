-- ============================================================
-- Regression test for 050_renamed_ivr_aliases.sql.
-- Run in the Supabase SQL Editor after 050. Everything runs inside one
-- transaction that is ROLLED BACK at the end, so it leaves no rows behind;
-- raises on failure. Fixture names start with 'ASCND ZZTEST' so they can't
-- collide with real IVRs.
-- ============================================================
begin;

-- Every alias must point at a real agent (the frontend resolves one hop only).
do $$ begin
  assert not exists (
    select 1 from agent_ivr_aliases al
    left join agents a on a.ivr_name = al.canonical_ivr_name
    where a.ivr_name is null
  ), 'alias whose canonical is not an agents row';
  assert exists (select 1 from agent_ivr_aliases
                 where ivr_name = 'ASCND AI Agent - Multi-Category (GLS)_13853556134 - Outgoing'
                   and canonical_ivr_name = 'ASCND AI Agent - Outgoing - Multi-Category (GLS)'),
    'GLS rename maps to the existing GLS agent';
end $$;

-- Fixtures: the shape of the Oct 7 rename.
insert into agents (ivr_name, name) values
  ('ASCND ZZTEST Agent - Alpha - Outgoing', 'ZZ Alpha'),
  ('ASCND ZZTEST Agent - Beta - Outgoing',  'ZZ Beta'),
  ('ASCND ZZTEST Agent - C1 - Outgoing',    'ZZ C1'),
  ('ASCND ZZTEST Agent - C2 - Outgoing',    'ZZ C2');
insert into agent_ivr_aliases (ivr_name, canonical_ivr_name) values
  ('ASCND ZZTEST agent - beta variant - Outgoing', 'ASCND ZZTEST Agent - Beta - Outgoing');
insert into canoe_calls (id, ivr_name, ivr_id, created_at) values
  -- Alpha: old name, then renamed with a DID suffix, same ivr_id
  ('zztest-1', 'ASCND ZZTEST Agent - Alpha - Outgoing',             'ZZTEST-ID-A', now() - interval '2 days'),
  ('zztest-2', 'ASCND ZZTEST Agent - Alpha_15550000001 - Outgoing', 'ZZTEST-ID-A', now() - interval '1 day'),
  -- Beta: id learned through an alias; the rename must map to the canonical
  ('zztest-3', 'ASCND ZZTEST agent - beta variant - Outgoing',      'ZZTEST-ID-B', now() - interval '2 days'),
  ('zztest-4', 'ASCND ZZTEST Agent - Beta_15550000002 - Outgoing',  'ZZTEST-ID-B', now() - interval '1 day'),
  -- one ivr_id under two different agents: ambiguous, never healed
  ('zztest-5', 'ASCND ZZTEST Agent - C1 - Outgoing',                'ZZTEST-ID-C', now() - interval '2 days'),
  ('zztest-6', 'ASCND ZZTEST Agent - C2 - Outgoing',                'ZZTEST-ID-C', now() - interval '2 days'),
  ('zztest-7', 'ASCND ZZTEST Agent - C_15550000003 - Outgoing',     'ZZTEST-ID-C', now() - interval '1 day'),
  -- brand-new IVR (unknown ivr_id): left for a human to register
  ('zztest-8', 'ASCND ZZTEST Agent - New_15550000004 - Outgoing',   'ZZTEST-ID-NEW', now() - interval '1 day'),
  -- non-AI Canoe IVR sharing a known id: not ASCND, never aliased
  ('zztest-9', 'ZZTEST Skip IVR',                                   'ZZTEST-ID-A', now() - interval '1 day'),
  -- outside the window: not seen
  ('zztest-10', 'ASCND ZZTEST Agent - Alpha_15550000009 - Outgoing', 'ZZTEST-ID-A', now() - interval '30 days');

select heal_renamed_ivr_aliases(3);

do $$
declare second_run int;
begin
  assert (select canonical_ivr_name from agent_ivr_aliases
          where ivr_name = 'ASCND ZZTEST Agent - Alpha_15550000001 - Outgoing')
         = 'ASCND ZZTEST Agent - Alpha - Outgoing', 'rename healed via ivr_id';
  assert (select canonical_ivr_name from agent_ivr_aliases
          where ivr_name = 'ASCND ZZTEST Agent - Beta_15550000002 - Outgoing')
         = 'ASCND ZZTEST Agent - Beta - Outgoing', 'heal points at the agent, not the alias';
  assert (select canonical_ivr_name from agent_canoe_ivr_ids where ivr_id = 'ZZTEST-ID-A')
         = 'ASCND ZZTEST Agent - Alpha - Outgoing', 'ivr_id learned';
  assert not exists (select 1 from agent_canoe_ivr_ids where ivr_id = 'ZZTEST-ID-C'), 'ambiguous id not learned';
  assert not exists (select 1 from agent_ivr_aliases where ivr_name = 'ASCND ZZTEST Agent - C_15550000003 - Outgoing'), 'ambiguous rename not healed';
  assert not exists (select 1 from agent_ivr_aliases where ivr_name = 'ASCND ZZTEST Agent - New_15550000004 - Outgoing'), 'new IVR not auto-registered';
  assert not exists (select 1 from agent_ivr_aliases where ivr_name = 'ZZTEST Skip IVR'), 'non-ASCND name never aliased';
  assert not exists (select 1 from agent_ivr_aliases where ivr_name = 'ASCND ZZTEST Agent - Alpha_15550000009 - Outgoing'), 'outside window';
  assert not exists (select 1 from agent_ivr_aliases where ivr_name = 'ASCND ZZTEST Agent - Alpha - Outgoing'), 'registered name not aliased';

  second_run := heal_renamed_ivr_aliases(3);
  assert second_run = 0, 'idempotent: second run adds nothing';
end $$;

rollback;
