-- ============================================================
-- 046_prompt_v4_coached_call.sql
-- MK-186: new compliance flag `coached_call`. Inserts prompt v4 = the active v3 prompt
-- ("v3 — Taxonomy (pub/adv split)") with ONE change: a coached_call definition added to
-- the compliance FLAG DEFINITIONS. The outcome prompt is copied unchanged.
--
-- Inserted INACTIVE. It is test-run on a fixed sample first (process.yml, test_mode=true,
-- prompt_id=<this row>) and only activated after review:
--   update ai_prompts set is_active = (name = 'v4 — coached_call flag (MK-186)');
-- scripts/process.js VALID_FLAGS must include 'coached_call' or the flag is dropped.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

insert into ai_prompts (name, description, outcome_prompt, compliance_prompt, is_active, created_by)
select
  'v4 — coached_call flag (MK-186)',
  'v3 + coached_call compliance flag (coached / incentivized callers).',
  outcome_prompt,
  replace(
    compliance_prompt,
    'externally — do not flag from transcript alone).',
    'externally — do not flag from transcript alone).
  - coached_call: The caller appears coached or incentivized to make
  this call rather than calling with a genuine need. Flag only on a
  concrete sign, e.g. they say a third party told them what to say or
  to call ("they told me to say this", "the guy said to call and say
  ..."), they recite answers or ask what they are supposed to say, or
  they cannot give basic details about themselves or their situation
  (their own address, the property, the specific problem) and stay
  vague when asked for specifics. Do NOT flag a genuine referral ("my
  neighbor recommended you"), a caller who is just brief or nervous,
  or one who only lacks a technical detail.'
  ),
  false,
  'MK-186'
from ai_prompts
where name = 'v3 — Taxonomy (pub/adv split)'
  and not exists (select 1 from ai_prompts where name = 'v4 — coached_call flag (MK-186)');
