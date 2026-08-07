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
