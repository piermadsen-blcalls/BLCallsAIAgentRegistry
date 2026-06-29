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

    // 3. Fetch AI-processed calls for this manager's accounts
    //    We query by advertiser OR publisher names via OR filter
    const advList = [...accounts.advertisers];
    const pubList = [...accounts.publishers];

    // Build OR filter for Supabase (advertiser_name OR publisher_name)
    const orParts = [
      ...advList.map(n => `advertiser_name.eq.${n}`),
      ...pubList.map(n => `publisher_name.eq.${n}`)
    ];
    if (!orParts.length) continue;

    const PAGE = 1000;
    let allCalls = [];
    let offset = 0;
    while (true) {
      const q = `canoe_calls?select=id,created_at,publisher_name,advertiser_name,our_outcome,flags,publisher_score,advertiser_score,vertical_name` +
        `&ai_processed_at=not.is.null` +
        `&created_at=gte.${startISO}T00:00:00` +
        `&created_at=lte.${endISO}T23:59:59` +
        `&or=(${orParts.map(p => encodeURIComponent(p)).join(',')})`;
      const batch = await sb(q, { headers: { 'Range-Unit': 'items', 'Range': `${offset}-${offset + PAGE - 1}` } });
      if (!batch || !batch.length) break;
      allCalls = allCalls.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }

    console.log(`  ${allCalls.length} AI-processed calls fetched`);
    if (!allCalls.length) continue;

    // 4. Categorise calls
    const flaggedCalls = allCalls.filter(c => {
      const cats = categoriseFlags(c.flags);
      return cats.compliance || cats.dm || cats.conversion || scoreFlagged(c);
    });

    console.log(`  ${flaggedCalls.length} flagged calls`);
    if (!flaggedCalls.length) {
      console.log(`  No flags → no email sent.`);
      continue;
    }

    // Aggregate by account
    const byAccount = {};  // account_name -> { type, total, flagged, complianceCalls, dmCalls, convCalls, scoreCalls }
    for (const c of allCalls) {
      // Which account does this call belong to for this manager?
      const isAdvAcct = advList.includes(c.advertiser_name);
      const isPubAcct = pubList.includes(c.publisher_name);
      const accountName = isAdvAcct ? c.advertiser_name : c.publisher_name;
      const accountType = isAdvAcct ? 'advertiser' : 'publisher';
      if (!accountName) continue;

      if (!byAccount[accountName]) {
        byAccount[accountName] = { type: accountType, total: 0, compliance: [], dm: [], conversion: [], score: [] };
      }
      const entry = byAccount[accountName];
      entry.total++;

      const cats = categoriseFlags(c.flags);
      if (cats.compliance) entry.compliance.push(c);
      if (cats.dm)         entry.dm.push(c);
      if (cats.conversion) entry.conversion.push(c);
      if (scoreFlagged(c)) entry.score.push(c);
    }

    // Only include accounts that actually have flags
    const flaggedAccounts = Object.entries(byAccount)
      .filter(([, v]) => v.compliance.length || v.dm.length || v.conversion.length || v.score.length)
      .sort((a, b) => {
        const totalA = a[1].compliance.length + a[1].dm.length + a[1].conversion.length + a[1].score.length;
        const totalB = b[1].compliance.length + b[1].dm.length + b[1].conversion.length + b[1].score.length;
        return totalB - totalA;
      });

    if (!flaggedAccounts.length) {
      console.log(`  No accounts with flags → skip.`);
      continue;
    }

    // 5. Build email
    const periodLabel = dateRangeLabel(startISO, endISO);
    const emailHtml   = buildAlertEmail(mgr, flaggedAccounts, allCalls.length, periodLabel);
    const subject     = buildSubject(flaggedAccounts, periodLabel);

    // 6. Check alert log (has this manager been alerted in the last 24h for the same period?)
    const recentLog = await sb(
      `alert_log?manager_id=eq.${s.manager_id}&period_start=eq.${startISO}&select=id&limit=1`
    ).catch(() => null);
    if (recentLog && recentLog.length) {
      console.log(`  Alert already sent for this period → skip.`);
      continue;
    }

    // 7. Fire webhook
    const payload = {
      // ASCND routing fields
      to_email:   mgr.manager_email,
      to_name:    mgr.manager_name,
      manager:    mgr.manager_name,        // "it can have a manager field"
      first_name: mgr.manager_name.split(' ')[0],
      subject,

      // Structured data for ASCND template use
      period_label: periodLabel,
      period_start: startISO,
      period_end:   endISO,
      total_calls:  allCalls.length,
      flagged_count: flaggedCalls.length,
      accounts: flaggedAccounts.map(([name, v]) => ({
        name,
        type:             v.type,
        total_calls:      v.total,
        compliance_count: v.compliance.length,
        dm_count:         v.dm.length,
        conversion_count: v.conversion.length,
        score_count:      v.score.length
      })),

      // Full HTML body — ASCND can use this directly
      email_body_html: emailHtml
    };

    if (DRY_RUN) {
      console.log(`  DRY RUN — would POST to webhook:`);
      console.log(`  to: ${payload.to_email} | subject: ${payload.subject}`);
      console.log(`  accounts with flags: ${flaggedAccounts.map(([n]) => n).join(', ')}`);
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
        flagged_count: flaggedCalls.length,
        dry_run:       DRY_RUN
      })
    }).catch(e => console.warn('  Could not write alert_log:', e.message));

    // Update last_sent_at in manager_alert_settings
    await sb(`manager_alert_settings?manager_id=eq.${s.manager_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_sent_at: new Date().toISOString() })
    }).catch(e => console.warn('  Could not update last_sent_at:', e.message));

    sentCount++;
  }

  console.log(`\nDone. Sent ${sentCount} alert${sentCount !== 1 ? 's' : ''}.`);
}

// ── Email builder ─────────────────────────────────────────────────────────────
function buildSubject(flaggedAccounts, periodLabel) {
  const totalFlags = flaggedAccounts.reduce((s, [, v]) =>
    s + v.compliance.length + v.dm.length + v.conversion.length + v.score.length, 0);
  const accountCount = flaggedAccounts.length;
  return `Compliance alert: ${totalFlags} flagged call${totalFlags !== 1 ? 's' : ''} across ${accountCount} account${accountCount !== 1 ? 's' : ''} — ${periodLabel}`;
}

function buildAlertEmail(mgr, flaggedAccounts, totalCalls, periodLabel) {
  const firstName = mgr.manager_name.split(' ')[0];
  const totalFlags = flaggedAccounts.reduce((s, [, v]) =>
    s + v.compliance.length + v.dm.length + v.conversion.length + v.score.length, 0);

  const S = 'font-family:Arial,sans-serif;';
  const navy = '#1A2E4A';
  const mint = '#00C896';
  const coral = '#993C1D';
  const amber = '#854F0B';
  const teal = '#0F6E56';
  const muted = '#6B6760';
  const border = '#E0DDD6';
  const bg = '#F7F5F0';

  function flagRow(icon, color, label, count, calls) {
    if (!count) return '';
    const callWord = count === 1 ? 'call' : 'calls';
    return `<tr>
      <td style="${S}padding:6px 12px 6px 0;font-size:13px;color:${muted};white-space:nowrap">${icon} ${label}</td>
      <td style="${S}padding:6px 0;font-size:13px;font-weight:600;color:${color};text-align:right;white-space:nowrap">${count} ${callWord}</td>
    </tr>`;
  }

  const accountCards = flaggedAccounts.map(([name, v]) => {
    const typeLabel = v.type === 'advertiser' ? 'Advertiser' : 'Publisher';
    const rows = [
      flagRow('⚠', coral,  'Compliance flags', v.compliance.length),
      flagRow('🔍', amber,  'DM / suspicious',  v.dm.length),
      flagRow('↓',  teal,  'Conversion issues', v.conversion.length),
      flagRow('📊', muted, 'Low quality scores',v.score.length)
    ].filter(Boolean).join('');

    return `<div style="margin-bottom:12px;border:1px solid ${border};border-radius:6px;overflow:hidden">
      <div style="${S}background:#fff;padding:10px 14px;border-bottom:1px solid ${border};display:flex;align-items:baseline;justify-content:space-between">
        <span style="${S}font-size:14px;font-weight:600;color:${navy}">${name}</span>
        <span style="${S}font-size:10px;color:${muted};text-transform:uppercase;letter-spacing:0.4px">${typeLabel} · ${v.total} calls total</span>
      </div>
      <div style="background:${bg};padding:10px 14px">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>
      </div>
    </div>`;
  }).join('');

  return `<div style="${S}max-width:600px;margin:0 auto;color:#1A1816">
    <h2 style="${S}font-size:22px;font-weight:400;margin:0 0 6px">${totalFlags} flagged call${totalFlags !== 1 ? 's' : ''} need your attention</h2>
    <p style="${S}font-size:13px;color:${muted};margin:0 0 20px;line-height:1.6">
      Hi ${firstName}, here's your compliance summary for <strong>${periodLabel}</strong>.
      ${totalFlags} of ${totalCalls} AI-processed calls across your accounts were flagged for review.
    </p>

    <div style="margin-bottom:20px">${accountCards}</div>

    <p style="${S}font-size:12px;color:${muted};line-height:1.6;border-top:1px solid ${border};padding-top:14px;margin-top:14px">
      These flags were detected automatically by the Buyerlink AI compliance agent.
      Review flagged calls in the compliance dashboard before taking action.
      Reply to this email or reach out to the team with any questions.
    </p>
  </div>`;
}

main().catch(e => { console.error('Alert script failed:', e.message); process.exit(1); });
