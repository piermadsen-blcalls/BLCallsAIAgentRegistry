-- Rollback for 061_canoe_calls_vacuum_and_noop_upsert.sql. Restores default autovacuum and
-- fillfactor, recreates the 5 dropped indexes exactly as they were, and removes
-- upsert_canoe_calls. Deploy the scripts/ revert first or with it: the 061 sync.js falls back to
-- the plain upsert when the function is missing, so either order works.
-- The index builds take a few seconds each on ~530k rows. To avoid blocking writes, run them
-- one at a time outside a transaction with CREATE INDEX CONCURRENTLY instead.

alter table public.canoe_calls reset (
  autovacuum_vacuum_scale_factor,
  autovacuum_vacuum_insert_scale_factor,
  autovacuum_analyze_scale_factor,
  fillfactor
);

create index if not exists canoe_calls_vertical_id_idx   on public.canoe_calls using btree (vertical_id);
create index if not exists canoe_calls_ai_processed_idx  on public.canoe_calls using btree (ai_processed_at) where (ai_processed_at is null);
create index if not exists canoe_calls_publisher_id_idx  on public.canoe_calls using btree (publisher_id);
create index if not exists canoe_calls_advertiser_id_idx on public.canoe_calls using btree (advertiser_id);
create index if not exists canoe_calls_result_idx        on public.canoe_calls using btree (result);

drop function if exists public.upsert_canoe_calls(jsonb);
