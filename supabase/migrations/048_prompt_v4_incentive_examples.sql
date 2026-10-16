-- ============================================================
-- 048_prompt_v4_incentive_examples.sql
-- MK-186 follow-up (Pier + Vicky, 2026-10-16): coached_call should also catch callers who
-- mention being paid / promised a reward for calling or getting a quote (Lydia's example:
-- "I was told I'd get an Amazon card"). Updates the still-INACTIVE v4 prompt from 046.
-- Idempotent (no-op once the text is present).
-- ============================================================

update ai_prompts
set compliance_prompt = replace(
  compliance_prompt,
  '..."), they recite answers',
  '..."), they mention being paid or promised a reward for calling or
  for getting a quote ("I was told I''d get an Amazon card", "they''re
  giving me a gift card"), they recite answers'
)
where name = 'v4 — coached_call flag (MK-186)'
  and position('Amazon card' in compliance_prompt) = 0;
