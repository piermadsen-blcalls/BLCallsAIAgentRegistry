// alert.js — Twice-weekly compliance + performance digest to account managers via the ASCND webhook.
// Reads canoe_calls, groups by each manager's assigned accounts, lists the compliance flags each
// account's calls got since the last digest, plus bidirectional performance moves, and links each
// account to its flagged calls on the dashboard. Emails HTML through the ASCND (GHL) webhook.

// Local dev convenience: load scripts/.env if present (gitignored).
// In GitHub Actions this file doesn't exist and real secrets are used.
(function loadDotEnv() {
  const fs = require('fs'), path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_URL   = process.env.ASCND_ALERT_WEBHOOK_URL;
const DRY_RUN       = process.env.DRY_RUN === 'true';      // skip webhook POSTs
const MANAGER_ID     = process.env.ALERT_MANAGER_ID || '';     // limit to one manager by id (testing)
const MANAGER_NAME   = process.env.ALERT_MANAGER_NAME || '';    // limit to one manager by name (testing)
const OVERRIDE_EMAIL = process.env.ALERT_OVERRIDE_EMAIL || '';  // send ALL output here instead of the manager (preview)
const ALL_MANAGERS   = process.env.ALERT_ALL_MANAGERS === 'true'; // preview: include EVERY manager with accounts, ignoring the enabled flag (requires OVERRIDE_EMAIL)
const WINDOW_DAYS    = parseInt(process.env.ALERT_WINDOW_DAYS || '', 10); // force window to last N days (testing)
const WINDOW_FROM    = process.env.ALERT_WINDOW_FROM || '';    // explicit window start, ISO/date (testing)
const WINDOW_TO      = process.env.ALERT_WINDOW_TO   || '';    // explicit window end, ISO/date (testing)
const DASHBOARD_URL  = (process.env.DASHBOARD_URL || '').replace(/\/$/, ''); // base URL for deep links

// ── Compliance flag taxonomy (must match scripts/process.js + the active ai_prompts row) ──
const FLAG_LABELS = {
  outbound_dial:        'Outbound dial',
  facebook_marketplace: 'Facebook Marketplace',
  angry_caller:         'Angry caller',
  wrong_business:       'Wrong business',
  duplicate_caller:     'Duplicate caller',
  geo_mismatch:         'Geo mismatch',
  coached_call:         'Coached call',
  suspicious_call:      'Suspicious call',
};
const AI_FLAGS = ['outbound_dial', 'facebook_marketplace', 'angry_caller', 'wrong_business', 'duplicate_caller', 'geo_mismatch', 'coached_call'];

const BOOTSTRAP_DAYS = 7;  // first-ever digest window when there's no last_sent_at

// ── Outliers: an account's flag rate vs the baseline for the verticals its calls are in ──
const OUTLIER_Z = 3;              // z-score at or above which a flag makes the account an outlier
const OUTLIER_MIN_FLAGS = 3;      // ...and only with at least this many calls carrying that flag
const BASELINE_MIN_SCORED = 200;  // verticals with fewer scored calls in the window use the network rate

// ── Supabase helper ──────────────────────────────────────────────────────────
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=minimal',
      ...(options.headers || {})
    }
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Supabase ${res.status}: ${t}`); }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const toDate = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function dateRangeLabel(fromDate, toDate) {
  const fmt = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(fromDate)} – ${fmt(toDate)}`;
}

// Compliance flags present on a call: AI flags from the jsonb array + the suspicious_call boolean.
function callFlags(c) {
  const arr = (Array.isArray(c.flags) ? c.flags : []).filter(f => AI_FLAGS.includes(f));
  if (c.suspicious_call) arr.push('suspicious_call');
  return arr;
}

// Flags can only land on AI-scored calls, so scored calls are the rate denominator.
// (A flagged call always counts, so no flag is ever dropped.)
const isScored = c => !!c.ai_processed_at || callFlags(c).length > 0;

// Baseline flag rates from every scored call in the window (all accounts, not just one
// manager's): per vertical, plus the whole network as the fallback for thin verticals.
function buildBaseline(calls) {
  const blank = () => ({ scored: 0, counts: {} });
  const base = { network: blank(), verticals: {} };
  for (const c of calls) {
    if (!isScored(c)) continue;
    const v = base.verticals[c.vertical_name || ''] || (base.verticals[c.vertical_name || ''] = blank());
    for (const b of [base.network, v]) {
      b.scored++;
      for (const f of callFlags(c)) b.counts[f] = (b.counts[f] || 0) + 1;
    }
  }
  return base;
}
function baselineRate(base, vertical, flag) {
  const v = base.verticals[vertical || ''];
  const b = v && v.scored >= BASELINE_MIN_SCORED ? v : base.network;
  return b.scored ? (b.counts[flag] || 0) / b.scored : 0;
}

// Tally each account's flags, scored calls and, per flag, the count its verticals'
// baselines would predict (sum of per-call rates) and that count's binomial variance.
function tallyAccounts(calls, advSet, pubSet, base) {
  const flagList = [...AI_FLAGS, 'suspicious_call'];
  const curr = {};
  for (const c of calls) {
    const isAdv = advSet.has(c.advertiser_name);
    const name  = isAdv ? c.advertiser_name : c.publisher_name;
    if (!name || !isScored(c)) continue;
    if (!curr[name]) curr[name] = { type: isAdv ? 'advertiser' : 'publisher', flagCounts: {}, flaggedCalls: 0, scored: 0, expected: {}, variance: {} };
    const a = curr[name];
    a.scored++;
    for (const f of flagList) {
      const p = baselineRate(base, c.vertical_name, f);
      a.expected[f] = (a.expected[f] || 0) + p;
      a.variance[f] = (a.variance[f] || 0) + p * (1 - p);
    }
    const fl = callFlags(c);
    if (!fl.length) continue;
    a.flaggedCalls++;
    for (const f of fl) a.flagCounts[f] = (a.flagCounts[f] || 0) + 1;
  }
  // Compliance-only: accounts with no flagged calls are left out.
  for (const name of Object.keys(curr)) if (!curr[name].flaggedCalls) delete curr[name];
  return curr;
}

// One entry per flagged account with a reason per flag. Outliers first (worst z-score
// first), then everyone else by flagged-call count.
function rankAccounts(curr) {
  const pct = x => `${Math.round(x * 100)}%`;
  const alerted = Object.entries(curr).map(([name, c]) => {
    const reasons = [];
    for (const f of [...AI_FLAGS, 'suspicious_call']) {
      const n = c.flagCounts[f];
      if (!n) continue;
      const rate = n / c.scored, baseRate = c.expected[f] / c.scored;
      const z = c.variance[f] > 0 ? (n - c.expected[f]) / Math.sqrt(c.variance[f]) : null;
      const outlier = z != null && z >= OUTLIER_Z && n >= OUTLIER_MIN_FLAGS;
      const label = `${n} × ${FLAG_LABELS[f]}` + (outlier ? ` (${pct(rate)} of ${c.scored} scored calls vs ${pct(baseRate)} baseline)` : '');
      reasons.push({ flag: f, n, rate, baseRate, z, outlier, label });
    }
    reasons.sort((x, y) => (y.outlier - x.outlier) || ((y.z ?? -Infinity) - (x.z ?? -Infinity)));
    const outliers = reasons.filter(r => r.outlier);
    return { name, type: c.type, curr: c, reasons, outlier: outliers.length > 0, worstZ: outliers.length ? outliers[0].z : null };
  });
  return alerted.sort((a, b) =>
    (b.outlier - a.outlier) || (a.outlier ? b.worstZ - a.worstZ : 0) || (b.curr.flaggedCalls - a.curr.flaggedCalls));
}

// Deep link into the merged Calls tab, pre-filtered to this account's flagged calls for the period.
function deepLink(account, type, fromDate, toISO) {
  if (!DASHBOARD_URL) return '';
  const q = new URLSearchParams({ tab: 'calls', account, type, from: fromDate, to: toISO, flagged: '1' });
  return `${DASHBOARD_URL}/?${q.toString()}`;  // query string, not #fragment — email clients strip fragments
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  if (!WEBHOOK_URL && !DRY_RUN)       throw new Error('Missing ASCND_ALERT_WEBHOOK_URL (set DRY_RUN=true to skip)');
  if (ALL_MANAGERS && !OVERRIDE_EMAIL) throw new Error('ALERT_ALL_MANAGERS is preview-only — set ALERT_OVERRIDE_EMAIL too, so it never mass-mails real managers.');
  if (!DASHBOARD_URL) console.warn('DASHBOARD_URL not set — per-account links will be omitted.');

  const [managers, alertRows, assignments] = await Promise.all([
    sb('account_managers?select=*'),
    sb('manager_alert_settings?enabled=eq.true&select=*'),
    sb('account_manager_assignments?select=*')
  ]);

  if (!ALL_MANAGERS && (!alertRows || !alertRows.length)) { console.log('No managers have alerts enabled. Done.'); return; }

  const mgrMap = {};
  (managers || []).forEach(m => { mgrMap[m.id] = m; });

  // manager_id -> { advertisers:Set, publishers:Set }
  const mgrAccounts = {};
  (assignments || []).forEach(a => {
    if (!mgrAccounts[a.manager_id]) mgrAccounts[a.manager_id] = { advertisers: new Set(), publishers: new Set() };
    (a.account_type === 'advertiser' ? mgrAccounts[a.manager_id].advertisers : mgrAccounts[a.manager_id].publishers).add(a.account_name);
  });

  // Normal: only managers with alerts enabled. Preview (ALL_MANAGERS): every manager
  // that has assigned accounts, regardless of enabled / last_sent (window comes from the
  // override inputs). Only reachable with OVERRIDE_EMAIL set (guarded above).
  let settings = ALL_MANAGERS
    ? (managers || [])
        .filter(m => { const a = mgrAccounts[m.id]; return a && (a.advertisers.size || a.publishers.size); })
        .map(m => ({ manager_id: m.id, last_sent_at: null }))
    : alertRows;
  if (MANAGER_ID) settings = settings.filter(s => s.manager_id === MANAGER_ID);
  else if (MANAGER_NAME) settings = settings.filter(s => (mgrMap[s.manager_id]?.manager_name || '').toLowerCase() === MANAGER_NAME.toLowerCase());
  let sentCount = 0;

  for (const s of settings) {
    const mgr = mgrMap[s.manager_id];
    if (!mgr) { console.warn(`Manager ${s.manager_id} not found, skipping.`); continue; }

    const accounts = mgrAccounts[s.manager_id];
    if (!accounts || (!accounts.advertisers.size && !accounts.publishers.size)) {
      console.log(`${mgr.manager_name}: no assigned accounts, skipping.`); continue;
    }
    const advSet = accounts.advertisers, pubSet = accounts.publishers;

    // Window = since the last digest for this manager; first-ever send bootstraps to last 7 days.
    const to   = WINDOW_TO ? new Date(WINDOW_TO) : new Date();
    const from = WINDOW_FROM ? new Date(WINDOW_FROM)
      : WINDOW_DAYS > 0 ? new Date(to.getTime() - WINDOW_DAYS * 86400000)
      : (s.last_sent_at ? new Date(s.last_sent_at) : new Date(to.getTime() - BOOTSTRAP_DAYS * 86400000));
    if (from >= to) { console.log(`${mgr.manager_name}: last digest is newer than now, skipping.`); continue; }
    const fromDate = toDate(from), toDate_ = toDate(to);
    console.log(`\n${mgr.manager_name} (${fromDate} → ${toDate_})`);

    // Returns this manager's calls plus the baseline built from every call in the window.
    async function fetchWindow(fromTs, toTs) {
      const PAGE = 1000; let results = [], all = [], offset = 0;
      while (true) {
        const q = `canoe_calls?select=id,publisher_name,advertiser_name,vertical_name,flags,suspicious_call,ai_processed_at` +
          `&created_at=gte.${fromTs.toISOString()}&created_at=lte.${toTs.toISOString()}&is_test=eq.false`;
        const batch = await sb(q, { headers: { 'Range-Unit': 'items', 'Range': `${offset}-${offset + PAGE - 1}` } });
        if (!batch || !batch.length) break;
        all = all.concat(batch);
        results = results.concat(batch.filter(c => advSet.has(c.advertiser_name) || pubSet.has(c.publisher_name)));
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      return { calls: results, baseline: buildBaseline(all) };
    }

    const { calls: currCalls, baseline } = await fetchWindow(from, to);
    console.log(`  ${currCalls.length} calls in window`);
    if (!currCalls.length) continue;

    const alerted = rankAccounts(tallyAccounts(currCalls, advSet, pubSet, baseline));
    const outlierCount = alerted.filter(a => a.outlier).length;

    if (!alerted.length) { console.log('  Nothing to report → no email.'); continue; }
    console.log(`  ${alerted.length} account(s), ${outlierCount} outlier(s):`);
    alerted.forEach(a => console.log(`    ${a.outlier ? '[outlier] ' : ''}${a.name}: ${a.reasons.map(r => r.label).join(', ')}`));

    const recipient = OVERRIDE_EMAIL || mgr.manager_email;
    if (!recipient) { console.log(`  ${mgr.manager_name}: no email on file → skip.`); continue; }

    // Dedup on (manager, period) — skipped for override-email previews so you can re-send.
    if (!OVERRIDE_EMAIL) {
      const dup = await sb(`alert_log?manager_id=eq.${s.manager_id}&period_start=eq.${fromDate}&select=id&limit=1`).catch(() => null);
      if (dup && dup.length) { console.log('  Already sent for this period → skip.'); continue; }
    }

    const periodLabel = dateRangeLabel(fromDate, toDate_);
    const toISOFull   = to.toISOString().slice(0, 19);
    const subject     = `Compliance digest: `
      + (outlierCount ? `${outlierCount} outlier${outlierCount !== 1 ? 's' : ''}, ` : '')
      + `${alerted.length} account${alerted.length !== 1 ? 's' : ''} flagged — ${periodLabel}`
      + (OVERRIDE_EMAIL ? ` [preview: ${mgr.manager_name}]` : '');
    const emailHtml   = buildEmail(mgr, alerted, periodLabel, fromDate, toISOFull);

    const payload = {
      to_email: recipient, to_name: mgr.manager_name, first_name: mgr.manager_name.split(' ')[0],
      subject, period_label: periodLabel, period_start: fromDate, period_end: toDate_,
      accounts: alerted.map(a => ({
        name: a.name, type: a.type, flagged_calls: a.curr.flaggedCalls,
        scored_calls: a.curr.scored, outlier: a.outlier,
        flags: a.curr.flagCounts,
        reasons: a.reasons.map(r => r.label),
        link: deepLink(a.name, a.type, fromDate, toISOFull),
      })),
      email_body_html: emailHtml,
    };

    if (DRY_RUN) {
      console.log(`  DRY RUN — would email ${payload.to_email}: ${subject}`);
    } else {
      const res = await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) { console.error(`  Webhook failed ${res.status}: ${await res.text()}`); continue; }
      console.log(`  ✓ Sent to ${payload.to_email}${OVERRIDE_EMAIL ? ` (preview of ${mgr.manager_name})` : ''}`);
    }

    // Don't record state (alert_log / last_sent_at) for override-email previews.
    if (!OVERRIDE_EMAIL) {
      await sb('alert_log', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({
          manager_id: s.manager_id, manager_email: mgr.manager_email,
          period_start: fromDate, period_end: toDate_,
          total_calls: currCalls.length, flagged_count: alerted.length, dry_run: DRY_RUN
        })
      }).catch(e => console.warn('  Could not write alert_log:', e.message));

      if (!DRY_RUN) await sb(`manager_alert_settings?manager_id=eq.${s.manager_id}`, {
        method: 'PATCH', body: JSON.stringify({ last_sent_at: to.toISOString() })
      }).catch(e => console.warn('  Could not update last_sent_at:', e.message));
    }

    sentCount++;
  }

  console.log(`\nDone. Sent ${sentCount} digest${sentCount !== 1 ? 's' : ''}.`);
}

// ── Email builder — AM → account → flags (+ perf), each account links to its flagged calls ──
function buildEmail(mgr, alerted, periodLabel, fromDate, toISOFull) {
  const firstName = mgr.manager_name.split(' ')[0];
  const S = 'font-family:Arial,sans-serif;';
  const navy = '#1A2E4A', coral = '#993C1D', mint = '#0F6E56', muted = '#6B6760', border = '#E0DDD6', bg = '#F7F5F0';

  const outliers = alerted.filter(a => a.outlier), rest = alerted.filter(a => !a.outlier);
  const plural = (n, w) => `${n} ${w}${n !== 1 ? 's' : ''}`;

  // Outliers: full card, outlier flags first and bold with rate vs baseline.
  const cards = outliers.map(a => {
    const typeLabel = a.type === 'advertiser' ? 'Advertiser' : 'Publisher';
    const rows = a.reasons.map(r =>
      `<tr><td style="${S}padding:5px 0;font-size:13px;color:${r.outlier ? coral : muted}${r.outlier ? ';font-weight:600' : ''}">⚑ ${r.label}</td></tr>`
    ).join('');
    const link = deepLink(a.name, a.type, fromDate, toISOFull);
    const linkHtml = link
      ? `<div style="padding:8px 14px;border-top:1px solid ${border}"><a href="${link}" style="${S}font-size:12px;color:${mint};text-decoration:none;font-weight:600">View flagged calls →</a></div>`
      : '';
    return `<div style="margin-bottom:12px;border:1px solid ${border};border-radius:6px;overflow:hidden">
      <div style="${S}background:#fff;padding:10px 14px;border-bottom:1px solid ${border}">
        <span style="${S}font-size:14px;font-weight:600;color:${navy}">${a.name}</span>
        <span style="${S}font-size:10px;color:${muted};text-transform:uppercase;letter-spacing:0.4px;float:right;margin-top:3px">${typeLabel} · ${plural(a.curr.flaggedCalls, 'flagged call')}</span>
      </div>
      <div style="background:${bg};padding:10px 14px"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table></div>
      ${linkHtml}
    </div>`;
  }).join('');

  // Everyone else: one line each.
  const restRows = rest.map(a => {
    const link = deepLink(a.name, a.type, fromDate, toISOFull);
    const name = link ? `<a href="${link}" style="color:${navy};text-decoration:none;font-weight:600">${a.name}</a>` : `<span style="font-weight:600;color:${navy}">${a.name}</span>`;
    return `<tr><td style="${S}padding:7px 0;border-bottom:1px solid ${border};font-size:13px">${name}
      <div style="${S}font-size:12px;color:${muted};margin-top:2px">${a.type === 'advertiser' ? 'Advertiser' : 'Publisher'} · ${a.reasons.map(r => r.label).join(', ')}</div></td></tr>`;
  }).join('');

  const section = (title, note) =>
    `<h3 style="${S}font-size:14px;font-weight:600;color:${navy};margin:0 0 4px">${title}</h3><p style="${S}font-size:12px;color:${muted};margin:0 0 12px;line-height:1.5">${note}</p>`;
  const outlierHtml = outliers.length
    ? section(`Outliers (${outliers.length})`, `Flag rate well above the baseline for the verticals these calls are in (z ≥ ${OUTLIER_Z}, ${OUTLIER_MIN_FLAGS}+ calls). Start here.`) + cards
    : section('Outliers (0)', 'No account’s flag rate stands out from its vertical baseline this period.');
  const restHtml = rest.length
    ? section(`Other flagged accounts (${rest.length})`, 'Flags within the normal range for the vertical.')
      + `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${restRows}</table>`
    : '';

  return `<div style="${S}max-width:600px;margin:0 auto;color:#1A1816">
    <h2 style="${S}font-size:22px;font-weight:400;margin:0 0 6px">Compliance digest — ${plural(outliers.length, 'outlier')}, ${plural(alerted.length, 'account')} flagged</h2>
    <p style="${S}font-size:13px;color:${muted};margin:0 0 20px;line-height:1.6">Hi ${firstName}, here are the compliance flags on your accounts for <strong>${periodLabel}</strong>, outliers first.</p>
    <div style="margin-bottom:20px">${outlierHtml}</div>
    ${restHtml ? `<div style="margin-bottom:20px">${restHtml}</div>` : ''}
    <p style="${S}font-size:12px;color:${muted};line-height:1.6;border-top:1px solid ${border};padding-top:14px;margin-top:14px">Generated automatically by the Buyerlink Calls AI Agent Registry.</p>
  </div>`;
}

if (require.main === module) {
  main().catch(e => { console.error('Alert script failed:', e.message); process.exit(1); });
}

module.exports = { buildBaseline, tallyAccounts, rankAccounts, buildEmail };
