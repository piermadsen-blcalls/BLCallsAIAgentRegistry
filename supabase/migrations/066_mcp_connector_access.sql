-- ============================================================
-- 066_mcp_connector_access.sql
-- SECURITY MIGRATION (new role, grants, RLS): apply only with the captain's approval.
--
-- Read access for the Claude connector (edge function supabase/functions/mcp). Signed-in registry
-- users ask questions about call data in their own Claude. The connector sends each user's own
-- OAuth access token to PostgREST, so every query runs as that user, never as the service role.
-- All reads go through one door:
--
--   public.mcp_run_sql(query, max_rows, explain_only, tool)
--     1. mcp_private.require_caller(): a signed-in, non-anonymous registry user whose auth session
--        still exists (revoking the connector in the registry deletes that session, so access
--        stops at once instead of when the 1-hour token expires).
--     2. The text must be one SELECT/WITH query and may not name system functions (pg_*,
--        set_config, query_to_xml, ...). PostgreSQL itself refuses a second statement (cursor).
--     3. mcp_private.exec_readonly() runs it as role mcp_reader, inside a sub-transaction:
--          SET LOCAL transaction_read_only = on  -> no write is possible after this line,
--          search_path = mcp                     -> only the views below resolve,
--          a cursor that stops after max_rows (1000 at most),
--        and the sub-transaction is then always rolled back, so nothing the query did survives.
--     4. One row in mcp_query_log (who, which tool, the SQL, rows or error).
--   mcp_reader is NOLOGIN, owns only exec_readonly, and can SELECT the mcp views and nothing else:
--   no table in public, no write privilege anywhere. The views read canoe_calls etc. as postgres.
--   The time limit is the authenticated role's statement_timeout (8 s), set by PostgREST.
--
-- Also: mcp_whoami() (the edge function's auth check on every request) and mcp_describe() (the
-- columns and what they mean, for Claude). Both go through require_caller(). anon and PUBLIC get
-- nothing; authenticated gets EXECUTE on the three public functions and SELECT on its own log rows.
--
-- Rollback: supabase/rollbacks/066_mcp_connector_access_down.sql
-- Test:     supabase/tests/066_mcp_connector_access_test.sql (off production: PGlite or a branch)
-- Run in Supabase SQL Editor as postgres (or supabase db query --linked -f).
-- ============================================================

begin;
set local lock_timeout = '5s';

-- ── Role ──
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mcp_reader') then
    create role mcp_reader nologin;
  end if;
end $$;
-- postgres must be able to SET ROLE mcp_reader to hand it exec_readonly (PostgreSQL 16+ rule).
grant mcp_reader to postgres;

-- ── What the connector can read: views in schema mcp (not exposed by the REST API) ──
create schema if not exists mcp;
revoke all on schema mcp from public;
grant usage on schema mcp to mcp_reader;

-- Every canoe_calls column except account_manager (always empty), plus the registry's own
-- definitions as columns so Claude uses the same numbers as the pages: Mountain Time day,
-- connected, paid, scored, qualified, flagged, and the canonical agent name (aliases resolved).
create or replace view mcp.calls as
select
  c.id, c.created_at,
  (c.created_at at time zone 'America/Denver')::date as day,
  coalesce(al.canonical_ivr_name, c.ivr_name) as agent,
  c.ivr_name, c.ivr_id,
  c.publisher_name, c.publisher_id, c.advertiser_name, c.advertiser_id,
  c.vertical_name, c.vertical_id, c.campaign_name, c.campaign_id,
  c.api_campaign_name, c.api_campaign_id, c.promo_number_name, c.promo_number_id,
  c.lead_id, c.phone_lead_transaction_id,
  c.called_from, c.called_to, c.zip, c.city, c.state, c.line_type, c.keypresses,
  c.result,
  (coalesce(c.connect_duration, 0) > 0 or position('connected' in lower(coalesce(c.result, ''))) > 0) as connected,
  c.duration, c.ivr_duration, c.connect_duration,
  c.advertiser_payin, c.publisher_payout, c.advertiser_bid, c.publisher_bid,
  coalesce(c.advertiser_payin, 0) > 0 as paid,
  c.our_outcome, c.our_outcome is not null as scored,
  coalesce(c.our_outcome in ('appointment', 'sale', 'quoted_interested'), false) as qualified,
  c.canoe_outcome, c.publisher_score, c.advertiser_score,
  c.flags, c.suspicious_call,
  (coalesce(c.flags, '[]'::jsonb) <> '[]'::jsonb or coalesce(c.suspicious_call, false)) as flagged,
  c.compliance_reviewed, c.is_test,
  c.disposition, c.disposition_description, c.intent, c.ai_agent_phone_number,
  c.ai_model, c.ai_processed_at, c.prompt_id,
  c.recording_id, c.recording_type, c.recording_url, c.ascnd_recording_url,
  c.our_summary, c.canoe_summary, c.transcription, c.ascnd_transcript,
  c.synced_at
from public.canoe_calls c
left join public.agent_ivr_aliases al on al.ivr_name = c.ivr_name;

comment on view mcp.calls is 'One row per inbound call routed through Canoe (RingPartner Exchange), synced from Canoe and analyzed by the registry''s AI. About 540k rows since 2026-05-31. Filter on created_at (indexed) for date ranges; group on day for Mountain Time days. Exclude is_test calls unless asked. transcription, ascnd_transcript, canoe_summary and our_summary are long text: select them only for a few calls.';
comment on column mcp.calls.id is 'Canoe call id (unique).';
comment on column mcp.calls.created_at is 'When the call came in (timestamptz, UTC). Indexed: use it for date filters, e.g. created_at >= ''2026-11-01''::timestamp at time zone ''America/Denver''.';
comment on column mcp.calls.day is 'The call''s business day in Mountain Time (America/Denver), as the registry pages count days. Use for grouping; filter on created_at.';
comment on column mcp.calls.agent is 'AI agent (IVR) name with renamed IVRs resolved to their current name. Use this to group or filter by agent.';
comment on column mcp.calls.ivr_name is 'IVR name exactly as Canoe sent it (old names not resolved; see agent).';
comment on column mcp.calls.ivr_id is 'Canoe IVR id.';
comment on column mcp.calls.publisher_name is 'Publisher (traffic source that sent the call). Indexed.';
comment on column mcp.calls.publisher_id is 'Canoe publisher id.';
comment on column mcp.calls.advertiser_name is 'Advertiser (buyer the call was transferred to). Empty when the call never reached a buyer. Indexed.';
comment on column mcp.calls.advertiser_id is 'Canoe advertiser id.';
comment on column mcp.calls.vertical_name is 'Vertical (e.g. home services category or insurance line).';
comment on column mcp.calls.vertical_id is 'Canoe vertical id.';
comment on column mcp.calls.campaign_name is 'Advertiser (buyer) campaign the call was sold into. Empty when unsold.';
comment on column mcp.calls.campaign_id is 'Canoe buyer campaign id.';
comment on column mcp.calls.api_campaign_name is 'Publisher campaign (the inbound campaign the publisher sent the call on).';
comment on column mcp.calls.api_campaign_id is 'Canoe publisher campaign id.';
comment on column mcp.calls.promo_number_name is 'Tracking (promo) number name the caller dialed, when known.';
comment on column mcp.calls.promo_number_id is 'Canoe promo number id.';
comment on column mcp.calls.lead_id is 'Canoe lead id (one caller can have several calls).';
comment on column mcp.calls.phone_lead_transaction_id is 'Canoe phone-lead transaction id.';
comment on column mcp.calls.called_from is 'Caller phone number, E.164 (+1XXXXXXXXXX). Personal data: show only when needed.';
comment on column mcp.calls.called_to is 'Number the caller dialed, E.164.';
comment on column mcp.calls.zip is 'Caller ZIP code (from Canoe). Personal data.';
comment on column mcp.calls.city is 'Caller city (from Canoe).';
comment on column mcp.calls.state is 'Caller state, two letters.';
comment on column mcp.calls.line_type is 'Caller line type: mobile, landline or voip (empty when unknown).';
comment on column mcp.calls.keypresses is 'IVR keypresses the caller made.';
comment on column mcp.calls.result is 'Canoe routing result: connected, abandoned, nobids, dropped or duplicate.';
comment on column mcp.calls.connected is 'Registry definition of a connected call: connect_duration > 0 or result contains "connected". Connect rate = connected / calls.';
comment on column mcp.calls.duration is 'Recording duration in seconds (from Canoe recordings; empty for many calls).';
comment on column mcp.calls.ivr_duration is 'Seconds the caller spent in the IVR before transfer.';
comment on column mcp.calls.connect_duration is 'Seconds connected to the buyer after transfer (0 = never connected).';
comment on column mcp.calls.advertiser_payin is 'Revenue: what the advertiser paid for the call (USD). Registry "revenue".';
comment on column mcp.calls.publisher_payout is 'Cost: what the publisher was paid for the call (USD). Margin = advertiser_payin - publisher_payout.';
comment on column mcp.calls.advertiser_bid is 'Advertiser bid for the call (USD).';
comment on column mcp.calls.publisher_bid is 'Publisher bid for the call (USD).';
comment on column mcp.calls.paid is 'Registry definition of a paid (billable) call: advertiser_payin > 0.';
comment on column mcp.calls.our_outcome is 'The registry''s AI outcome for the call (see outcome_weights for the list). Empty = not AI-scored yet (too short, no transcript, or pending).';
comment on column mcp.calls.scored is 'True when the registry AI has scored the call (our_outcome is set). Outcome shares are % of scored calls.';
comment on column mcp.calls.qualified is 'Registry definition of a qualified lead: our_outcome is appointment, sale or quoted_interested. Qualified rate = qualified / scored.';
comment on column mcp.calls.canoe_outcome is 'Canoe''s own AI outcome for the call (separate from our_outcome).';
comment on column mcp.calls.publisher_score is 'Publisher-side score of our_outcome, from outcome_weights.';
comment on column mcp.calls.advertiser_score is 'Advertiser-side score of our_outcome, from outcome_weights.';
comment on column mcp.calls.flags is 'Compliance flags the AI raised, a JSON array of text. High severity: outbound_dial, facebook_marketplace, coached_call; medium: duplicate_caller, wrong_business, angry_caller; info: geo_mismatch, quoted_abandoned. Test with flags ? ''geo_mismatch''.';
comment on column mcp.calls.suspicious_call is 'AI marked the call suspicious (counted as a high-severity flag on the pages).';
comment on column mcp.calls.flagged is 'True when the call has any flag or is suspicious.';
comment on column mcp.calls.compliance_reviewed is 'A registry user marked the flags as reviewed.';
comment on column mcp.calls.is_test is 'Test call. The registry pages exclude these.';
comment on column mcp.calls.disposition is 'ASCND AI agent disposition (Connected, Completed, Rejected); ASCND calls only.';
comment on column mcp.calls.disposition_description is 'ASCND disposition detail; ASCND calls only.';
comment on column mcp.calls.intent is 'Caller intent reported by ASCND; ASCND calls only.';
comment on column mcp.calls.ai_agent_phone_number is 'Phone number of the ASCND AI agent that took the call.';
comment on column mcp.calls.ai_model is 'Model that produced our_outcome.';
comment on column mcp.calls.ai_processed_at is 'When the registry AI scored the call.';
comment on column mcp.calls.prompt_id is 'Scoring prompt version used.';
comment on column mcp.calls.recording_id is 'Canoe recording id.';
comment on column mcp.calls.recording_type is 'Recording type (post-transfer).';
comment on column mcp.calls.recording_url is 'Link to the Canoe call recording. Personal data: share only on request.';
comment on column mcp.calls.ascnd_recording_url is 'Link to the ASCND AI agent recording. Personal data: share only on request.';
comment on column mcp.calls.our_summary is 'The registry AI''s short summary of the call.';
comment on column mcp.calls.canoe_summary is 'Canoe''s AI summary of the call (long text).';
comment on column mcp.calls.transcription is 'Canoe call transcript (long text, personal data). Select only for a few calls.';
comment on column mcp.calls.ascnd_transcript is 'ASCND AI agent transcript (long text, personal data). Select only for a few calls.';
comment on column mcp.calls.synced_at is 'When the row was last synced from Canoe.';

create or replace view mcp.agents as
select ivr_name, name, vertical, status, routing_type, objective, qualifying, disqualify, notes,
       first_seen_at, seen_calls
from public.agents;
comment on view mcp.agents is 'The registry''s AI agents (IVRs), one row per canonical ivr_name. Join to calls on calls.agent = agents.ivr_name.';
comment on column mcp.agents.ivr_name is 'Canonical IVR name (matches calls.agent).';
comment on column mcp.agents.name is 'Short display name.';
comment on column mcp.agents.status is 'Registry status of the agent.';
comment on column mcp.agents.qualifying is 'What makes a call qualified for this agent (JSON list).';
comment on column mcp.agents.first_seen_at is 'First call seen for this IVR.';

create or replace view mcp.agent_aliases as
select ivr_name, canonical_ivr_name from public.agent_ivr_aliases;
comment on view mcp.agent_aliases is 'Old or alternate IVR names and the canonical name they resolve to (calls.agent already applies this).';

create or replace view mcp.outcome_weights as
select outcome, pub_score, adv_score from public.outcome_weights;
comment on view mcp.outcome_weights is 'Every our_outcome value with its publisher and advertiser score (positive = good for that side).';

create or replace view mcp.account_assignments as
select a.account_name, a.account_type, m.manager_name
from public.account_manager_assignments a
join public.account_managers m on m.id = a.manager_id;
comment on view mcp.account_assignments is 'Which account manager owns which publisher or advertiser account (account_type: publisher or advertiser; account_name matches calls.publisher_name or calls.advertiser_name).';

revoke all on all tables in schema mcp from public;
grant select on all tables in schema mcp to mcp_reader;

-- ── Query log: one row per connector query ──
create table if not exists public.mcp_query_log (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id    uuid not null,
  client_id  text,          -- OAuth client (the Claude connector) from the token; null for a page session
  tool       text not null,
  query      text not null,
  row_count  integer,
  error      text
);
create index if not exists mcp_query_log_user_idx on public.mcp_query_log (user_id, created_at desc);
alter table public.mcp_query_log enable row level security;
revoke all on table public.mcp_query_log from public, anon, authenticated;
grant select on table public.mcp_query_log to authenticated;
drop policy if exists "own or admin reads mcp_query_log" on public.mcp_query_log;
create policy "own or admin reads mcp_query_log" on public.mcp_query_log
  for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));

-- ── Private helpers (schema not exposed by the REST API; no grants to anyone) ──
create schema if not exists mcp_private;
revoke all on schema mcp_private from public;

-- The caller, from the JWT claims PostgREST set: role authenticated, not anonymous, an existing
-- user (not deleted or banned) and a live session. Raises 42501 otherwise.
create or replace function mcp_private.require_caller(out user_id uuid, out email text, out client_id text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
begin
  if c ->> 'role' is distinct from 'authenticated' or coalesce((c ->> 'is_anonymous')::boolean, false)
     or c ->> 'sub' is null or c ->> 'session_id' is null then
    raise exception 'Sign in with your AI Agent Registry login.' using errcode = '42501';
  end if;
  select u.id, u.email into user_id, email
  from auth.users u
  join auth.sessions s on s.user_id = u.id
  where u.id = (c ->> 'sub')::uuid
    and s.id = (c ->> 'session_id')::uuid
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= now())
    and (s.not_after is null or s.not_after > now());
  if user_id is null then
    raise exception 'This session was revoked or has expired. Reconnect Claude from the AI Agent Registry.' using errcode = '42501';
  end if;
  client_id := c ->> 'client_id';
end;
$$;
revoke all on function mcp_private.require_caller() from public;

-- Runs one query read-only as mcp_reader. Only mcp_run_sql calls it (no EXECUTE for anyone else).
create or replace function mcp_private.exec_readonly(p_query text, p_max_rows integer, p_explain boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp, pg_catalog
as $$
declare
  r record;
  out_rows jsonb[] := '{}';
  n integer := 0;
begin
  set local transaction_read_only = on;
  if p_explain then
    for r in execute 'explain (format json) ' || p_query loop
      return jsonb_build_object('plan', to_jsonb(r) -> 'QUERY PLAN');
    end loop;
  end if;
  for r in execute p_query loop
    n := n + 1;
    exit when n > p_max_rows;
    out_rows := out_rows || to_jsonb(r);
  end loop;
  perform pg_advisory_unlock_all();   -- session-level locks outlive a rollback
  return jsonb_build_object('rows', to_jsonb(out_rows), 'row_count', least(n, p_max_rows), 'truncated', n > p_max_rows);
end;
$$;
-- Supabase's postgres is not a superuser, so a new owner needs CREATE on the function's schema:
-- granted for the owner change only, then revoked (the self-check below asserts it is gone).
grant create on schema mcp_private to mcp_reader;
alter function mcp_private.exec_readonly(text, integer, boolean) owner to mcp_reader;
revoke create on schema mcp_private from mcp_reader;
revoke all on function mcp_private.exec_readonly(text, integer, boolean) from public;

-- ── Public entry points (authenticated only) ──
create or replace function public.mcp_run_sql(query text, max_rows integer default 200,
                                              explain_only boolean default false, tool text default 'run_sql')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  me record;
  res jsonb;
  ran boolean := false;
begin
  select * into me from mcp_private.require_caller();
  if query is null or btrim(query) = '' then
    raise exception 'Empty query.' using errcode = '22023';
  end if;
  if length(query) > 20000 then
    raise exception 'Query too long (20,000 characters at most).' using errcode = '22023';
  end if;
  if query !~* '^[\s(]*(select|with)\M' then
    raise exception 'Only one SELECT (or WITH ... SELECT) query is allowed.' using errcode = '22023';
  end if;
  if query ~* '(\mpg_[a-z0-9_]+|\mset_config\M|\mcurrent_setting\M|_to_xml|\mts_stat\M|\mlo_[a-z_]+\s*\(|\mdblink|\mu&[''"])' then
    raise exception 'System functions are not available. Query the views that describe_data lists.' using errcode = '42501';
  end if;

  -- The sub-transaction is always rolled back: on success by the raise below (res and ran are
  -- plain variables and keep their values), on error by the error itself.
  begin
    res := mcp_private.exec_readonly(query, least(greatest(coalesce(max_rows, 200), 1), 1000), coalesce(explain_only, false));
    ran := true;
    raise exception 'mcp: undo';
  exception when others then
    if not ran then
      res := jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
    end if;
  end;

  insert into public.mcp_query_log (user_id, client_id, tool, query, row_count, error)
  values (me.user_id, me.client_id, left(coalesce(nullif(tool, ''), 'run_sql'), 40), query,
          (res ->> 'row_count')::integer, left(res ->> 'error', 1000));
  return res;
end;
$$;

create or replace function public.mcp_whoami()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('user_id', c.user_id, 'email', c.email, 'client_id', c.client_id)
  from mcp_private.require_caller() c;
$$;

create or replace function public.mcp_describe()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me record;
begin
  select * into me from mcp_private.require_caller();
  return jsonb_build_object(
    'views', (
      select jsonb_agg(jsonb_build_object(
        'name', c.relname,
        'description', obj_description(c.oid, 'pg_class'),
        'columns', (select jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                                                        'description', col_description(c.oid, a.attnum)) order by a.attnum)
                    from pg_catalog.pg_attribute a
                    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)
      ) order by c.relname)
      from pg_catalog.pg_class c
      where c.relnamespace = 'mcp'::regnamespace and c.relkind = 'v'),
    'first_call_at', (select min(created_at) from public.canoe_calls),
    'last_call_at',  (select max(created_at) from public.canoe_calls),
    'outcomes', (select jsonb_agg(jsonb_build_object('outcome', outcome, 'publisher_score', pub_score,
                                                     'advertiser_score', adv_score) order by outcome)
                 from public.outcome_weights));
end;
$$;

revoke all on function public.mcp_run_sql(text, integer, boolean, text) from public, anon;
revoke all on function public.mcp_whoami() from public, anon;
revoke all on function public.mcp_describe() from public, anon;
grant execute on function public.mcp_run_sql(text, integer, boolean, text) to authenticated;
grant execute on function public.mcp_whoami() to authenticated;
grant execute on function public.mcp_describe() to authenticated;

-- ── Self-check: abort (nothing applied) if mcp_reader can reach more than the mcp views ──
do $$
declare
  bad text;
begin
  select string_agg(c.oid::regclass::text, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
    and n.nspname not in ('pg_catalog', 'information_schema')
    and has_schema_privilege('mcp_reader', n.oid, 'usage')
    and (has_table_privilege('mcp_reader', c.oid, 'insert, update, delete, truncate, references, trigger')
         or (n.nspname <> 'mcp' and has_table_privilege('mcp_reader', c.oid, 'select')));
  if bad is not null then raise exception '066: mcp_reader can write or read outside mcp: %', bad; end if;

  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('mcp_reader', p.oid, 'execute');
  if bad is not null then raise exception '066: mcp_reader can execute: %', bad; end if;

  select string_agg(n.nspname, ', ') into bad
  from pg_namespace n
  where has_schema_privilege('mcp_reader', n.oid, 'create');
  if bad is not null then raise exception '066: mcp_reader can create objects in: %', bad; end if;

  if has_function_privilege('anon', 'public.mcp_run_sql(text, integer, boolean, text)', 'execute')
     or has_function_privilege('anon', 'public.mcp_whoami()', 'execute')
     or has_function_privilege('anon', 'public.mcp_describe()', 'execute')
     or has_function_privilege('authenticated', 'mcp_private.exec_readonly(text, integer, boolean)', 'execute')
     or has_function_privilege('authenticated', 'mcp_private.require_caller()', 'execute') then
    raise exception '066: entry points are open beyond authenticated -> mcp_run_sql';
  end if;

  if (select pg_get_userbyid(proowner) from pg_proc where oid = 'mcp_private.exec_readonly(text, integer, boolean)'::regprocedure) <> 'mcp_reader'
     or (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.mcp_run_sql(text, integer, boolean, text)'::regprocedure) <> 'postgres' then
    raise exception '066: run as postgres in the SQL editor (exec_readonly must belong to mcp_reader, mcp_run_sql to postgres)';
  end if;
end $$;

commit;
