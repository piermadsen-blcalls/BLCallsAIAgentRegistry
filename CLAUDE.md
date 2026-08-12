# AI Agent Registry — Buyerlink Calls

Internal dashboard + data pipeline for BL Calls' AI phone agents: syncs call data
from Canoe (RingPartner Exchange), AI-analyzes transcripts for outcome +
compliance, and surfaces it in a single-page registry. Live on Netlify.

## Architecture (map)
- **`index.html`** — the ENTIRE frontend. One file, vanilla HTML/CSS/JS, **no
  framework, no build step.** Tabs: Agents, Insights, Calls, Scores, Settings.
  Talks directly to Supabase REST via the `sbFetch()` helper; the Settings →
  model-calibration UI can dispatch the `process.yml` GitHub Action.
- **`scripts/`** — Node jobs, run by GitHub Actions on a schedule:
  - `sync.js` — daily 00:00 UTC — two-pass Canoe → Supabase `canoe_calls`
    (pass 1 upsert calls; pass 2 patch transcription/duration/outcome).
  - `process.js` — AI analysis of unprocessed calls; writes outcome + compliance
    flags back to the row. Production scoring runs on **Gemini 3.6 Flash via Google's
    native Batch API** (~50% cheaper, async). Batch is **two-phase** (env `BATCH_ACTION`):
    `submit` records jobs in `gemini_batch_jobs` and exits; `ingest` polls them and
    writes results in a later run (survives the 6h GH Actions cap vs Gemini's ≤24h SLO).
    Bare `gemini-*` ids hit the native Gemini API; namespaced ids (`anthropic/…`,
    `google/…`) still route via OpenRouter for the calibration/test UI. Knobs:
    `BATCH_SIZE`, `BACKFILL_DAYS`, `GEMINI_CHUNK`, `MIN_TRANSCRIPT_WORDS`, `DRY_RUN`.
  - `alert.js` — Mon/Wed/Fri 14:00 UTC — compliance/perf alerts to account
    managers via the ASCND webhook.
- **`supabase/`** — `migrations/` (001–030) and `functions/admin-users` (edge fn).
  Project ref: `wvnfcxhbztnefhzjhfgg`. Notables: `002` RLS, `004` ai_prompts,
  `022` agent_metrics/agent_breakdown RPCs, `027` gemini_batch_jobs (batch tracking),
  `028` partial + `029` GIN (`jsonb_path_ops`) index on `flags` (Calls-tab jsonb
  filters — fix 57014 timeouts), `030` `agent_metrics_daily` rollup that `agent_metrics`
  reads instead of scanning raw (Agents load ~5-9s → ~44ms), refreshed daily by **pg_cron**
  (`refresh-agent-rollup`, 01:00 UTC).
- **`.github/workflows/`** — `sync.yml` (daily 00:00), `alert.yml` (Mon/Wed/Fri),
  `process.yml` (manual/test dispatch only — cron removed), and the Gemini batch crons
  `process-submit.yml` (nightly 03:00 UTC) + `process-ingest.yml` (every 6h).
  `backfill-drip.yml` is a **temporary** one-off (loops ingest→submit under the batch
  quota) for the 30-day backfill — delete it once drained.

## Conventions & gotchas (do not break)
- **It's one static file.** Edit `index.html` directly. Don't add a build tool,
  framework, or bundler without a real reason — Netlify serves the repo root as-is.
- **Frontend uses the Supabase *publishable* key** (client-safe, RLS-gated — see
  `migrations/002_rls.sql`). The **service-role key is never in the client** (the
  Settings admin UI takes it session-only; scripts read it from env). Never commit
  a service key.
- **Secrets live in `scripts/.env` (gitignored) + GitHub Actions secrets** — never
  commit: `CANOE_API_KEY`, `SUPABASE_SERVICE_KEY`, `OPENROUTER_API_KEY`,
  `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (AI Studio, for the native batch),
  `ASCND_ALERT_WEBHOOK_URL`. Add new ones in both places.
- **DB changes = a new numbered migration** in `supabase/migrations/` (next is
  `031_…`). Don't edit existing migrations. Migrations are applied to prod by hand
  (Supabase SQL editor or `supabase db query --linked`); the files are the record.
- **Agents are keyed by IVR name** with an alias→canonical map (`agent_ivr_aliases`);
  resolve to the canonical name before grouping.
- **The design system is deliberate** — warm off-white (`#F7F5F0`), Instrument
  Serif (headings) / DM Sans (body) / DM Mono (data/numbers), navy `#1A2E4A` +
  mint `#00C896`. Match the `:root` variables; don't reskin.

## Commands
- **Preview:** serve the repo root (a `.claude/launch.json` exists) — it hits live
  Supabase.
- **Run a job locally:** `cp scripts/.env.example scripts/.env`, fill it, then
  `node scripts/sync.js` | `scripts/process.js` | `scripts/alert.js`
  (`DRY_RUN=true` to skip alert webhooks; `BATCH_SIZE` to limit processing).
- **Deploy:** push to `main` → Netlify auto-publishes (static, no build).

## Verify
- Load `index.html`; confirm tabs render and Supabase reads succeed (watch console).
- For scripts: run with `DRY_RUN` / small `BATCH_SIZE`. Note there is **no separate
  test DB** — script writes hit the live `canoe_calls`, so tread carefully.

## Session hygiene
- End each session: append a dated line to `HISTORY.md` (what changed, why, next).
