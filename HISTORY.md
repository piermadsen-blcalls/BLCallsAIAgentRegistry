# History

<!-- Append a dated entry at the end of each session: what changed, why, next. Keep it short. -->

## Week of Jul 13, 2026

### 2026-07-15 (Pier)
- Added `CLAUDE.md` (grounded in the real repo) and this `HISTORY.md`. No app changes.
- Scoped the current build push and created Jira epic MK-150 with tasks: MK-151 (AI outcomes accuracy + correction loop), MK-152 (compliance accuracy + correction loop), MK-153 (publisher scoring tied to publisher+vertical), MK-154 (finish LLM training as the team's call-analysis / accuracy tooling).
- Note: LLM training tab is incomplete; publisher scoring formula not finalized and needs to be keyed per publisher+vertical.

### 2026-07-17 (Pier)
- Reconciled from Granola + Jira. Compliance dashboard is live; the registry now covers all Canoe-transcribed calls (not just AI calls).
- Active build focus: **ship the compliance AI dispositions**, and **add publisher scoring** keyed to publisher + vertical (formula still to be finalized) - MK-152 / MK-153.
- Accuracy work continues on both AI outcomes and compliance (correction loop), plus making LLM training the team's easy call-analysis / accuracy tooling.
- No exec ask open right now.
- Same summary fed into the Executive Reporting dashboard.

## Week of Jul 27, 2026

### 2026-07-28 (Pier)
- Shipped Vicky's AI Outcomes **Taxonomy v3** end-to-end. Root cause found: the live
  active prompt was still "v1 — Initial" (old taxonomy), even though the code had v3 -
  so the AI was classifying on the old set. Published v3 as the active `ai_prompts` row
  (migration `016`): `publisher_wrong_category` vs `advertiser_service_mismatch` split +
  `quoted_abandoned`. Also backfilled the missing `advertiser_service_mismatch` row in
  `outcome_weights`.
- Brought every frontend outcome/flag list to v3: disposition dropdown, compliance
  filter (was also missing `caller_callback`/`agent_callback`), `REVIEW_OUTCOMES`/
  `REVIEW_FLAGS`. Dropped the orphan `incentivized_caller` flag.
- Model-test harness: `MODEL_CATALOG` switched to OpenRouter slugs (Opus 4.8, Sonnet 4.6,
  added Gemini 3.5 Flash); added length-stratified **pinned** sampling so all models score
  the identical 100 calls (new `test_call_ids` input on `process.yml`).
- Design decision: compliance = clean-rate metric on the compliance dashboard (per
  publisher/vertical, MK-152), NOT a model-test accuracy score. Model-test scorecard
  stays outcome-only, intentionally.
- Flagged for later: scheduled default `AI_MODEL` `anthropic/claude-sonnet-4-6` is
  hyphenated; OpenRouter uses dotted slugs - verify prod process runs resolve.
- Next: run 3-model / 100-call outcome comparison; Vicky hand-checks + approves the model.
- External sources (Granola/Jira) not pulled this session.

## Week of Aug 3, 2026

### 2026-08-07 (Pier)
- Grill/scoping session that turned into a build. Winning model confirmed as
  `google/gemini-3.5-flash` (via OpenRouter).
- Shipped the Publisher/Advertiser **Scores** tab (MK-153): (publisher|advertiser)
  × vertical, two scores from the *same* comparable set (calls that have both
  `canoe_outcome` and `our_outcome`) — Canoe vs Ours — computed read-time from
  `outcome_weights`. Master (trailing 90d) + selected-window toggle; sortable
  ranked table; WHY drill-down with a what-if (deselect an outcome → both scores
  recompute) and a "view these calls" hand-off.
- Migration `017_scoring_vectors.sql`: `outcome_score_vectors` RPC (per
  entity×vertical outcome-count vectors over the comparable set) + `wrong_category`
  weight (pub -3) for Canoe's pre-v3 label. Also reconciled the CLI migration
  history (001-016 were all applied by hand, so remote history was empty → marked
  applied) so `supabase db push` works cleanly from here; pushed 017.
- Wrote `SCORING_AND_DIGEST_SPEC.md` — full decision log + build order.
- Parked: enrichment go-live / backfill. Full backfill of ~84.4k transcript calls
  ≈ $910 on gemini-3.5-flash vs the ~$100 OpenRouter balance; waiting on a new card
  / direct-Google or Gemini Batch API. So Ours-score + the compliance digest are
  live but sparse until enrichment scales (building for the steady state).
- Shipped the compliance digest + deep-links (same session): the Compliance tab
  now reads URL params (`#view=compliance&account&type&from&to&flagged`) as the
  deep-link target — avoids migrating Call Reporting, which is still on
  `agent_calls_raw` with no flags. `alert.js` rewritten: all AI compliance flags,
  grouped AM→account→flags; window is since-last-digest (+7d bootstrap on first
  send); perf now bidirectional (±30% vol, ±20% rev, ±10pp conv); dropped the
  broken `<40` score filter; per-account deep links via `DASHBOARD_URL` (set as a
  repo variable = the Netlify URL). `alert.yml` cron `1,3,5` → `1,4` (Mon + Thu).
  Migrations `017` (scoring RPC + `wrong_category` weight) and `018` (partial
  index) applied via CLI; migration history reconciled (001-016 marked applied).
  Dry-run of the digest runs clean (skips managers w/ no assignments; 0 sent).
- Next: enrichment go-live (parked on OpenRouter budget / new card). Cleanup:
  duplicate `crBuildQuery` in `index.html` (~lines 2009/2028).
- External sources (Granola/Jira) not pulled (Granola MCP disconnected).

## Week of Aug 10, 2026

### 2026-08-10 (Pier)
Continued from the 8/7 Scores work; large session. What moved:
- **Persistent login**: auth moved to localStorage + refresh-token auto-renewal
  (45-min timer + on-401), so managers sign in once, not per tab/visit.
- **Per-tab URLs**: query-string router (`?tab=…&sub=…`) for all tabs + the
  Compliance sub-tabs; back/forward + bookmarking; digest deep links and the
  Scores "view these calls" hand-off route through it.
- **Compliance digest reworked to compliance-only** (dropped volume/revenue/
  conversion): lists all AI flags, grouped AM→account→flags; window is
  since-last-digest (+7d bootstrap); `alert.yml` cron `1,3,5`→`1,4` (Mon+Thu);
  per-account deep links via `DASHBOARD_URL` repo var. Deep links use `?query`
  (email clients strip `#` fragments). Added preview env hooks (target one
  manager / override recipient / force window). Verified end-to-end by previewing
  a manager's digest to a test inbox.
- **Account manager assignments loaded** from a client list (advertisers +
  publishers → owner), ~94% matched `canoe_calls` names; AM emails set; alerts
  enabled per manager.
- **Agents tab, top stats, and Call Reporting now read `canoe_calls`** (the daily
  auto-synced table), not the manual-upload `agent_calls_raw`.
- **Load-time fix** (~10s+/timeout → ~1-2s): Agents tab loads per-agent totals via
  the `agent_metrics` RPC on boot (GROUP BY ivr_name — a few dozen rows) and
  lazy-loads each agent's publisher/advertiser breakdown via `agent_breakdown`
  only when its drawer opens; compliance's ~15k rows also load lazily on tab open.
  Unregistered-agent check → `get_distinct_ivrs` RPC. (Earlier passes used a
  heavier `agent_rollup` that still timed out — 022 split it into totals + lazy
  breakdown, 023 added a `(ivr_name, created_at)` index so the drawer seeks one
  agent instead of scanning the window.)
- **Removed the manual CSV-upload UI** (markup stored in `legacy/manual-upload.html`;
  JS left defined). New-agent auto-detection paused with it (offered to restore as
  a light banner). Kept "sync ASCND data".
- Migrations `017`–`023` applied via the Supabase CLI; reconciled the CLI migration
  history (001–016 had been applied by hand).
- Parked: enrichment go-live / backfill (OpenRouter budget / new card).
- More still to do (session ongoing).
- External sources (Granola/Jira) not pulled this session.

### 2026-08-10 (Pier) — context reconciliation
- Compiled a `context.md` for this folder from a cross-project pull (Granola last 3 weeks + Outlook + Exec Reporting board). No app/code changes beyond adding that file.

### 2026-08-11 (Pier) — merged Call Reporting + Compliance; Calls/Settings redesign
- **Fixed Call Reporting (was showing zero calls).** Root cause: `crLoad` sent the
  anon publishable key as its bearer token, so RLS (canoe_calls SELECT is
  authenticated-only) silently returned an empty set. Now sends the user JWT like
  `sbFetch`. Also dropped `is_test=eq.false` (excluded NULL-`is_test` rows) and moved
  the verticals dropdown to a `get_distinct_verticals()` loose-index-scan RPC
  (migration `026`) — the old `select distinct` over ~264k rows was timing out (57014).
- **Merged the two call logs into one `Calls` tab** (chosen shape: "everything folded
  in"). Calls keeps CR's server-paginated engine and gains the compliance lens: a
  summary strip (AI-processed / flagged / flag rate / pending), a Flagged-only toggle +
  flag-type filter (server-side jsonb `flags` filters so pagination survives),
  Outcome (Registry + Canoe) / Flags / Reviewed columns, and row-click opens the shared
  review drawer (transcript + mark-reviewed).
- **New `Settings` tab** (repurposed the old Compliance pane) with subtabs Team / Admin /
  Training; **removed the Compliance tab and the standalone LLM-training tab** (its model
  calibration section now lives under Settings → Training).
- **Routing:** `?tab=calls` canonical; legacy `?tab=reporting` and `?tab=compliance…`
  redirect to Calls (digest deep-links land on Calls, pre-filtered). `alert.js`
  deep-link updated to `?tab=calls`. Settings subtabs route at `?tab=settings&sub=`.
- Scores: added a name/vertical search box; drawer got transcript link + copy-id +
  header alignment (earlier in the session).
- Stripped the ~10 dead compliance call-log functions (post-merge cleanup) plus their
  orphaned state vars. Verified the two Calls jsonb flag filters against prod
  (`supabase db query --linked`): `flags <> '[]'` = 101 flagged = `jsonb_array_length>0`
  (exact match); `flags @> '["<flag>"]'` returns correct per-flag counts. Both correct.
- Chose the merge shape ("everything folded in") via a Lavish visual mockup comparison
  of three options rendered in the dashboard's own design system.
- **CSV export on the Calls tab** (toolbar button): exports every row matching the
  active filters, now including the Outcome (Registry + Canoe), Flags, and Reviewed
  columns alongside the operational fields.
- **Self-service password change**: header account menu (email → Change password /
  Sign out). Change password updates via Supabase auth (`PUT /auth/v1/user`) using the
  user's own session — no admin/service key — mirroring the invite/recovery flow.
- External sources (Granola/Jira) not pulled this session.
- Reconciled state: day-to-day registry ownership handed to **James Teasdale** (Aug 3); Pier retains complex/strategic pieces. Winning dispo model = `google/gemini-3.5-flash`. Compliance flags stay separate from scoring; 2-day digest cadence.
- New adjacent workstream noted: **Ring Partner caller-ID / buyer-acceptance strategy** (with David) — "intercept and re-ping" to capture caller ID and re-ping higher-value buyers (BCI pre-ping vs caller-ID-requiring network buyers).
- Jira note: MK-150/MK-153 tracking tickets were **deleted** — no live tickets for this project now.
- _Sources summarized only in `context.md`; nothing sensitive/personal logged._

### 2026-08-11 (Pier) — Gemini 3.6 Flash Batch API for nightly scoring
- **Moved production scoring to Google's native Gemini Batch API** (`gemini-3.6-flash`,
  ~50% cheaper than sync). Batch is async (SLO ≤24h, all-or-nothing), and a GH Actions
  job caps at 6h, so the pipeline is **two-phase**: a nightly `submit` records batch
  jobs and exits; a separate `ingest` polls them and writes results in a later run.
- **`scripts/process.js`:** added native Gemini routing (bare `gemini-*` id → new
  `callGemini`, was wrongly falling through to Anthropic), `runGeminiSubmit` /
  `runGeminiIngest`, gemini_batch_jobs tracking helpers, and env `BATCH_ACTION`
  (submit|ingest), `BACKFILL_DAYS`, `GEMINI_CHUNK` (default 500), `DRY_RUN`. Factored the
  shared result-write (outcome/flag validation + code-decided duplicate_caller &
  geo_mismatch + scores) out of `runBatch` into `buildResultPatch`, reused by both
  batch paths.
- **Correctness hardening beyond the plan:** submit stamps nothing on `canoe_calls`, so
  added an **in-flight guard** (`fetchInFlightCallIds`) to never re-submit calls already
  in an open job (double-cost on overlapping nightly runs / re-dispatched backfill), and
  **paginated `fetchUnprocessed`** so a big backfill isn't silently capped by the server
  row limit.
- **Migration `027_gemini_batch_jobs.sql`:** tracks each job (job_name, model, prompt_id,
  status, call_ids jsonb, timestamps) across runs; RLS = service-role writes / auth
  reads, modeled on `008_alert_log`.
- **Workflows:** new `process-submit.yml` (nightly 03:00 UTC) + `process-ingest.yml`
  (every 6h); removed the Mon/Wed/Fri `schedule` from `process.yml` (kept its
  `workflow_dispatch` — the calibration/A-B UI still dispatches it).
- **Deliberately skipped** the optional frontend model-catalog/pricing entry — the
  calibration catalog uses OpenRouter ids and `process.yml` has no `GEMINI_API_KEY`, so a
  bare native id there would be half-wired. Left as a clean follow-up.
- **Not yet live — manual steps remain:** add `GEMINI_API_KEY` to GitHub Actions secrets
  + `scripts/.env` + `scripts/.env.example` (the last is permission-blocked locally);
  apply migration `027`; then verify with a 3-call `DRY_RUN`/submit→ingest before
  dispatching the 30-day backfill (`process-submit` with `backfill_days=30`, big
  `batch_size`). Code is `node --check` clean; not run against live Supabase/Gemini yet.
- External sources (Granola/Jira) not pulled this session.
