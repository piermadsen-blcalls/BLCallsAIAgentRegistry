// alert.js — Fire compliance + performance alerts to account managers via ASCND webhook
// Reads from canoe_calls (AI-processed), groups by manager's assigned accounts, emails via webhook.

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_URL      = process.env.ASCND_ALERT_WEBHOOK_URL;
const DRY_RUN          = process.env.DRY_RUN === 'true';        // set to skip webhook POSTs
const MANAGER_ID       = process.env.ALERT_MANAGER_ID || '';    // limit to one manager (testing)

// ── Config ──────────────────────────────────────────────────────────────────
// Flag values that indicate a compliance/DM concern (matched against canoe_calls.flags jsonb array)
const COMPLIANCE_FLAGS = new Set([
  'compliance', 'compliance_issue', 'regulatory',
  'misrepresentation', 'unauthorized_claim', 'prohibited_content'
]);
const DM_FLAGS = new Set([
  'dm', 'dm_detected', 'duplicate_caller', 'suspicious', 'media_buyer'
]);
const CONVERSION_FLAGS = new Set([
  'low_intent', 'bad_transfer', 'wrong_vertical', 'conversion_issue'
]);

// Score threshold: calls with publisher_score or advertiser_score below this are flagged
const SCORE_THRESHOLD = 40;

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

function toISO(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// ── Flag categorisation ──────────────────────────────────────────────────────
function categoriseFlags(flags) {
  const arr = Array.isArray(flags) ? flags : [];
  const normalised = arr.map(f => String(f).toLowerCase().replace(/\s+/g, '_'));
  return {
    compliance: normalised.some(f => COMPLIANCE_FLAGS.has(f)),
    dm:         normalised.some(f => DM_FLAGS.has(f)),
    conversion: normalised.some(f => CONVERSION_FLAGS.has(f)),
    raw:        arr
  };
}

function scoreFlagged(call) {
  return (
    (call.publisher_score  != null && call.publisher_score  < SCORE_THRESHOLD) ||
    (call.advertiser_score != null && call.advertiser_score < SCORE_THRESHOLD)
  );
}

// ── Date helpers ─────────────────────────────────────────────────────────────
function dateRangeLabel(startISO, endISO) {
  const fmt = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(startISO)} – ${fmt(endISO)}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  if (!WEBHOOK_URL && !DRY_RUN)       throw new Error('Missing ASCND_ALERT_WEBHOOK_URL (set DRY_RUN=true to skip)');

  // 1. Load managers + alert settings
  const [managers, alertRows, assignments] = await Promise.all([
    sb('account_managers?select=*'),
    sb('manager_alert_settings?enabled=eq.true&select=*'),
    sb('account_manager_assignments?select=*')
  ]);

  if (!alertRows || !alertRows.length) {
    console.log('No managers have alerts enabled. Done.');
    return;
  }

  const mgrMap = {};
  (managers || []).forEach(m => { mgrMap[m.id] = m; });

  // Build assignment lookup: "account_name|type" -> manager_id
  const assignMap = {};
  (assignments || []).forEach(a => {
    assignMap[a.account_name + '|' + a.account_type] = a.manager_id;
  });

  // Build reverse: manager_id -> { advertisers: Set, publishers: Set }
  const mgrAccounts = {};
  Object.entries(assignMap).forEach(([key, mgrId]) => {
    if (!mgrAccounts[mgrId]) mgrAccounts[mgrId] = { advertisers: new Set(), publishers: new Set() };
    const [name, type] = key.split('|');
    if (type === 'advertiser') mgrAccounts[mgrId].advertisers.add(name);
    else                       mgrAccounts[mgrId].publishers.add(name);
  });

  // Filter to one manager if MANAGER_ID is set (useful for testing)
  const settings = MANAGER_ID
    ? alertRows.filter(s => s.manager_id === MANAGER_ID)
    : alertRows;

  // 2. Process each manager
  let sentCount = 0;

  for (const s of settings) {
    const mgr = mgrMap[s.manager_id];
    if (!mgr) { console.warn(`Manager ${s.manager_id} not found, skipping.`); continue; }

    const accounts = mgrAccounts[s.manager_id];
    if (!accounts || (!accounts.advertisers.size && !accounts.publishers.size)) {
      console.log(`${mgr.manager_name}: no assigned accounts, skipping.`);
      continue;
    }

    // Date window
    const lookback = s.lookback_days || 7;
    const endDate   = new Date(); endDate.setHours(0, 0, 0, 0); endDate.setDate(endDate.getDate() - 1);
    const startDate = new Date(endDate); startDate.setDate(startDate.getDate() - (lookback - 1));
    const startISO  = toISO(startDate);
    const endISO    = toISO(endDate);

    console.log(`\n${mgr.manager_name} (${lookback}d: ${startISO} → ${endISO})`);

    // Prior period for comparison (revenue / volume anomalies)
    const priorEndDate   = new Date(startDate); priorEndDate.setDate(priorEndDate.getDate() - 1);
    const priorStartDate = new Date(priorEndDate); priorStartDate.setDate(priorStartDate.getDate() - (lookback - 1));
    const priorStartISO  = toISO(priorStartDate);
    const priorEndISO    = toISO(priorEndDate);

    const advSet = accounts.advertisers;
    const pubSet = accounts.publishers;

    // 3. Fetch current + prior period calls (all calls, no AI filter)
    async function fetchPeriodCalls(fromISO, toISO) {
      const PAGE = 1000;
      let results = [], offset = 0;
      while (true) {
        const q = `canoe_calls?select=id,created_at,publisher_name,advertiser_name,duration,advertiser_payin,our_outcome,flags,publisher_score,advertiser_score,vertical_name` +
          `&created_at=gte.${fromISO}T00:00:00` +
          `&created_at=lte.${toISO}T23:59:59`;
        const batch = await sb(q, { headers: { 'Range-Unit': 'items', 'Range': `${offset}-${offset + PAGE - 1}` } });
        if (!batch || !batch.length) break;
        results = results.concat(batch.filter(c => advSet.has(c.advertiser_name) || pubSet.has(c.publisher_name)));
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      return results;
    }

    const [allCalls, priorCalls] = await Promise.all([
      fetchPeriodCalls(startISO, endISO),
      fetchPeriodCalls(priorStartISO, priorEndISO)
    ]);

    console.log(`  ${allCalls.length} calls (current) / ${priorCalls.length} calls (prior)`);
    if (!allCalls.length && !priorCalls.length) continue;

    // 4. Aggregate by account for both periods
    function aggregateByAccount(calls) {
      const map = {};
      for (const c of calls) {
        const isAdv = advSet.has(c.advertiser_name);
        const name  = isAdv ? c.advertiser_name : c.publisher_name;
        const type  = isAdv ? 'advertiser' : 'publisher';
        if (!name) continue;
        if (!map[name]) map[name] = { type, total: 0, connected: 0, revenue: 0, compliance: [], dm: [], aiFlags: [] };
        const e = map[name];
        e.total++;
        if ((c.duration || 0) > 0) e.connected++;
        e.revenue += c.advertiser_payin || 0;
        const cats = categoriseFlags(c.flags);
        if (cats.compliance) e.compliance.push(c);
        if (cats.dm)         e.dm.push(c);
        if (cats.compliance || cats.dm || cats.conversion || scoreFlagged(c)) e.aiFlags.push(c);
      }
      return map;
    }

    const curr  = aggregateByAccount(allCalls);
    const prior = aggregateByAccount(priorCalls);

    // 5. Determine which accounts need alerting
    const allAccountNames = new Set([...Object.keys(curr), ...Object.keys(prior)]);
    const alertedAccounts = [];

    for (const name of allAccountNames) {
      const c = curr[name]  || { type: advSet.has(name) ? 'advertiser' : 'publisher', total: 0, connected: 0, revenue: 0, compliance: [], dm: [], aiFlags: [] };
      const p = prior[name] || { type: c.type, total: 0, connected: 0, revenue: 0, compliance: [], dm: [], aiFlags: [] };

      const reasons = [];

      // Volume drop ≥ 30% vs prior (only flag drops, not spikes)
      if (p.total >= 10 && c.total < p.total * 0.7) {
        const pct = Math.round((1 - c.total / p.total) * 100);
        reasons.push({ type: 'volume', label: `Volume down ${pct}%`, detail: `${c.total} calls vs ${p.total} prior` });
      }

      // Revenue drop ≥ 20% vs prior
      if (p.revenue >= 100 && c.revenue < p.revenue * 0.8) {
        const pct = Math.round((1 - c.revenue / p.revenue) * 100);
        reasons.push({ type: 'revenue', label: `Revenue down ${pct}%`, detail: `$${Math.round(c.revenue)} vs $${Math.round(p.revenue)} prior` });
      }

      // Conversion rate drop ≥ 10pp vs prior (only when enough volume)
      const currConv  = c.total > 0 ? c.connected / c.total : null;
      const priorConv = p.total > 0 ? p.connected / p.total : null;
      if (currConv !== null && priorConv !== null && p.total >= 10) {
        const drop = (priorConv - currConv) * 100;
        if (drop >= 10) {
          reasons.push({ type: 'conversion', label: `Conversion down ${drop.toFixed(1)}pp`, detail: `${(currConv*100).toFixed(1)}% vs ${(priorConv*100).toFixed(1)}% prior` });
        }
      }

      // AI compliance / DM flags (only if AI has run on any calls)
      if (c.compliance.length > 0) reasons.push({ type: 'compliance', label: `${c.compliance.length} compliance flag${c.compliance.length !== 1 ? 's' : ''}`, detail: '' });
      if (c.dm.length > 0)         reasons.push({ type: 'dm',         label: `${c.dm.length} DM / suspicious call${c.dm.length !== 1 ? 's' : ''}`, detail: '' });

      if (reasons.length > 0) alertedAccounts.push({ name, type: c.type, curr: c, prior: p, reasons });
    }

    // Sort by severity: compliance/dm first, then revenue, then volume
    const priority = { compliance: 0, dm: 1, revenue: 2, conversion: 3, volume: 4 };
    alertedAccounts.sort((a, b) => {
      const pa = Math.min(...a.reasons.map(r => priority[r.type] ?? 9));
      const pb = Math.min(...b.reasons.map(r => priority[r.type] ?? 9));
      return pa - pb;
    });

    if (!alertedAccounts.length) {
      console.log(`  No anomalies detected → no email sent.`);
      continue;
    }

    console.log(`  ${alertedAccounts.length} account${alertedAccounts.length !== 1 ? 's' : ''} need alerting:`);
    alertedAccounts.forEach(a => console.log(`    ${a.name}: ${a.reasons.map(r => r.label).join(', ')}`));

    // 5. Build email + subject
    const periodLabel = dateRangeLabel(startISO, endISO);
    const subject     = buildSubject(alertedAccounts, periodLabel);
    const emailHtml   = buildAlertEmail(mgr, alertedAccounts, allCalls.length, periodLabel);

    // 6. Check alert log — skip if already sent for this period
    const recentLog = await sb(
      `alert_log?manager_id=eq.${s.manager_id}&period_start=eq.${startISO}&select=id&limit=1`
    ).catch(() => null);
    if (recentLog && recentLog.length) {
      console.log(`  Alert already sent for this period → skip.`);
      continue;
    }

    // 7. Fire webhook
    const payload = {
      to_email:    mgr.manager_email,
      to_name:     mgr.manager_name,
      manager:     mgr.manager_name,
      first_name:  mgr.manager_name.split(' ')[0],
      subject,
      period_label: periodLabel,
      period_start: startISO,
      period_end:   endISO,
      total_calls:  allCalls.length,
      accounts: alertedAccounts.map(a => ({
        name:    a.name,
        type:    a.type,
        reasons: a.reasons.map(r => ({ type: r.type, label: r.label, detail: r.detail })),
        curr_calls:    a.curr.total,
        prior_calls:   a.prior.total,
        curr_revenue:  Math.round(a.curr.revenue * 100) / 100,
        prior_revenue: Math.round(a.prior.revenue * 100) / 100,
        compliance_count: a.curr.compliance.length,
        dm_count:         a.curr.dm.length
      })),
      email_body_html: emailHtml
    };

    if (DRY_RUN) {
      console.log(`  DRY RUN — would POST to webhook:`);
      console.log(`  to: ${payload.to_email}`);
      console.log(`  subject: ${payload.subject}`);
      alertedAccounts.forEach(a => console.log(`    • ${a.name}: ${a.reasons.map(r => r.label).join(', ')}`));
    } else {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`  Webhook failed ${res.status}: ${err}`);
        continue;
      }
      console.log(`  ✓ Alert sent to ${mgr.manager_email}`);
    }

    // 8. Log sent alert
    await sb('alert_log', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({
        manager_id:    s.manager_id,
        manager_email: mgr.manager_email,
        period_start:  startISO,
        period_end:    endISO,
        total_calls:   allCalls.length,
        flagged_count: alertedAccounts.length,
        dry_run:       DRY_RUN
      })
    }).catch(e => console.warn('  Could not write alert_log:', e.message));

    await sb(`manager_alert_settings?manager_id=eq.${s.manager_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_sent_at: new Date().toISOString() })
    }).catch(e => console.warn('  Could not update last_sent_at:', e.message));

    sentCount++;
  }

  console.log(`\nDone. Sent ${sentCount} alert${sentCount !== 1 ? 's' : ''}.`);
}

// ── Email builder ─────────────────────────────────────────────────────────────
function buildSubject(alertedAccounts, periodLabel) {
  const count = alertedAccounts.length;
  return `Account alert: ${count} account${count !== 1 ? 's' : ''} need attention — ${periodLabel}`;
}

function buildAlertEmail(mgr, alertedAccounts, totalCalls, periodLabel) {
  const firstName = mgr.manager_name.split(' ')[0];
  const S      = 'font-family:Arial,sans-serif;';
  const navy   = '#1A2E4A';
  const coral  = '#993C1D';
  const amber  = '#854F0B';
  const teal   = '#0F6E56';
  const muted  = '#6B6760';
  const border = '#E0DDD6';
  const bg     = '#F7F5F0';

  const iconMap = { compliance: '⚠', dm: '🔍', revenue: '↓', conversion: '↓', volume: '↓' };
  const colorMap = { compliance: coral, dm: amber, revenue: coral, conversion: amber, volume: muted };

  const accountCards = alertedAccounts.map(a => {
    const typeLabel = a.type === 'advertiser' ? 'Advertiser' : 'Publisher';
    const rows = a.reasons.map(r => {
      const icon  = iconMap[r.type]  || '•';
      const color = colorMap[r.type] || muted;
      return `<tr>
        <td style="${S}padding:5px 12px 5px 0;font-size:13px;color:${muted}">${icon} ${r.label}</td>
        <td style="${S}padding:5px 0;font-size:12px;color:${color};text-align:right">${r.detail}</td>
      </tr>`;
    }).join('');

    return `<div style="margin-bottom:12px;border:1px solid ${border};border-radius:6px;overflow:hidden">
      <div style="${S}background:#fff;padding:10px 14px;border-bottom:1px solid ${border};display:flex;align-items:baseline;justify-content:space-between">
        <span style="${S}font-size:14px;font-weight:600;color:${navy}">${a.name}</span>
        <span style="${S}font-size:10px;color:${muted};text-transform:uppercase;letter-spacing:0.4px">${typeLabel} · ${a.curr.total} calls</span>
      </div>
      <div style="background:${bg};padding:10px 14px">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>
      </div>
    </div>`;
  }).join('');

  return `<div style="${S}max-width:600px;margin:0 auto;color:#1A1816">
    <h2 style="${S}font-size:22px;font-weight:400;margin:0 0 6px">${alertedAccounts.length} account${alertedAccounts.length !== 1 ? 's' : ''} need your attention</h2>
    <p style="${S}font-size:13px;color:${muted};margin:0 0 20px;line-height:1.6">
      Hi ${firstName}, here's your account alert for <strong>${periodLabel}</strong> across ${totalCalls.toLocaleString()} calls.
    </p>
    <div style="margin-bottom:20px">${accountCards}</div>
    <p style="${S}font-size:12px;color:${muted};line-height:1.6;border-top:1px solid ${border};padding-top:14px;margin-top:14px">
      Generated automatically by the Buyerlink Calls AI Agent Registry.
      Review your accounts in the dashboard or reply with any questions.
    </p>
  </div>`;
}

main().catch(e => { console.error('Alert script failed:', e.message); process.exit(1); });
