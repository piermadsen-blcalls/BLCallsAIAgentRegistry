// check_anon_access.js — What can someone do with only the publishable key from index.html (no
// login)? Run after migration 063 and the sign-up toggle; every line should say PASS.
// Read-only and count-only: tables get a HEAD request (row count in a header, never rows), the
// read-only RPCs a GET (body discarded), and Auth's public settings are read. Nothing is written
// and no function that writes is called (063's SQL test checks those grants instead).
// Usage: node scripts/check_anon_access.js   (exit code 1 if anything is still open)

const fs = require('fs'), path = require('path');

// The URL and key the live page ships with, read from index.html so this tests exactly that.
function pageConfig() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/supabaseUrl:\s*'([^']+)',\s*supabaseKey:\s*'([^']+)'/);
  if (!m) throw new Error('CONFIG not found in index.html');
  return { url: m[1], key: m[2] };
}

// Every table in public on 2026-11-13 (063). Call data first.
const TABLES = [
  'canoe_calls', 'hl_call_data', 'ascnd_transcript_import', 'voiceai_import', 'agent_calls_raw', 'call_reviews',
  'call_corrections', 'training_examples', 'model_test_results', 'agent_call_evals',
  'account_managers', 'account_manager_assignments', 'manager_alert_settings', 'ai_prompts', 'outcome_weights',
  'agents', 'agent_ivr_aliases', 'agent_targets', 'agent_test_calls', 'agent_canoe_ivr_ids', 'agent_changes',
  'agent_reviews', 'agent_review_assignments', 'agent_updates', 'agent_eval_jobs', 'alert_log', 'gemini_batch_jobs',
  'model_tests', 'new_ivr_detections', 'insights_daily', 'agent_metrics_daily', 'agent_counterparty_daily',
  'outcome_score_daily', 'rollup_refresh_requests', 'sync_state', 'ascnd_pairing_backfill_058',
  'ivr_development', 'ivr_recordings', 'ivr_signoffs',
  'caller_daily', 'outcome_daily',   // 064
  'flag_daily',                      // 065
];
// Read-only RPCs, as [name, query-string arguments], called with GET. HEAD is not a test here:
// PostgREST answers HEAD on an RPC with arguments 200 without running it (2026-11-13). The two
// argument-free ones bypass RLS (SECURITY DEFINER); the 064/065 dashboard reads get a one-day range.
const RPCS = [
  ['get_distinct_verticals', ''], ['get_distinct_accounts', ''],
  ...['dashboard_summary', 'dashboard_outcomes', 'dashboard_quality', 'dashboard_trend', 'dashboard_cpa',
     'dashboard_flags', 'dashboard_flag_trend']
    .map(fn => [fn, 'from_day=2026-11-01&to_day=2026-11-01']),
];

// PASS = no access (401/403), or a table/RPC that doesn't exist (404). A 200 is only a PASS for a
// table that returns 0 rows; any row count means the key can read data.
function verdict(status, count) {
  if (status === 401 || status === 403 || status === 404) return ['PASS', `${status} (no access)`];
  if (status >= 200 && status < 300) return count === 0 ? ['PASS', `${status}, 0 rows visible`] : ['FAIL', `${status}, ${count ?? '?'} rows readable`];
  return ['FAIL', `${status} (unexpected; check the API logs)`];
}

async function main() {
  const { url, key } = pageConfig();
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  let failed = 0;
  const report = (what, [result, detail]) => { if (result !== 'PASS') failed++; console.log(`${result}  ${what.padEnd(36)} ${detail}`); };

  console.log(`Anonymous access check: ${url} (publishable key from index.html)\n`);
  for (const t of TABLES) {
    const res = await fetch(`${url}/rest/v1/${t}?select=*`, { method: 'HEAD', headers: { ...headers, Prefer: 'count=exact' } });
    const total = (res.headers.get('content-range') || '').split('/')[1];
    report(`table ${t}`, verdict(res.status, total && total !== '*' ? Number(total) : null));
  }
  for (const [fn, args] of RPCS) {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}${args ? `?${args}` : ''}`, { headers });
    await res.body?.cancel();   // only the status matters
    report(`rpc ${fn}`, res.ok ? ['FAIL', `${res.status} (anon can run it)`] : verdict(res.status, null));
  }
  const settings = await (await fetch(`${url}/auth/v1/settings`, { headers })).json();
  report('auth: new sign-ups', settings.disable_signup === true
    ? ['PASS', 'disabled']
    : ['FAIL', 'open (Dashboard > Authentication > Sign In / Providers > "Allow new users to sign up")']);

  console.log(`\n${failed ? `${failed} check(s) FAILED` : 'All checks passed: the publishable key alone reads nothing.'}`);
  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });

module.exports = { verdict, pageConfig, TABLES };
