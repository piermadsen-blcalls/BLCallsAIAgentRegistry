-- ============================================================
-- Rollback for 062_agent_targets_from_calls.sql. Drops the derived lists, their refresh and
-- schedule, and gives the hand-entered lists back their old column names. Deploy the
-- scripts/ + index.html revert with it: sync.js only warns if refresh_agent_targets is missing,
-- and the page shows "None" for both lists while agent_targets is gone.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

select cron.unschedule('refresh-agent-targets')
where exists (select 1 from cron.job where jobname = 'refresh-agent-targets');

drop function if exists refresh_agent_targets(int);
drop table if exists agent_targets;

comment on column agents.publisher_campaigns_manual is null;
comment on column agents.ivr_targets_manual         is null;
alter table agents rename column publisher_campaigns_manual to publisher_campaigns;
alter table agents rename column ivr_targets_manual         to ivr_targets;
