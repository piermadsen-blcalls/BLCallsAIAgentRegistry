-- ============================================================
-- 015_settings_page_indexes.sql
-- Fixes Settings-page statement timeouts (57014) caused by canoe_calls
-- growing to ~146k rows:
--   - get_distinct_accounts() GROUP-BYs publisher_name / advertiser_name
--   - promptsLoad scans for prompt_id IS NOT NULL (none exist yet)
-- Run in Supabase SQL Editor.
-- ============================================================

create index if not exists canoe_calls_publisher_name_idx on canoe_calls (publisher_name);
create index if not exists canoe_calls_advertiser_name_idx on canoe_calls (advertiser_name);
create index if not exists canoe_calls_prompt_id_idx       on canoe_calls (prompt_id) where prompt_id is not null;

-- Belt-and-suspenders: give the accounts aggregation headroom beyond the
-- default 8s statement timeout (the indexes above should make it sub-second).
alter function get_distinct_accounts() set statement_timeout = '20s';
