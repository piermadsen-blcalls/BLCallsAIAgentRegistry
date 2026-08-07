# Publisher/Advertiser Scoring + Compliance Digest — Spec & Build Plan

_From a grill-me session with Pier, 2026-08-06. Decisions are locked unless listed under §4 (parked) or §6 (open)._

## 1. System context (verified)

- Static `index.html` dashboard (GitHub Pages / Netlify); data in Supabase.
- Pipelines are GitHub Actions, not the frontend:
  - `sync.js` (`sync.yml`, daily 00:00 UTC): Canoe API → `canoe_calls`, patches transcriptions.
  - `process.js` (`process.yml`, Mon/Wed/Fri 08:00 UTC): AI enrichment. Namespaced model id (`google/…`) → OpenRouter; bare id → Anthropic. Writes `our_outcome, our_summary, flags, suspicious_call, publisher_score, advertiser_score, ai_model, ai_processed_at, prompt_id`. `TEST_MODE=true` writes `model_test_results` instead.
  - `alert.js` (`alert.yml`, Mon/Wed/Fri 14:00 UTC): account-health digest → `ASCND_ALERT_WEBHOOK_URL` (GHL).
- Prompts in `ai_prompts` (active = "v3"). Weights in `outcome_weights(outcome, pub_score, adv_score)`. AM routing in `account_managers` + `account_manager_assignments(account_name, account_type, manager_id)`. Alert config `manager_alert_settings`; sends logged in `alert_log`.
- Chosen model: `google/gemini-3.5-flash` (routes via OpenRouter), combined mode = 1 call/record.
- Frontend already has: compliance-flag views, Outcome Weights admin, prompt + training-example editors, canoe_calls-backed call review, tabbed nav, minimal URL-param handling.

## 2. Locked decisions

### Scoring
- **Unit: (publisher × vertical) and (advertiser × vertical).** e.g. Instar-Roofing is scored separately from Instar-Auto Insurance.
- **Two scores per unit, from the same calls:** Canoe (from `canoe_outcome`) and Ours (from `our_outcome`), both over the **comparable set** = calls that have *both* outcomes. Comparable by construction; the set grows toward "all calls" as coverage fills. Build for that steady state.
- **Master score** = trailing 90 days over the comparable set (the headline/ranking number). Plus a **windowed score** for the dashboard's selected date range.
- **Weights read at query time** from `outcome_weights` (pub → `pub_score`, adv → `adv_score`). No per-call score stamping for scoring purposes.
- **One SQL RPC** (`outcome_score_vectors`) returns, per (entity, vertical) over the comparable set, the **outcome-count vector** for canoe and ours. Score = `Σ(count × weight) / Σ count`, computed client-side. Same shape powers the WHY drill-down and the what-if.
- Show **n** (comparable call count) beside each score; **no hard floor** — n is the trust signal.
- Canoe still emits **`wrong_category`** (not in v3) → scored as **pub −3** (added to `outcome_weights`).
- **Separate "Scores" view:** publisher/advertiser toggle; ranked table (Canoe, Ours, gap, n); master vs selected-window toggle; row → **WHY drill-down** (side-by-side outcome mix + headline) + **what-if** (deselect outcomes → recompute) + click-through to the disagreeing calls.

### Compliance + performance digest
- **Cadence: twice weekly, Mon + Thu**, one global cron.
- **Window = since the last digest sent to that manager** (`[prev period_end → now]`); first-ever send bootstraps to **last 7 days**. Stamp `alert_log` on each send.
- **Structure: AM → each assigned account → the flags that account's calls got** this period.
- **All compliance flags listed, no tiers.** Real vocabulary: `outbound_dial, facebook_marketplace, angry_caller, wrong_business, duplicate_caller, geo_mismatch`, plus `suspicious_call`.
- **Include performance flags** (volume, revenue, conversion), **bidirectional** (drops AND surges), mirrored thresholds (±30% volume, ±20% revenue, ±10pp conversion).
- **Fix the broken score filter** (`< 40` on a −5..+10 scale flags every call).
- **Per-account deep links** to the call-review table filtered to that account's flagged calls for the period. Requires the call-review table to accept URL filters — shared with the Scores WHY click-through.
- **No consumer PII in the email** — account names, flag names, counts, links only.

## 3. Prerequisites / risks
- **`process.js` taxonomy coupling:** `VALID_OUTCOMES`, `VALID_FLAGS`, `OUTCOME_SCORES` are hardcoded — prompt taxonomy changes are a two-file change.
- **Call-review table must be backed by `canoe_calls`** (has `flags`/outcomes) before wiring deep links. `feature/team-digest` is stale (pre-canoe_calls) — do not build on it.

## 4. Parked (pending resources)
- **Enrichment go-live.** Backfill ~84,400 transcript calls ≈ **$910** on gemini-3.5-flash (≈9× the ~$100 OpenRouter balance); sustained run ≈ **$10/day**. Gated on a new card / direct-Google or Gemini Batch API. Until then ~400 calls enriched, so Ours-score + digest are structurally live but sparse (by design).
- Direct-Google / Gemini Batch provider branch in `process.js`.
- Prompt-change re-enrichment policy (re-null `ai_processed_at`).

## 5. Build order
0. Sync working tree to `origin/main`. **(done)**
1. **Scores backing migration** — `017_scoring_vectors.sql`: `wrong_category` weight + `outcome_score_vectors` RPC. **(done, applied to remote)**
2. **Scores view (frontend)** — new nav tab, ranked table, toggles, WHY drill-down + what-if. **(done, pending browser verify)**
3. **URL-filterable call-review** — accept accounts/flags/date-range params; deep-link target.
4. **Digest rework (`alert.js`)** — real flag taxonomy; AM→account→flags; since-last-digest window (+7d bootstrap); bidirectional perf; fix score filter; per-account deep links.
5. **Schedule** — `alert.yml` cron → Mon + Thu.
6. **Verify** — dry-run `alert.js`; spot-check Scores view.

## 6. Still open / confirm during build
- Exact perf surge/drop thresholds (mirrored defaults unless changed).
- Remove the `process.js` taxonomy hardcoding now, or leave as a documented gotcha?
- Minimum-n gate for the digest's "flag this account" logic.
