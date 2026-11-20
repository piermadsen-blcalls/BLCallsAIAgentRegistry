-- ============================================================
-- Rollback for 069_suspicious_callers.sql. Puts the 'refresh-dashboard-rollup' job back on
-- refresh_dashboard_daily(45) (as in 064), then drops the nightly procedure, the Suspicious tab's
-- functions, script_matches and coached_verdicts. Dropping coached_verdicts DELETES every verdict
-- the team recorded: export it first if they are wanted (they are MK-186's labeled set).
-- Revert the page's Suspicious tab with it.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

select cron.schedule('refresh-dashboard-rollup', '45 7 * * *', $$select public.refresh_dashboard_daily(45)$$);
drop procedure if exists refresh_dashboard_nightly();

drop function if exists suspicious_similar_transcripts(real);
drop function if exists refresh_script_matches(int, real, int, int);
drop function if exists suspicious_conversions(timestamptz, timestamptz, int, int);
drop function if exists suspicious_repeat_callers(timestamptz, timestamptz, int, boolean, int);
drop function if exists coached_verdict_clear(text);
drop function if exists coached_verdict_set(text, text, text, text);
drop table if exists script_matches;
drop table if exists coached_verdicts;
drop function if exists suspicious_caller_key(text);
