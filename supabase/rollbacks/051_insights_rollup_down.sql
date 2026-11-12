-- ============================================================
-- Rollback for 051_insights_rollup.sql. Removes the cron job, both functions and the rollup
-- table. The Insights page falls back to fetching raw calls per day when insights_period is
-- missing, so it keeps working (with the old timeout risk on long periods).
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

select cron.unschedule('refresh-insights-rollup')
where exists (select 1 from cron.job where jobname = 'refresh-insights-rollup');
drop function if exists insights_period(date, date, text[]);
drop function if exists refresh_insights_daily(int);
drop table if exists insights_daily;
