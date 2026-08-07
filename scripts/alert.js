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
const MANAGER_ID    = process.env.ALERT_MANAGER_ID || '';  // limit to one manager (testing)
const DASHBOARD_URL = (process.env.DASHBOARD_URL || '').replace(/\/$/, ''); // base URL for deep links

// ── Compliance flag taxonomy (must match scripts/process.js + the active ai_prompts row) ──
const FLAG_LABELS = {
  outbound_dial:        'Outbound dial',
  facebook_marketplace: 'Facebook Marketplace',
  angry_caller:         'Angry caller',
  wrong_business:       'Wrong business',
  duplicate_caller:     'Duplicate caller',
  geo_mismatch:         'Geo mismatch',
  suspicious_call:      'Suspicious call',
};
const AI_FLAGS = ['outbound_dial', 'facebook_marketplace', 'angry_caller', 'wrong_business', 'duplicate_caller', 'geo_mismatch'];

// Bidirectional performance thresholds (drops AND surges), vs the equal-length prior window.
const VOL_THRESHOLD  = 0.30;  // ±30% call volume
const REV_THRESHOLD  = 0.20;  // ±20% revenue
const CONV_THRESHOLD = 10;    // ±10 percentage points connect rate
const MIN_PRIOR_CALLS = 10;   // don't flag perf on tiny prior samples
const BOOTSTRAP_DAYS  = 7;    // first-ever digest window when there's no last_sent_at

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

// Deep link into the Compliance tab, pre-filtered to this account's flagged calls for the period.
function deepLink(account, type, fromDate, toISO) {
  if (!DASHBOARD_URL) return '';
  const q = new URLSearchParams({ view: 'compliance', account, type, from: fromDate, to: toISO, flagged: '1' });
  return `${DASHBOARD_URL}/#${q.toString()}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  if (!WEBHOOK_URL && !DRY_RUN)       throw new Error('Missing ASCND_ALERT_WEBHOOK_URL (set DRY_RUN=true to skip)');
  if (!DASHBOARD_URL) console.warn('DASHBOARD_URL not set — per-account links will be omitted.');

  const [managers, alertRows, assignments] = await Promise.all([
    sb('account_managers?select=*'),
    sb('manager_alert_settings?enabled=eq.true&select=*'),
    sb('account_manager_assignments?select=*')
  ]);

  if (!alertRows || !alertRows.length) { console.log('No managers have alerts enabled. Done.'); return; }

  const mgrMap = {};
  (managers || []).forEach(m => { mgrMap[m.id] = m; });

  // manager_id -> { advertisers:Set, publishers:Set }
  const mgrAccounts = {};
  (assignments || []).forEach(a => {
    if (!mgrAccounts[a.manager_id]) mgrAccounts[a.manager_id] = { advertisers: new Set(), publishers: new Set() };
    (a.account_type === 'advertiser' ? mgrAccounts[a.manager_id].advertisers : mgrAccounts[a.manager_id].publishers).add(a.account_name);
  });

  const settings = MANAGER_ID ? alertRows.filter(s => s.manager_id === MANAGER_ID) : alertRows;
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
    const to   = new Date();
    const from = s.last_sent_at ? new Date(s.last_sent_at) : new Date(to.getTime() - BOOTSTRAP_DAYS * 86400000);
    if (from >= to) { console.log(`${mgr.manager_name}: last digest is newer than now, skipping.`); continue; }
    // Equal-length prior window for the perf comparison.
    const durMs     = to.getTime() - from.getTime();
    const priorFrom = new Date(from.getTime() - durMs);
    const priorTo   = from;
    const fromDate = toDate(from), toDate_ = toDate(to);

    console.log(`\n${mgr.manager_name} (${fromDate} → ${toDate_})`);

    async function fetchWindow(fromTs, toTs) {
      const PAGE = 1000; let results = [], offset = 0;
      while (true) {
        const q = `canoe_calls?select=id,created_at,publisher_name,advertiser_name,connect_duration,result,advertiser_payin,flags,suspicious_call,vertical_name` +
          `&created_at=gte.${fromTs.toISOString()}&created_at=lte.${toTs.toISOString()}&is_test=eq.false`;
        const batch = await sb(q, { headers: { 'Range-Unit': 'items', 'Range': `${offset}-${offset + PAGE - 1}` } });
        if (!batch || !batch.length) break;
        results = results.concat(batch.filter(c => advSet.has(c.advertiser_name) || pubSet.has(c.publisher_name)));
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      return results;
    }

    const [currCalls, priorCalls] = await Promise.all([fetchWindow(from, to), fetchWindow(priorFrom, priorTo)]);
    console.log(`  ${currCalls.length} calls (current) / ${priorCalls.length} calls (prior)`);
    if (!currCalls.length && !priorCalls.length) continue;

    function aggregate(calls) {
      const map = {};
      for (const c of calls) {
        const isAdv = advSet.has(c.advertiser_name);
        const name  = isAdv ? c.advertiser_name : c.publisher_name;
        const type  = isAdv ? 'advertiser' : 'publisher';
        if (!name) continue;
        if (!map[name]) map[name] = { type, total: 0, connected: 0, revenue: 0, flagCounts: {}, flaggedCalls: 0 };
        const e = map[name];
        e.total++;
        if ((c.connect_duration || 0) > 0 || (c.result || '').toLowerCase().includes('connect')) e.connected++;
        e.revenue += c.advertiser_payin || 0;
        const fl = callFlags(c);
        if (fl.length) e.flaggedCalls++;
        for (const f of fl) e.flagCounts[f] = (e.flagCounts[f] || 0) + 1;
      }
      return map;
    }

    const curr = aggregate(currCalls), prior = aggregate(priorCalls);
    const alerted = [];

    for (const name of new Set([...Object.keys(curr), ...Object.keys(prior)])) {
      const c = curr[name]  || { type: advSet.has(name) ? 'advertiser' : 'publisher', total: 0, connected: 0, revenue: 0, flagCounts: {}, flaggedCalls: 0 };
      const p = prior[name] || { total: 0, connected: 0, revenue: 0 };
      const reasons = [];

      // Every compliance flag the account's calls got this period (all flags, no tiers).
      for (const f of [...AI_FLAGS, 'suspicious_call']) {
        const n = c.flagCounts[f];
        if (n) reasons.push({ kind: 'flag', label: `${n} × ${FLAG_LABELS[f]}` });
      }

      // Bidirectional performance moves vs the equal-length prior window.
      if (p.total >= MIN_PRIOR_CALLS) {
        const dv = (c.total - p.total) / p.total;
        if (Math.abs(dv) >= VOL_THRESHOLD)
          reasons.push({ kind: 'perf', label: `Volume ${dv > 0 ? 'up' : 'down'} ${Math.round(Math.abs(dv) * 100)}%`, detail: `${c.total} vs ${p.total} prior` });
        const cc = c.total ? c.connected / c.total : 0, pc = p.total ? p.connected / p.total : 0;
        const dpp = (cc - pc) * 100;
        if (Math.abs(dpp) >= CONV_THRESHOLD)
          reasons.push({ kind: 'perf', label: `Conversion ${dpp > 0 ? 'up' : 'down'} ${Math.abs(dpp).toFixed(1)}pp`, detail: `${(cc*100).toFixed(1)}% vs ${(pc*100).toFixed(1)}% prior` });
      }
      if (p.revenue >= 100) {
        const dr = (c.revenue - p.revenue) / p.revenue;
        if (Math.abs(dr) >= REV_THRESHOLD)
          reasons.push({ kind: 'perf', label: `Revenue ${dr > 0 ? 'up' : 'down'} ${Math.round(Math.abs(dr) * 100)}%`, detail: `$${Math.round(c.revenue)} vs $${Math.round(p.revenue)} prior` });
      }

      if (reasons.length) alerted.push({ name, type: c.type, curr: c, reasons });
    }

    // Accounts with compliance flags first, then perf-only.
    alerted.sort((a, b) => (b.curr.flaggedCalls > 0) - (a.curr.flaggedCalls > 0) || b.curr.flaggedCalls - a.curr.flaggedCalls);

    if (!alerted.length) { console.log('  Nothing to report → no email.'); continue; }
    console.log(`  ${alerted.length} account(s):`);
    alerted.forEach(a => console.log(`    ${a.name}: ${a.reasons.map(r => r.label).join(', ')}`));

    // Skip if we already logged a digest starting at this from-date for this manager.
    const dup = await sb(`alert_log?manager_id=eq.${s.manager_id}&period_start=eq.${fromDate}&select=id&limit=1`).catch(() => null);
    if (dup && dup.length) { console.log('  Already sent for this period → skip.'); continue; }

    const periodLabel = dateRangeLabel(fromDate, toDate_);
    const toISOFull   = to.toISOString().slice(0, 19);
    const subject     = `Compliance digest: ${alerted.length} account${alerted.length !== 1 ? 's' : ''} flagged — ${periodLabel}`;
    const emailHtml   = buildEmail(mgr, alerted, periodLabel, fromDate, toISOFull);

    const payload = {
      to_email: mgr.manager_email, to_name: mgr.manager_name, first_name: mgr.manager_name.split(' ')[0],
      subject, period_label: periodLabel, period_start: fromDate, period_end: toDate_,
      accounts: alerted.map(a => ({
        name: a.name, type: a.type, calls: a.curr.total, flagged_calls: a.curr.flaggedCalls,
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
      console.log(`  ✓ Sent to ${mgr.manager_email}`);
    }

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

    sentCount++;
  }

  console.log(`\nDone. Sent ${sentCount} digest${sentCount !== 1 ? 's' : ''}.`);
}

// ── Email builder — AM → account → flags (+ perf), each account links to its flagged calls ──
function buildEmail(mgr, alerted, periodLabel, fromDate, toISOFull) {
  const firstName = mgr.manager_name.split(' ')[0];
  const S = 'font-family:Arial,sans-serif;';
  const navy = '#1A2E4A', coral = '#993C1D', mint = '#0F6E56', muted = '#6B6760', border = '#E0DDD6', bg = '#F7F5F0';

  const cards = alerted.map(a => {
    const typeLabel = a.type === 'advertiser' ? 'Advertiser' : 'Publisher';
    const rows = a.reasons.map(r => {
      const isFlag = r.kind === 'flag';
      return `<tr>
        <td style="${S}padding:5px 12px 5px 0;font-size:13px;color:${isFlag ? coral : muted}">${isFlag ? '⚑' : '↕'} ${r.label}</td>
        <td style="${S}padding:5px 0;font-size:12px;color:${muted};text-align:right">${r.detail || ''}</td>
      </tr>`;
    }).join('');
    const link = a.reasons.some(r => r.kind === 'flag') ? deepLink(a.name, a.type, fromDate, toISOFull) : '';
    const linkHtml = link
      ? `<div style="padding:8px 14px;border-top:1px solid ${border}"><a href="${link}" style="${S}font-size:12px;color:${mint};text-decoration:none;font-weight:600">View flagged calls →</a></div>`
      : '';
    return `<div style="margin-bottom:12px;border:1px solid ${border};border-radius:6px;overflow:hidden">
      <div style="${S}background:#fff;padding:10px 14px;border-bottom:1px solid ${border}">
        <span style="${S}font-size:14px;font-weight:600;color:${navy}">${a.name}</span>
        <span style="${S}font-size:10px;color:${muted};text-transform:uppercase;letter-spacing:0.4px;float:right;margin-top:3px">${typeLabel} · ${a.curr.total} calls · ${a.curr.flaggedCalls} flagged</span>
      </div>
      <div style="background:${bg};padding:10px 14px"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table></div>
      ${linkHtml}
    </div>`;
  }).join('');

  return `<div style="${S}max-width:600px;margin:0 auto;color:#1A1816">
    <h2 style="${S}font-size:22px;font-weight:400;margin:0 0 6px">Compliance digest — ${alerted.length} account${alerted.length !== 1 ? 's' : ''}</h2>
    <p style="${S}font-size:13px;color:${muted};margin:0 0 20px;line-height:1.6">Hi ${firstName}, here are the compliance flags and performance moves on your accounts for <strong>${periodLabel}</strong>.</p>
    <div style="margin-bottom:20px">${cards}</div>
    <p style="${S}font-size:12px;color:${muted};line-height:1.6;border-top:1px solid ${border};padding-top:14px;margin-top:14px">Generated automatically by the Buyerlink Calls AI Agent Registry.</p>
  </div>`;
}

main().catch(e => { console.error('Alert script failed:', e.message); process.exit(1); });
