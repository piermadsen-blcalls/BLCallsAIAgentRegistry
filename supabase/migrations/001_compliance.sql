-- ============================================================
-- 001_compliance.sql
-- Run this in Supabase SQL Editor (once)
-- ============================================================

-- ── canoe_calls ─────────────────────────────────────────────
create table if not exists canoe_calls (
  -- Canoe identifiers
  id                        text primary key,
  lead_id                   text,
  publisher_id              text,
  publisher_name            text,
  advertiser_id             text,
  advertiser_name           text,
  vertical_id               text,
  vertical_name             text,
  campaign_id               text,
  campaign_name             text,
  api_campaign_id           text,
  api_campaign_name         text,
  promo_number_id           text,
  promo_number_name         text,
  phone_lead_transaction_id text,

  -- Call data
  recording_type            text,
  duration                  integer,
  called_from               text,
  called_to                 text,
  zip                       text,
  city                      text,
  state                     text,
  keypresses                text,

  -- Canoe AI output (their model)
  canoe_outcome             text,
  canoe_summary             text,
  transcription             text,

  -- Our AI output
  our_outcome               text,
  our_summary               text,
  publisher_score           integer,
  advertiser_score          integer,
  flags                     jsonb    default '[]'::jsonb,
  ai_model                  text,
  ai_processed_at           timestamptz,

  -- Review state
  compliance_reviewed       boolean     default false,

  -- Internal
  account_manager           text,
  created_at                timestamptz,
  synced_at                 timestamptz default now()
);

-- Index for duplicate caller detection and common filters
create index if not exists canoe_calls_called_from_idx  on canoe_calls (called_from);
create index if not exists canoe_calls_created_at_idx   on canoe_calls (created_at desc);
create index if not exists canoe_calls_publisher_id_idx on canoe_calls (publisher_id);
create index if not exists canoe_calls_advertiser_id_idx on canoe_calls (advertiser_id);
create index if not exists canoe_calls_vertical_id_idx  on canoe_calls (vertical_id);
create index if not exists canoe_calls_ai_processed_idx on canoe_calls (ai_processed_at) where ai_processed_at is null;

-- ── call_corrections ────────────────────────────────────────
create table if not exists call_corrections (
  id               uuid primary key default gen_random_uuid(),
  call_id          text not null references canoe_calls(id) on delete cascade,
  corrected_by     text,
  outcome_before   text,
  outcome_after    text,
  flags_before     jsonb,
  flags_after      jsonb,
  note             text,
  corrected_at     timestamptz default now()
);

create index if not exists call_corrections_call_id_idx on call_corrections (call_id);

-- ── Duplicate caller detection function ─────────────────────
-- Returns IDs from the provided list where called_from appears
-- in a different vertical or from a different publisher within 48 hours
create or replace function find_duplicate_callers(call_ids text[])
returns table(id text) language sql security definer as $$
  select distinct c.id
  from canoe_calls c
  where c.id = any(call_ids)
    and c.called_from is not null
    and exists (
      select 1
      from canoe_calls other
      where other.called_from = c.called_from
        and other.id != c.id
        and abs(extract(epoch from (other.created_at - c.created_at))) <= 172800 -- 48 hours
        and (
          other.vertical_id != c.vertical_id
          or other.publisher_id != c.publisher_id
        )
    );
$$;

-- ── Row Level Security ───────────────────────────────────────
alter table canoe_calls       enable row level security;
alter table call_corrections  enable row level security;

-- Authenticated users can read all calls
create policy "auth users can read canoe_calls"
  on canoe_calls for select
  to authenticated
  using (true);

-- Authenticated users can update ai output + account_manager fields
-- (sync script uses service role which bypasses RLS entirely)
create policy "auth users can update canoe_calls"
  on canoe_calls for update
  to authenticated
  using (true)
  with check (true);

-- Authenticated users can read and insert corrections
create policy "auth users can read corrections"
  on call_corrections for select
  to authenticated
  using (true);

create policy "auth users can insert corrections"
  on call_corrections for insert
  to authenticated
  with check (true);
