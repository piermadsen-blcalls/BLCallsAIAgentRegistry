-- ============================================================
-- 008_alert_log.sql
-- Tracks sent compliance alerts so we don't duplicate within a period.
-- Run in Supabase SQL Editor.
-- ============================================================

create table if not exists alert_log (
  id            uuid primary key default gen_random_uuid(),
  manager_id    uuid not null,
  manager_email text not null,
  period_start  date not null,
  period_end    date not null,
  total_calls   integer,
  flagged_count integer,
  dry_run       boolean default false,
  sent_at       timestamptz default now()
);

-- Unique constraint: one alert per manager per period (prevents re-send on re-run)
create unique index if not exists alert_log_manager_period_idx
  on alert_log (manager_id, period_start)
  where dry_run = false;

create index if not exists alert_log_sent_at_idx on alert_log (sent_at desc);

alter table alert_log enable row level security;

create policy "auth users can read alert_log"
  on alert_log for select to authenticated using (true);

create policy "service role can insert alert_log"
  on alert_log for insert to service_role with check (true);
