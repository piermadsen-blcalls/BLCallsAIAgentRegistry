-- ============================================================
-- 007_model_test_usage.sql
-- Add token usage columns to model_test_results.
-- Run in Supabase SQL Editor.
-- ============================================================

alter table model_test_results
  add column if not exists input_tokens  integer,
  add column if not exists output_tokens integer;
