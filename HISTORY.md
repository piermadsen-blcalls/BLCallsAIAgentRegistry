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
- **Shipped + verified live (2026-08-11).** `GEMINI_API_KEY` set as a repo Actions
  secret (AI Studio key); migration `027` applied to prod; pushed to `main`. Verified
  end-to-end via `workflow_dispatch`: dry-run → real 3-call submit
  (`batches/l6vhz…`, key/billing/model access all good) → ingest wrote 3/3 to
  `canoe_calls`, 0 errors, job marked `completed`. Note: the live API returns
  `BATCH_STATE_*` (not the docs' `JOB_STATE_*`); our substring state checks handle both.
- **Still to add manually:** `GEMINI_API_KEY` line in `scripts/.env` (local runs) and
  `scripts/.env.example` (permission-blocked for me).
- **30-day backfill (~32k calls) in progress.** Quota reality: Tier 1 batch cap for
  3.6 Flash is **3M enqueued tokens** (~2k calls in flight); firing all 63 jobs at once
  429'd. Hardened submit to stop gracefully at the quota + resume (in-flight dedup), 1s
  gap between job creations. Added `MIN_TRANSCRIPT_WORDS` filter — backfill only scores
  calls with a real transcript (≥10 words; drops ~641 fragments, keeps ~32,097). Scope
  matters: 90k calls are unprocessed all-time vs ~33k in the last 30 days, so the backfill
  is pinned to 30 days. Running via a **temporary `backfill-drip.yml`** (hourly:
  ingest→submit, self-throttles under the 3M cap); DELETE that file once the 30-day set
  drains. Steady-state stays on process-submit (nightly) + process-ingest (6h).
- **Bug found during backfill: ingest silently dropped large jobs.** `fetchCallZips`
  built a single `id=in.(…500 ids…)` URL (~10KB) that the server dropped ("fetch
  failed"), so succeeded jobs never wrote results (jobs safely stayed `processing`, no
  data loss). Fixed by chunking the zip lookup ~100 ids at a time. Re-verified: 4×500
  jobs ingested 0 errors; `by_gemini` 3 → 2,003.
- **Backfill cadence fix.** GitHub scheduled crons fire late/unreliably (6h ingest ran
  ~2h late; hourly drip skipped), stalling the backfill. Reworked `backfill-drip.yml` to
  **loop internally** (~5.5h/run, ingest→submit every ~4 min), restarted by a 6h cron —
  keeps the pipeline continuously full instead of depending on cron. Drained ~3k → ~25k.

### 2026-08-12 (Pier) — Calls & Agents dashboard: metrics, timeout fixes, perf rollup
- **Calls-tab compliance metrics fixed.** `callsLoadStats` fetched ≤5,000 rows and
  counted client-side, so the "processed by AI" total capped at 5k and never reflected
  new Gemini calls; also a once-guard blocked refresh. Now uses `Prefer:count=exact`
  (uncapped, refreshes each tab open). Removed the "pending review" metric (irrelevant
  here); strip is now 3-up. Then scoped the strip to the SAME time period + filters as
  the table — extracted a shared `crBuildFilters()` (also collapsed an accidental
  duplicate `crBuildQuery`) and refresh the metrics on every `crLoad`, so the numbers
  describe the filtered view, not all-time. The strip respects date + vertical /
  disposition / publisher / etc., but IGNORES the two flag drill-downs (Flagged-only,
  flag-type) via `crBuildFilters(false)` so flag rate stays a real ratio instead of
  collapsing to 100% when you drill in. All counts are `count=exact` — nothing estimated.
- **Moved the 4 header KPIs (total agents / calls / revenue / margin) into the Agents
  tab** (under the nav, `.agents-stats`), so they only show on Agents instead of the
  global header. **Added a hover breakdown on the Calls "flagged" metric** — count of
  calls per flag type, scoped to the same date + business filters, lazy per-scope, each
  a GIN-indexed containment count.
- **Agents tab initial load: ~5-9s → 44ms** via a per-agent-per-day rollup (migration
  `030`, `agent_metrics_daily`). The tab re-aggregated ~90k raw rows on every load
  (worse under the backfill's stale-visibility-map heap fetches). Rollup is built from
  RAW call fields only (payin/duration/result) — independent of AI processing — so it
  was safe to build + cut over mid-backfill. `agent_metrics()` now sums ~5.8k pre-agg
  daily rows instead of scanning raw; verified byte-identical totals vs the raw query
  before cutover (no frontend change — same RPC signature). Refreshed daily at 01:00 UTC
  via **pg_cron** (`refresh_agent_metrics_daily(45)` re-aggregates a trailing window to
  catch late sync patches). VACUUM turned out unnecessary here — the rollup never scans
  raw, and autovacuum tidies canoe_calls post-backfill.
- **Fixed a 57014 statement timeout on the Calls table** (surfaced when testing a
  month range + Flagged-only). The table query counts ALL calls in range; over ~100k
  rows the jsonb `flags<>'[]'` filter took ~12s vs the authenticated role's 8s timeout.
  Added migration `028` — a **partial index** `canoe_calls (created_at desc) where
  flags <> '[]'` — so flagged queries touch only the few-hundred flagged rows. Count
  dropped 11,761ms → 79ms; counts stay exact. (Applied to prod via linked CLI.) The
  metric strip itself was never the problem — it filters by `ai_processed_at` (indexed,
  ~260ms). No-filter wide-range counts are ~5.7s (under 8s for now) — noted, not fixed.
- **Second 57014, second index.** The flag-TYPE dropdown filters with jsonb containment
  (`flags @> '["outbound_dial"]'`), which 028's partial index can't serve (planner won't
  use a `flags<>'[]'` predicate for `@>`). Migration `029` — GIN index on `flags`
  (`jsonb_path_ops`) → that count went ~12s → 0.4ms. Both jsonb filter paths are now
  indexed (partial for Flagged-only, GIN for flag-type). Applied to prod via linked CLI.
- **Backfill COMPLETE (2026-08-13 ~01:00 UTC).** Full 30-day ≥10-word set scored by
  gemini-3.6-flash (`remaining_30d` = 0, ~33.6k total). Late-stage stall (~5.5h, 16:00→21:50):
  `fetchUnprocessed` started timing out (57014) as unprocessed rows went sparse in the
  window (created_at scan filtered ~100k processed rows). Fixed with migration `031` — a
  partial index on unprocessed+transcribed rows (8s→78ms); the running drip loop then
  drained the rest. **Deleted the temporary `backfill-drip.yml`**; steady state = process-submit
  (nightly) + process-ingest (6h). Migrations applied through `031`.
- **Remaining follow-up:** add `GEMINI_API_KEY` to `scripts/.env` + `scripts/.env.example`
  (env.example was permission-blocked for me).
- External sources (Granola/Jira) not pulled this session.

### 2026-08-13 (Pier) — Vicky's Calls-tab asks
- **Outcome filter on the Calls tab** (Vicky). Added a `cr-outcome-filter` dropdown beside
  flag-type, options populated from the canonical `REVIEW_OUTCOMES` list; adds
  `our_outcome=eq.<x>` via the shared `crBuildFilters()`, so both the table and the top
  metric strip scope to it (e.g. isolate `quoted_abandoned`).
- **Suppress `outbound_dial` on transfer verticals** (Vicky — it was noise in the summary
  emails). Model still emits it; code strips it, same pattern as `geo_mismatch`.
  `isTransferVertical = /transfer/i` (catches all 14 transfer verticals incl. the singular
  "Final Expense Enriched Transfer"). Applied in `buildResultPatch` (+ the sequential
  path); wired vertical through the write paths (`fetchCallZips`→`fetchCallMeta` now also
  fetches `vertical_name`; runBatch `verticalById` map). One-time migration `032` stripped
  it from **99** already-scored transfer calls (now 0). `alert.js` unchanged — it reads
  `flags` straight from the row, so cleaned data drops it from emails automatically.
- **Removed the Verticals + Dispositions filters from the Calls toolbar** (deemed
  useless). Surgical: kept the shared vertical helpers (`loadVerticals`/`buildVerticalOptions`/
  `populateVerticalDropdowns` — Insights still uses them); dropped only the Calls-specific
  dropdowns, the `crVertical*` fns, `crVerticalFilter`, `cr-dispo-filter`, and their
  `crBuildFilters` lines. Table columns unchanged.
- **Minimum-volume gate on the Scores tab.** Publisher/advertiser pairings with fewer
  than **20 scored calls** (`SCORES_MIN_CALLS`) now withhold their score — the row still
  shows with its call count + a muted "low volume" tag (and the expand-detail gets a
  matching note), so you see it accumulating instead of trusting a score off a handful of
  calls. Gate is purely presentational (in `scoresRenderTable`/`scoresRenderDetail`); the
  underlying `n` already came from `outcome_score_vectors`.
- **Alert digest rescheduled to Mon + Thu 16:00 UTC** (was 14:00; CLAUDE.md was also mislabeled Mon/Wed/Fri, fixed). Added `ALERT_ALL_MANAGERS` (preview-only, requires `override_email`) to preview EVERY manager with accounts regardless of the enabled flag. Sent Pier 8 per-AM previews. Note: only Matt Fu currently has alerts enabled; today's real 14:00 digest fired ~55min late at 14:55.
- External sources (Granola/Jira) not pulled this session.

### 2026-08-14 (Pier) — keep Gemini scoring current
- **Diagnosed "lots of yesterday's calls have no outcome."** The nightly pipeline itself
  is healthy (Submit 03:00 → Ingest every 6h, 0 errors), but submit is `created_at.asc`
  (oldest-first) capped at 1000/run. With ~44k June + ~12k July unprocessed rows (history
  synced but never scored) sitting at the front of the queue, each run spent its whole
  budget on **June** and starved the current day — Aug 13 had 1,607 transcribed calls but
  only 11 scored. Recent window was otherwise fine (last-30-days = ~2.3k unprocessed, and
  Aug 6–12 all cleared to <65). Transcript-less calls are already excluded; ~36% of the
  pool is sub-20-word fragments (`MIN_TRANSCRIPT_WORDS` guard exists but is off).
- **Fix (PR #2, merged `a40e94c`):** `process-submit.yml` now defaults `BACKFILL_DAYS=30`
  so `fetchUnprocessed` queries `created_at >= now-30d` and never grabs older-than-window
  history; and runs **3× spaced/day** (03:00 / 11:00 / 19:00 UTC) for up to 3000 calls/day,
  with the every-6h ingest draining each batch before the next submit so only ~1000 is
  ever enqueued at Gemini at once (stays under the current AI Studio batch ceiling).
- **Kicked one manual Submit** (`backfill_days=30`) to start clearing Aug 13 immediately —
  submitted 1000 recent calls (2×500), confirmed it targeted the window not June.
- **Next / follow-ups:** collapse back to one run + larger `BATCH_SIZE` once AI Studio
  expands the batch quota (~2 days out); optionally set `MIN_TRANSCRIPT_WORDS=12` to skip
  fragment calls. External sources (Granola/Jira) not pulled this session.

## Week of Aug 17, 2026

### 2026-08-21 (Pier) — filtered revenue total on the Calls tab
- **Added a 4th summary card "revenue"** to the Calls tab strip (grid 3→4),
  showing `SUM(advertiser_payin)` over exactly the rows matching the current filters.
- **How:** extended `callsLoadStats()` with a third parallel request alongside the two
  existing count queries — scoped via `crBuildFilters(true)` so it matches the TABLE
  (flag drill-downs included), not the AI-processed strip scope. One aggregate request
  returning a single number → no added page latency (piggybacks the existing fast
  count-only pattern). Falls back to "—" (caught) if the request fails, so the strip
  never breaks.
- **Constraint hit:** PostgREST built-in aggregates are **disabled** on the project
  (`PGRST123` confirmed live). Chose to enable aggregates over an RPC (least code, no
  filter-logic duplication, self-correcting as filters evolve; RLS already lets clients
  read+sum these rows so exposure delta is ~nil).
- **Manual step still pending on Pier:** Supabase Dashboard → Project Settings → API →
  enable aggregate functions. Until then the card shows "—".
- Walked the options via a Lavish review artifact (`.lavish/revenue-sum.html`); Pier
  picked the recommended combo (enable aggregates → 4th card).
- **Pushed live to `main`** (Netlify auto-publish). External sources (Granola/Jira) not
  pulled this session.

## Week of Aug 24, 2026

### 2026-08-24 (Pier) — Agent Review workspace (AI IVR optimization loop)
- **New "Review" tab** (`index.html`, between Calls and Scores) — a per-agent review
  surface. Pick an agent → read the calls that ran through it (route, disposition +
  description, single `our_outcome` badge, flags, transcript, recording) → answer four
  required questions (handling / recurring glitches / redundant questions / CVR wording) +
  free notes → save a dated review. Reuses `agent_metrics` (perf strip), `aliasesForAgent`
  (calls gathered across canonical + aliases), `outcomeBadge`/`flagBadges`, and the
  `sync_hl_to_calls` RPC (the "Sync ASCND data" control, now also in the Review header).
- **Repeatable-loop design.** Each review is windowed to "calls since the last logged
  change" so you only grade the current version of the agent. Anchor = latest
  `agent_changes.applied_at` → else last review's `period_end` → else 30d. There is **no
  automatic change signal** (agent script lives in ASCND), so changes are logged manually:
  one-click **＋ Log change**, or the "Changes I'm applying" box on save. Window start is
  always shown + overridable via a date input. Added a **Reviewed** KPI (distinct calls a
  human marked reviewed in-window) + per-call ☑ Mark reviewed / ✎ Note.
- **Migration `033_agent_reviews.sql`** (applied to prod): three small tables —
  `agent_reviews` (append-only history), `call_reviews` (`(call_id, reviewed_by)` PK;
  powers the KPI + per-call note), `agent_changes` (the window anchor). RLS mirrors
  `call_corrections` (authenticated read/insert; call_reviews also update+delete).
- **Deliberately kept lean** after review: cut a health rating, call-tagging taxonomy +
  auto-fill, Registry-vs-Canoe comparison, and per-call "re-run AI" from an earlier draft.
- **`intent` + `ai_agent_phone_number` (migration `034`).** Pier updated ASCND's webhook to
  also send `intent` and `ai_agent_phone_number`. Confirmed via live schema query that
  `hl_call_data` is the ASCND landing table and had neither column. `034` adds both to
  `hl_call_data` (receiving) and `canoe_calls` (master), and extends
  `sync_hl_to_canoe_calls` to carry both through the existing caller-phone + time pairing.
  **Pairing key intentionally unchanged** — `ai_agent_phone_number` is carried through, not
  yet a join key (historical rows lack it; validate vs `called_to` on real data first, then
  optionally harden + auto-learn an `ai_agent_phone_number → ivr_name` map for unpaired
  ASCND calls). Review tab now selects both and shows an `intent` chip on each call.
- **Fixed the Review "Sync ASCND data" button** to call `sync_hl_to_canoe_calls(from_ts,to_ts)`
  (the master-table function `sync.js` uses) instead of the legacy no-arg `sync_hl_to_calls`
  the footer button calls — the legacy one doesn't touch `canoe_calls`. Footer button left
  as-is; discrepancy still worth reconciling separately.
- **Agent attribution note:** agents are identified by Canoe's `ivr_name` (alias-resolved);
  the `agents` registry has no phone/DID column. The agent phone number isn't *needed* for
  attribution — it's a robustness upgrade (tighter pairing + rescuing unpaired ASCND rows).
- Design reviewed with Pier via a Lavish artifact (`.lavish/agent-review.html`) over two
  rounds before build. Migrations `033` + `034` applied to prod; committed + pushed to
  `main` (Netlify auto-publish). `intent` backfill is blocked upstream — `hl_call_data`
  has 0 rows with `intent` (ASCND hasn't populated it yet), so there's nothing to pull.
- **Shipped the Review base to `main`** (rebased onto remote's Calls-tab revenue work;
  `9e602e1`). `intent` backfill blocked upstream — `hl_call_data` has 0 rows with `intent`
  (ASCND hasn't populated it), so nothing to pull until ASCND backfills the landing table.
- **Review status board + AM assignment (migration `035`).** The Review landing view is now
  a status board: Agent | Vertical | Assigned reviewer | Status, with All / Needs review /
  My agents filters (My agents keys off the current user's email in `account_managers`).
  Needs-review = never reviewed OR a change logged after the last review OR not reviewed in
  30 days. One reviewer per agent → new `agent_review_assignments` table (ivr_name PK →
  `account_managers`), inline assign dropdown, RLS mirrors `account_manager_assignments`.
  Board degrades gracefully if `035` isn't applied yet (everything reads Unassigned).
- **Review is now ASCND-only.** Transcript reads `ascnd_transcript` only (was falling back to
  Canoe's `transcription`); the call list filters `ascnd_transcript=not.is.null` so only calls
  with an AI-agent transcript show.
- **Ingestion diagnosis (from the real GHL webhook payload).** `hl_call_data` is fed by a
  GoHighLevel workflow ("Update Supabase with Call Data") writing its `customData` envelope.
  Live: `ai_agent_phone_number` is in the payload+populated but **not mapped** to the column
  (DB has 0); `transcript` isn't in customData at all (the AI transcript is the top-level
  "Voice AI Transcript" — only 257/93k rows have any transcript, 3/3348 recently); `intent`
  is in customData but **empty at source** (ASCND only fills it when the call is passed back
  to Canoe). Fix is in the GHL workflow's Supabase step: map `ai_agent_phone_number`,
  `transcript`←"Voice AI Transcript", `intent`. Backfill of transcript+agent-phone is possible
  from a 30-day CSV/replay; intent can't be backfilled (never stored).
- **Next:** apply migration `035` (done); GHL workflow field mapping fix (Pier, external);
  then 30-day transcript/agent-phone backfill. External sources (Granola/Jira) not pulled.
