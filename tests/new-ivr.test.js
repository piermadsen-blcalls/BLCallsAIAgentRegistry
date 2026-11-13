// New AI IVRs (migration 060): the sync runs the check, alert.js emails each new IVR once, and the
// Agents tab shows a "New IVRs" banner whose setup form finishes the agent. The SQL side has its
// own test (supabase/tests/060_new_ivr_detection_test.sql). Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');

// ── sync.js ──────────────────────────────────────────────────────────────────
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
process.env.CANOE_API_URL = 'http://canoe.test';
delete process.env.SYNC_FROM; delete process.env.SYNC_TO; delete process.env.SKIP_PASS1;
const sync = require('../scripts/sync.js');

function stubSupabase(checkReply) {
  const log = [];
  global.fetch = async (url, opts = {}) => {
    const p = url.replace('http://sb.test/rest/v1/', '');
    log.push({ path: p, method: opts.method || 'GET' });
    const reply = (status, data) => ({ ok: status < 300, status, text: async () => (data === undefined ? '' : JSON.stringify(data)), json: async () => data });
    if (p.startsWith('sync_state') && (opts.method || 'GET') === 'GET') return reply(200, [{ synced_through: new Date(Date.now() - 86400000).toISOString() }]);
    if (p.startsWith('canoe_calls?select=')) return reply(200, []);
    if (p === 'rpc/sync_hl_to_canoe_calls') return reply(200, 0);
    if (p === 'rpc/check_new_ivrs') return checkReply(reply);
    return reply(204);
  };
  return log;
}
sync.io.sleep = async () => {};
sync.io.post = async (url) => (url.includes('phone-lead-transactions')
  ? { status: 200, text: JSON.stringify({ data: [{ id: 'PH1', created_at: '2026-11-12T10:00:00Z' }], pagination: { pageCount: 1 } }) }
  : { status: 200, text: '{"data":[]}' });

test('sync: after the calls land it runs the IVR check, once, after the rollup request', async () => {
  const log = stubSupabase(reply => reply(200, { aliases_added: 1, registered: ['ASCND AI Agent - New - Outgoing'] }));
  const out = [];
  const origLog = console.log; console.log = (...a) => out.push(a.join(' '));
  try { await sync.run(); } finally { console.log = origLog; }
  assert.ok(!process.exitCode);
  const paths = log.map(r => r.path);
  assert.equal(paths.filter(p => p === 'rpc/check_new_ivrs').length, 1);
  assert.ok(paths.indexOf('rpc/check_new_ivrs') > paths.indexOf('canoe_calls'), 'after Pass 1 upserts');
  assert.ok(paths.indexOf('rpc/check_new_ivrs') > paths.indexOf('rpc/request_rollup_refresh'), 'after the rollup request');
  assert.ok(out.some(l => /1 rename\(s\) healed, 1 new IVR\(s\) registered/.test(l)));
});

test('sync: a failing IVR check does not fail the run (the 07:15 UTC cron catches up)', async () => {
  stubSupabase(reply => reply(500, { message: 'canceling statement due to statement timeout' }));
  const origWarn = console.warn; console.warn = () => {};
  try { await sync.run(); } finally { console.warn = origWarn; }
  assert.ok(!process.exitCode);
});

// ── alert.js ALERT_MODE=new_ivrs ─────────────────────────────────────────────
const SCRIPT = path.join(__dirname, '..', 'scripts', 'alert.js');
const IVR = 'ASCND AI Agent - Roof (Check for Transfers)_15550001234 - Outgoing';

// Tiny PostgREST: eq / is.null filters, GET and PATCH; plus a webhook that can fail per address.
function mockServer(db) {
  const match = (row, q) => [...q].every(([k, v]) => {
    if (['select', 'order', 'limit'].includes(k)) return true;
    if (v === 'is.null') return row[k] == null;
    if (v.startsWith('eq.')) return String(row[k]) === v.slice(3);
    throw new Error(`mock: unsupported filter ${k}=${v}`);
  });
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      if (url.pathname === '/webhook') {
        const p = JSON.parse(body);
        if (db.failFor.has(p.to_email)) return send(502, { error: 'bad gateway' });
        db.webhook.push(p); return send(200, { ok: true });
      }
      const table = url.pathname.replace('/rest/v1/', '');
      const rows = (db[table] || []).filter(r => match(r, url.searchParams));
      if (req.method === 'GET') return send(200, rows);
      if (req.method === 'PATCH') { rows.forEach(r => Object.assign(r, JSON.parse(body))); return send(204); }
      send(404);
    });
  });
}
async function withServer(db, fn) {
  const server = mockServer(db);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
function runAlert(base, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, SUPABASE_URL: base, SUPABASE_SERVICE_KEY: 'test-key', ALERT_MODE: 'new_ivrs',
        ASCND_ALERT_WEBHOOK_URL: `${base}/webhook`, DASHBOARD_URL: 'https://example.invalid/', ...env },
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
  });
}
function freshDb() {
  return {
    account_managers: [
      { id: 'pier', manager_name: 'Pat Admin', manager_email: 'pat@example.invalid', is_admin: true },
      { id: 'vick', manager_name: 'Val Admin', manager_email: 'val@example.invalid', is_admin: true },
      { id: 'off', manager_name: 'Off Admin', manager_email: 'off@example.invalid', is_admin: true },    // digest disabled
      { id: 'am', manager_name: 'Acct Manager', manager_email: 'am@example.invalid', is_admin: false },  // not an admin
    ],
    manager_alert_settings: [{ manager_id: 'pier', enabled: true }, { manager_id: 'vick', enabled: true }, { manager_id: 'off', enabled: false }, { manager_id: 'am', enabled: true }],
    agents: [{ ivr_name: IVR, name: 'Roof (Check for Transfers)', status: 'needs_setup', first_seen_at: '2026-11-04T15:00:00Z', seen_calls: 12 }],
    new_ivr_detections: [{ ivr_name: IVR, emailed_to: [], emailed_at: null }],
    webhook: [], failFor: new Set(),
  };
}

test('new_ivrs: one email per new IVR to each admin on the digest, then never again', async () => {
  const db = freshDb();
  await withServer(db, async base => {
    await runAlert(base);
    assert.deepEqual(db.webhook.map(p => p.to_email).sort(), ['pat@example.invalid', 'val@example.invalid'],
      'admins with the digest enabled only');
    const p = db.webhook[0];
    assert.equal(p.subject, 'New AI IVR needs setup: Roof (Check for Transfers)');
    assert.equal(p.alert_type, 'new_ivr');
    assert.equal(p.calls, 12);
    const link = new URL(p.link);
    assert.equal(link.origin + link.pathname, 'https://example.invalid/');
    assert.equal(link.searchParams.get('tab'), 'agents');
    assert.equal(link.searchParams.get('setup'), IVR, 'link opens this agent\'s setup form');
    assert.match(p.email_body_html, /Nov 4, 2026/);
    assert.match(p.email_body_html, /Finish setup/);
    assert.match(p.email_body_html, /Roof \(Check for Transfers\)_15550001234/);
    const d = db.new_ivr_detections[0];
    assert.deepEqual([...d.emailed_to].sort(), ['pier', 'vick']);
    assert.ok(d.emailed_at, 'marked done');

    await runAlert(base);
    assert.equal(db.webhook.length, 2, 'second run sends nothing');
  });
});

test('new_ivrs: a failed send retries only that recipient', async () => {
  const db = freshDb();
  db.failFor.add('val@example.invalid');
  await withServer(db, async base => {
    await runAlert(base);
    assert.deepEqual(db.webhook.map(p => p.to_email), ['pat@example.invalid']);
    assert.deepEqual(db.new_ivr_detections[0].emailed_to, ['pier']);
    assert.equal(db.new_ivr_detections[0].emailed_at, null, 'still pending for Val');

    db.failFor.clear();
    await runAlert(base);
    assert.deepEqual(db.webhook.map(p => p.to_email), ['pat@example.invalid', 'val@example.invalid'], 'Pat is not emailed twice');
    assert.ok(db.new_ivr_detections[0].emailed_at);
  });
});

test('new_ivrs: an IVR set up before the email goes out is not emailed', async () => {
  const db = freshDb();
  db.agents[0].status = 'live';
  await withServer(db, async base => {
    await runAlert(base);
    assert.equal(db.webhook.length, 0);
    assert.ok(db.new_ivr_detections[0].emailed_at, 'closed, so it is never sent later');
  });
});

test('new_ivrs: DRY_RUN and override previews send to nobody real and record nothing', async () => {
  const db = freshDb();
  await withServer(db, async base => {
    const out = await runAlert(base, { DRY_RUN: 'true' });
    assert.match(out, /DRY RUN — would email pat@example\.invalid/);
    assert.equal(db.webhook.length, 0);

    await runAlert(base, { ALERT_OVERRIDE_EMAIL: 'preview@example.invalid' });
    assert.deepEqual(db.webhook.map(p => p.to_email), ['preview@example.invalid']);
    assert.match(db.webhook[0].subject, /\[preview\]$/);

    assert.deepEqual(db.new_ivr_detections[0].emailed_to, []);
    assert.equal(db.new_ivr_detections[0].emailed_at, null, 'the real send still happens later');
  });
});

test('new_ivrs: the email escapes names from Canoe', () => {
  const { buildNewIvrEmail } = require('../scripts/alert.js');
  const html = buildNewIvrEmail({ ivr_name: 'ASCND <b>x</b>', name: '<script>', first_seen_at: null, seen_calls: 1 }, 'Pat', '');
  assert.doesNotMatch(html, /<script>|<b>x<\/b>/);
  assert.match(html, /&lt;script&gt;/);
});

// ── index.html: banner, setup form, Review board ─────────────────────────────
const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function lift(decl) {
  const start = page.indexOf(decl);
  assert.ok(start >= 0, `${decl} not found in index.html`);
  let i = start + page.slice(start).search(/\)\s*\{/), depth = 0;
  i = page.indexOf('{', i);
  for (; i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}' && --depth === 0) break;
  }
  return page.slice(start, i + 1);
}
const unhtml = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// A document with just enough elements: values by id, and the banner element.
function fakeDoc(values = {}) {
  const els = {};
  const el = id => els[id] || (els[id] = { id, value: values[id] ?? '', hidden: true, className: '', innerHTML: '', textContent: '', disabled: false,
    focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; } });
  return { els, getElementById: el, querySelector: sel => (values[sel] ? { value: values[sel] } : null) };
}
const BANNER = ['function needsSetup(', 'function getEffectiveStatus(', 'function renderNewIvrBanner(', 'function newIvrMeta(',
  'function renderIvrSetupForm(', 'function openIvrSetup(', 'function closeIvrSetup(', 'async function saveIvrSetup(',
  'function openSetupFromUrl(', 'function canSetUpIvrs(', 'function esc(', 'function fmtDate('];
// Admin by default: the banner and setup form are admin-only (window.isAdmin === true).
function pageCtx(extra) {
  const ctx = { console, URLSearchParams, location: { search: '' }, window: { isAdmin: true }, applyFilters() { ctx.filtered = (ctx.filtered || 0) + 1; }, ...extra };
  vm.runInNewContext('var ivrSetupOpen = null;\n' + page.match(/const SETUP_VERTICALS=.*;/)[0] + '\n' + BANNER.map(lift).join(';\n') + ';\n' +
    ['needsSetup', 'getEffectiveStatus', 'renderNewIvrBanner', 'openIvrSetup', 'saveIvrSetup', 'openSetupFromUrl'].map(n => `this.${n} = ${n};`).join(' '), ctx);
  return ctx;
}
const agent = (ivrName, over = {}) => ({ ivrName, name: ivrName.replace('IVR ', ''), status: 'live', vertical: 'Other', routingType: 'unknown',
  qualifying: [], disqualify: null, notes: null, raw_calls: 5, firstSeenAt: null, seenCalls: 0, ...over });

test('banner: lists only needs_setup agents, newest first, with first-seen date and calls', () => {
  const doc = fakeDoc();
  const ctx = pageCtx({ document: doc, AGENTS: [
    agent('IVR Live'),
    agent('IVR Older', { status: 'needs_setup', firstSeenAt: '2026-11-04T15:00:00Z', seenCalls: 1 }),
    agent('IVR Newer', { status: 'needs_setup', firstSeenAt: '2026-11-11T15:00:00Z', seenCalls: 1234 }),
  ] });
  ctx.renderNewIvrBanner();
  const b = doc.els['new-ivr-banner'], out = unhtml(b.innerHTML);
  assert.equal(b.hidden, false);
  assert.match(out, /New IVRs<\/span><span class="nib-count">2</);
  assert.doesNotMatch(out, /IVR Live/);
  assert.ok(out.indexOf('IVR Newer') < out.indexOf('IVR Older'), 'newest first');
  assert.match(out, /First seen Nov 11, 2026 · 1,234 calls/);
  assert.match(out, /First seen Nov 4, 2026 · 1 call</);
  assert.match(out, /<span class="nib-note">Auto-added from the Canoe sync\. Add a vertical and screening rules to include them in Review\.<\/span>/);
  assert.equal(ctx.getEffectiveStatus(ctx.AGENTS[1]), 'setup', 'card badge says needs setup');
});

test('card badge: a new IVR says it needs setup, even when the metrics failed to load', () => {
  const ctx = { vClass: () => '', rtLabel: () => 'unknown', fmtPct: () => '—', renderTestCallRow: () => '', aeCardLine: () => '', openAgent: null, agentLastCall: null };
  vm.runInNewContext(['function esc(', 'function nullMark(', 'function needsSetup(', 'function isInactive(', 'function getEffectiveStatus(', 'function renderCard('].map(lift).join(';\n') +
    ';\nthis.renderCard = renderCard;', ctx);
  const a = agent('IVR New', { status: 'needs_setup', raw_calls: 0, paid_calls: 0, revenue: 0 });
  for (const failed of [false, true]) {
    ctx.metricsFailed = failed;
    assert.match(ctx.renderCard(a, 0), /status-setup">New · needs setup</);
  }
});

test('banner: hidden when nothing needs setup', () => {
  const doc = fakeDoc();
  const ctx = pageCtx({ document: doc, AGENTS: [agent('IVR Live'), agent('IVR Test', { status: 'test' })] });
  ctx.renderNewIvrBanner();
  assert.equal(doc.els['new-ivr-banner'].hidden, true);
});

test('setup form: needs a vertical, then saves the agent as live and leaves the banner', async () => {
  const doc = fakeDoc({ 'nib-name-0': 'Roofing', 'nib-vertical-0': '', 'nib-routing-0': 'publisher-led',
    'nib-qual-0': 'Owns the home\n\n  Roof is leaking  ', 'nib-dq-0': '', 'nib-notes-0': '', 'input[name="nib-kind-0"]:checked': 'live' });
  const calls = [];
  const ctx = pageCtx({ document: doc, AGENTS: [agent('IVR Roof', { status: 'needs_setup', seenCalls: 3 })],
    sbFetch: async (url, opts) => { calls.push({ url, opts }); return [{}]; } });
  ctx.openIvrSetup(0);
  const form = unhtml(doc.els['new-ivr-banner'].innerHTML);
  assert.match(form, /Save and finish setup/, 'form open');
  assert.match(form, /<option value="unknown" selected>Unknown<\/option>/, 'routing "Unknown", preselected for an unknown agent');
  assert.match(form, /value="live" checked> Live AI agent<\/label>/);
  assert.match(form, /value="test"> Internal \/ test \(hidden from Review\)<\/label>/);
  assert.ok(doc.els['nib-vertical-0'].focused, 'focus lands on the vertical');

  await ctx.saveIvrSetup(0);
  assert.equal(calls.length, 0, 'no vertical, no save');
  assert.match(doc.els['nib-err-0'].textContent, /Choose a vertical/);

  doc.els['nib-vertical-0'].value = 'Home Services';
  await ctx.saveIvrSetup(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'agents?ivr_name=eq.IVR%20Roof');
  assert.equal(calls[0].opts.method, 'PATCH');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual({ ...body, updated_at: undefined }, { name: 'Roofing', vertical: 'Home Services', routing_type: 'publisher-led',
    qualifying: ['Owns the home', 'Roof is leaking'], disqualify: null, notes: null, status: 'live', updated_at: undefined });
  const a = ctx.AGENTS[0];
  assert.equal(a.status, 'live');
  assert.deepEqual([...a.qualifying], ['Owns the home', 'Roof is leaking']);   // copied out of the vm realm
  const b = doc.els['new-ivr-banner'];
  assert.equal(b.hidden, false);
  assert.match(b.className, /done/);
  assert.match(b.innerHTML, /Roofing is set up\./);
  assert.ok(ctx.filtered >= 1, 'grid re-rendered');
});

test('setup form: "Internal / test" saves status test without a vertical', async () => {
  const doc = fakeDoc({ 'nib-name-0': 'Door', 'nib-vertical-0': '', 'nib-routing-0': 'unknown', 'nib-qual-0': '', 'nib-dq-0': '', 'nib-notes-0': '',
    'input[name="nib-kind-0"]:checked': 'test' });
  let body;
  const ctx = pageCtx({ document: doc, AGENTS: [agent('IVR Door', { status: 'needs_setup' })], sbFetch: async (u, o) => { body = JSON.parse(o.body); return [{}]; } });
  ctx.openIvrSetup(0);
  await ctx.saveIvrSetup(0);
  assert.equal(body.status, 'test');
  assert.equal(body.vertical, null);
  assert.match(doc.els['new-ivr-banner'].innerHTML, /set up as internal \/ test/);
});

test('setup form: a save that matches no row (signed out) keeps the agent waiting and says so', async () => {
  const doc = fakeDoc({ 'nib-name-0': 'Roof', 'nib-vertical-0': 'Legal', 'nib-routing-0': 'unknown', 'nib-qual-0': '', 'nib-dq-0': '', 'nib-notes-0': '',
    'input[name="nib-kind-0"]:checked': 'live' });
  const ctx = pageCtx({ document: doc, AGENTS: [agent('IVR Roof', { status: 'needs_setup' })], sbFetch: async () => [] });
  ctx.openIvrSetup(0);
  await ctx.saveIvrSetup(0);
  assert.equal(ctx.AGENTS[0].status, 'needs_setup');
  assert.match(doc.els['nib-err-0'].textContent, /Sign in/);
  assert.equal(doc.els['nib-save-0'].disabled, false);
});

test('email link ?setup= opens that agent\'s form, or searches for it once set up', () => {
  const doc = fakeDoc();
  const ctx = pageCtx({ document: doc, location: { search: '?tab=agents&setup=' + encodeURIComponent('IVR A&B') },
    AGENTS: [agent('IVR Live'), agent('IVR A&B', { status: 'needs_setup' })] });
  ctx.openSetupFromUrl();
  assert.match(unhtml(doc.els['new-ivr-banner'].innerHTML), /id="nib-save-1"/);
  assert.ok(doc.els['nib-item-1'].scrolled);

  ctx.AGENTS[1].status = 'live';
  ctx.openSetupFromUrl();
  assert.equal(doc.els['search-input'].value, 'A&B');
});

test('Review board: agents waiting for setup are off the board and out of Needs review', () => {
  let rootHtml = '';
  const reviewBoard = { managers: [], lastReview: { Done: new Date().toISOString() }, counts: {}, issues: {}, filter: 'all', myId: null,
    acctAssign: [], links: {}, draft: { side: 'advertiser', mgr: '', accts: [] }, applied: { side: 'advertiser', mgr: '', accts: [] },
    scopeInit: true, acctSearch: '' };
  const ctx = { console, URLSearchParams, reviewBoard, resolveIvrName: n => n, rvSideOf: () => ({}), agentLastCall: null, window: { isAdmin: true },
    AGENTS: [agent('Done', { name: 'Done agent' }), agent('Due', { name: 'Due agent' }),
      agent('New1', { name: 'New agent', status: 'needs_setup' }), agent('T', { name: 'Test agent', status: 'test' })],
    document: { getElementById: id => (id === 'review-root' ? { set innerHTML(v) { rootHtml = v; } } : null) } };
  vm.runInNewContext(['function needsSetup(', 'function isInactive(', 'function byLastCall(', 'function getEffectiveStatus(', 'function renderReviewBoard(', 'function reviewBoardStatus(',
    'function rvScopeSet(', 'function rvAcctLabel(', 'function canSetUpIvrs(', 'function esc(', 'function nullMark(', 'function fmtDate(', 'function jsStr('].map(lift).join(';\n') +
    ';\nthis.renderReviewBoard = renderReviewBoard;', ctx);
  ctx.renderReviewBoard();
  const out = unhtml(rootHtml);
  assert.match(out, /All <span style="opacity:.65">2<\/span>/);
  assert.match(out, /Needs review <span style="opacity:.65">1<\/span>/);
  assert.doesNotMatch(out, /New agent|Test agent/);
  assert.match(out, /1 new IVR is waiting for setup and not counted here/);
});

// ── Admin-only (captain, 2026-11-13): banner, setup form and the Review note ──
test('admin-only: a non-admin (or unknown yet) sees no banner, no setup form, and a ?setup= link only finds the card', () => {
  for (const isAdmin of [false, undefined]) {
    const doc = fakeDoc();
    const ctx = pageCtx({ document: doc, window: { isAdmin }, location: { search: '?tab=agents&setup=' + encodeURIComponent('IVR New') },
      AGENTS: [agent('IVR Live'), agent('IVR New', { status: 'needs_setup', firstSeenAt: '2026-11-11T15:00:00Z', seenCalls: 3 })] });
    ctx.renderNewIvrBanner();
    assert.equal(doc.els['new-ivr-banner'].hidden, true, `hidden for isAdmin=${isAdmin}`);
    assert.equal(doc.els['new-ivr-banner'].innerHTML, '');
    ctx.openIvrSetup(1);   // even a direct call renders nothing
    assert.equal(doc.els['new-ivr-banner'].innerHTML, '', 'no setup form');
    ctx.openSetupFromUrl();
    assert.equal(doc.els['search-input'].value, 'New', 'the link just finds the card');
  }
});

test('admin-only: the Review board note and its button show for admins only', () => {
  const render = isAdmin => {
    let rootHtml = '';
    const reviewBoard = { managers: [], lastReview: {}, counts: {}, issues: {}, filter: 'all', myId: null, acctAssign: [], links: {},
      draft: { side: 'advertiser', mgr: '', accts: [] }, applied: { side: 'advertiser', mgr: '', accts: [] }, scopeInit: true, acctSearch: '' };
    const ctx = { console, URLSearchParams, reviewBoard, resolveIvrName: n => n, rvSideOf: () => ({}), agentLastCall: null, window: { isAdmin },
      AGENTS: [agent('Due', { name: 'Due agent' }), agent('New1', { name: 'New agent', status: 'needs_setup' })],
      document: { getElementById: id => (id === 'review-root' ? { set innerHTML(v) { rootHtml = v; } } : null) } };
    vm.runInNewContext(['function needsSetup(', 'function isInactive(', 'function byLastCall(', 'function getEffectiveStatus(', 'function renderReviewBoard(', 'function reviewBoardStatus(',
      'function rvScopeSet(', 'function rvAcctLabel(', 'function canSetUpIvrs(', 'function esc(', 'function nullMark(', 'function fmtDate(', 'function jsStr('].map(lift).join(';\n') +
      ';\nthis.renderReviewBoard = renderReviewBoard;', ctx);
    ctx.renderReviewBoard();
    return unhtml(rootHtml);
  };
  assert.match(render(true), /1 new IVR is waiting for setup and not counted here\. <button onclick="switchTab\('agents'\)">Finish setup on the Agents tab/);
  for (const isAdmin of [false, undefined]) {
    const out = render(isAdmin);
    assert.doesNotMatch(out, /waiting for setup|Finish setup/, `no note for isAdmin=${isAdmin}`);
    assert.doesNotMatch(out, /New agent/, 'still off the board and out of Needs review');
  }
});

test('admin-only: status settles before anything draws; a sign-in re-reads it; the ?setup= link opens once', async () => {
  const calls = [];
  const make = token => {
    const ctx = { window: {}, agentsLoadedPromise: Promise.resolve(), _assignmentsPromise: 'cached', setupLinkHandled: false,
      getAuthToken: () => token,
      ensureAssignments: async () => { calls.push(['ensure', ctx._assignmentsPromise]); ctx.window.isAdmin = true; },
      renderNewIvrBanner: () => calls.push(['render', ctx.window.isAdmin]), openSetupFromUrl: () => calls.push(['link']) };
    vm.runInNewContext(lift('async function showNewIvrsForAdmins(') + ';\nthis.showNewIvrsForAdmins = showNewIvrsForAdmins;', ctx);   // its globals live on ctx
    return ctx;
  };
  await make(null).showNewIvrsForAdmins(true);
  assert.deepEqual(calls, [], 'signed out: nothing is read or drawn (the empty managers list would cache "not an admin")');
  const ctx = make('token');
  await ctx.showNewIvrsForAdmins();
  assert.deepEqual(calls, [['ensure', 'cached'], ['render', true], ['link']], 'admin status settles before the banner draws');
  await ctx.showNewIvrsForAdmins(true);
  assert.deepEqual(calls.slice(3), [['ensure', null], ['render', true]], 'a sign-in drops the cached status; the link is not reopened');
  // Every sign-in path re-reads it, and the boot draws through it instead of rendering directly.
  assert.equal((page.match(/refreshMetrics\(\); loadFreshness\(\); showNewIvrsForAdmins\(true\);/g) || []).length, 2, 'password sign-in and set-password');
  assert.match(page, /await applyRoute\(\); showNewIvrsForAdmins\(true\); \}/, 'session restored on load');
  assert.match(lift('async function bootDashboard('), /showNewIvrsForAdmins\(\);/);
  assert.doesNotMatch(lift('async function bootDashboard('), /renderNewIvrBanner\(\)|openSetupFromUrl\(\)/);
  assert.match(lift('async function renderReviewPicker('), /await Promise\.all\(\[loadReviewBoardData\(\), ensureAssignments\(\)\]\)/);
  assert.match(page, /<div id="new-ivr-banner" hidden><\/div>/, 'starts hidden in the markup');
});
