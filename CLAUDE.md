# AI Agent Registry — Buyerlink Calls

Internal dashboard + data pipeline for BL Calls' AI phone agents: syncs call data
from Canoe (RingPartner Exchange), AI-analyzes transcripts for outcome +
compliance, and surfaces it in a single-page registry. Live on Netlify.

## Architecture (map)
- **`index.html`** — the ENTIRE frontend. One file, vanilla HTML/CSS/JS, **no
  framework, no build step.** Tabs: Agents, Insights, Call Reporting, Compliance,
  LLM training. Talks directly to Supabase REST via the `sbFetch()` helper; can
  dispatch the `process.yml` GitHub Action ("run now").
- **`scripts/`** — Node jobs, run by GitHub Actions on a schedule:
  - `sync.js` — daily 00:00 UTC — two-pass Canoe → Supabase `canoe_calls`
    (pass 1 upsert calls; pass 2 patch transcription/duration/outcome).
  - `process.js` — Mon/Wed/Fri 08:00 UTC — AI analysis of unprocessed calls
    (OpenRouter/Anthropic, default model `anthropic/claude-sonnet-4-6`); writes
    outcome + compliance flags back to the row.
  - `alert.js` — Mon/Wed/Fri 14:00 UTC — compliance/perf alerts to account
    managers via the ASCND webhook.
- **`supabase/`** — `migrations/` (001–015: compliance, RLS, ai_prompts,
  outcome_weights, model_tests, `canoe_calls` + ascnd/plt columns,
  training_examples, alert_log, indexes) and `functions/admin-users` (edge fn).
  Project ref: `wvnfcxhbztnefhzjhfgg`.
- **`.github/workflows/`** — `sync.yml`, `process.yml`, `alert.yml` (the crons above).

## Conventions & gotchas (do not break)
- **It's one static file.** Edit `index.html` directly. Don't add a build tool,
  framework, or bundler without a real reason — Netlify serves the repo root as-is.
- **Frontend uses the Supabase *publishable* key** (client-safe, RLS-gated — see
  `migrations/002_rls.sql`). The **service-role key is never in the client** (the
  Settings admin UI takes it session-only; scripts read it from env). Never commit
  a service key.
- **Secrets live in `scripts/.env` (gitignored) + GitHub Actions secrets** — never
  commit: `CANOE_API_KEY`, `SUPABASE_SERVICE_KEY`, `OPENROUTER_API_KEY`,
  `ANTHROPIC_API_KEY`, `ASCND_ALERT_WEBHOOK_URL`. Add new ones in both places.
- **DB changes = a new numbered migration** in `supabase/migrations/` (next is
  `016_…`). Don't edit existing migrations.
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
