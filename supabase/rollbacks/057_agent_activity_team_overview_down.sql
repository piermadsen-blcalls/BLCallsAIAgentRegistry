-- Rollback for 057_agent_activity_team_overview.sql. Drops the two read-only RPCs; no data
-- changes. Revert the index.html change first or with it: without the RPCs the Agents tab falls
-- back to its old window-based "Inactive" badge and Settings > Team shows a load error.

drop function if exists team_overview(timestamptz);
drop function if exists agent_last_call_days();
