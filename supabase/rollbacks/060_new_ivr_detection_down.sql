-- ============================================================
-- Rollback for 060_new_ivr_detection.sql. Restores 050's 00:45 UTC rename heal job and removes
-- the new-IVR check, its detection log and the two agents columns. Agents it registered stay
-- registered (their calls keep counting) and move from needs_setup to live, the status the page
-- already understands. Deploy the scripts/ + index.html revert with it: sync.js only warns if
-- check_new_ivrs is missing, and alert.js ALERT_MODE=new_ivrs needs new_ivr_detections.
-- Run in Supabase SQL Editor (or supabase db query --linked -f).
-- ============================================================

select cron.unschedule('check-new-ivrs')
where exists (select 1 from cron.job where jobname = 'check-new-ivrs');
select cron.schedule('heal-renamed-ivr-aliases', '45 0 * * *', $$select public.heal_renamed_ivr_aliases(7)$$);

drop function if exists check_new_ivrs(int);
drop table if exists new_ivr_detections;

update agents set status = 'live' where status = 'needs_setup';
alter table agents drop column if exists first_seen_at;
alter table agents drop column if exists seen_calls;
