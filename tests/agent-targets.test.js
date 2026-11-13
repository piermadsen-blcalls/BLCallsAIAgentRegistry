// Publisher campaigns + buyer targets from the calls (migration 062): the sync rebuilds them after
// the IVR check, the page loads them with their own request, and the details show them as aligned
// tables sorted by calls with a total. The SQL side has its own test
// (supabase/tests/062_agent_targets_from_calls_test.sql). Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ── sync.js ──────────────────────────────────────────────────────────────────
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
process.env.CANOE_API_URL = 'http://canoe.test';
delete process.env.SYNC_FROM; delete process.env.SYNC_TO; delete process.env.SKIP_PASS1;
const sync = require('../scripts/sync.js');

function stubSupabase(targetsReply) {
  const log = [];
  global.fetch = async (url, opts = {}) => {
    const p = url.replace('http://sb.test/rest/v1/', '');
    log.push(p);
    const reply = (status, data) => ({ ok: status < 300, status, text: async () => (data === undefined ? '' : JSON.stringify(data)), json: async () => data });
    if (p.startsWith('sync_state') && (opts.method || 'GET') === 'GET') return reply(200, [{ synced_through: new Date(Date.now() - 86400000).toISOString() }]);
    if (p.startsWith('canoe_calls?select=')) return reply(200, []);
    if (p === 'rpc/sync_hl_to_canoe_calls') return reply(200, 0);
    if (p === 'rpc/check_new_ivrs') return reply(200, { aliases_added: 0, registered: [] });
    if (p === 'rpc/refresh_agent_targets') return targetsReply(reply);
    return reply(204);
  };
  return log;
}
sync.io.sleep = async () => {};
sync.io.post = async (url) => (url.includes('phone-lead-transactions')
  ? { status: 200, text: JSON.stringify({ data: [{ id: 'PH1', created_at: '2026-11-12T10:00:00Z' }], pagination: { pageCount: 1 } }) }
  : { status: 200, text: '{"data":[]}' });

test('sync: rebuilds agent targets once, after the IVR check registers new IVRs', async () => {
  const log = stubSupabase(reply => reply(200, 31));
  const out = [];
  const origLog = console.log; console.log = (...a) => out.push(a.join(' '));
  try { await sync.run(); } finally { console.log = origLog; }
  assert.ok(!process.exitCode);
  assert.equal(log.filter(p => p === 'rpc/refresh_agent_targets').length, 1);
  assert.ok(log.indexOf('rpc/refresh_agent_targets') > log.indexOf('rpc/check_new_ivrs'), 'after the IVR check');
  assert.ok(out.some(l => /Agent targets refreshed \(31 agent\(s\)/.test(l)));
});

test('sync: a failing targets refresh does not fail the run (the 07:20 UTC cron catches up)', async () => {
  stubSupabase(reply => reply(404, { message: 'Could not find the function public.refresh_agent_targets' }));
  const warns = [];
  const origWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try { await sync.run(); } finally { console.warn = origWarn; }
  assert.ok(!process.exitCode);
  assert.ok(warns.some(w => /Agent targets refresh failed/.test(w)));
});

// ── index.html ───────────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function lift(decl) {
  const start = html.indexOf(decl);
  assert.ok(start >= 0, `${decl} not found in index.html`);
  let i = start + html.slice(start).search(/\)\s*\{/), depth = 0;
  i = html.indexOf('{', i);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(start, i + 1);
}
function load(ctx, decls, exportNames) {
  vm.runInNewContext(decls.map(lift).join(';\n') + ';\n' + exportNames.map(n => `this.${n} = ${n};`).join(' '), ctx);
  return ctx;
}
const unhtml = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = s => unhtml(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

test('loader: attaches each agent its targets; a failed targets read still loads the agents', async () => {
  const agents = [{ ivr_name: 'IVR A', name: 'A' }, { ivr_name: 'IVR B', name: 'B' }];
  const tA = { ivr_name: 'IVR A', window_days: 30, calls: 5, publisher_campaigns: [], buyer_targets: [] };
  const ctx = { console: { warn() {} }, AGENTS: [], agentsLoadFailed: false, agentTargetsFailed: false,
    sbFetch: async url => (url.startsWith('agents?') ? agents : [tA]) };
  load(ctx, ['async function loadAgentsFromSupabase('], ['loadAgentsFromSupabase']);
  await ctx.loadAgentsFromSupabase();
  assert.deepEqual(ctx.AGENTS.map(a => a.targets && a.targets.calls), [5, null]);
  assert.equal(ctx.agentTargetsFailed, false);

  ctx.sbFetch = async url => { if (url.startsWith('agent_targets')) throw new Error('Supabase 404'); return agents; };
  await ctx.loadAgentsFromSupabase();
  assert.equal(ctx.AGENTS.length, 2, 'agents still load');
  assert.equal(ctx.agentsLoadFailed, false);
  assert.equal(ctx.agentTargetsFailed, true);
});

function drawerCtx() {
  return load({
    metricsFailed: false, agentTargetsFailed: false, tcEdit: null, testCallMap: {}, activeRange: { label: 'Last 30 days' },
    aeDrawerHtml: () => '', document: { getElementById: () => null },
  }, ['function esc(', 'function nullMark(', 'function fmtPct(', 'function httpUrl(', 'function rtLabel(', 'function needsSetup(',
    'function getEffectiveStatus(', 'function bdPending(', 'function renderDrawerTestCall(', 'function renderDrawer('], ['renderDrawer']);
}
const AGENT = { name: 'Home Improvements', ivrName: 'IVR HI', vertical: 'Home Services', status: 'live', routingType: 'publisher-led',
  qualifying: [], raw_calls: 0, sent_calls: 0, paid_calls: 0, revenue: 0, margin: 0, _bdKey: 'Last 30 days', pubBreakdown: [], advBreakdown: [] };
const TARGETS = {
  window_days: 30, calls: 44, routed_calls: 15,
  publisher_campaigns: [
    { campaign: 'Find a Handyman (Variable Rate)', publisher: 'Marketwisely, LLC', calls: 14 },
    { campaign: 'Pay Per Call API', publisher: '1800Remodel (BH Direct Response) - DP', calls: 8 },
  ],
  publisher_campaigns_total: 15,
  buyer_targets: [
    { advertiser: 'RingPartner Pay Per Call', campaign: 'Handyman', vertical: 'Handyman', other_verticals: 2, calls: 10 },
    { advertiser: 'Buyer <B>', campaign: null, vertical: '(unknown)', other_verticals: 0, calls: 1 },
  ],
  buyer_targets_total: 2,
};
// The [title, table] pair under a details section title.
const section = (out, title) => out.split(`<div class="dsec-title">${title}</div>`)[1].split('<div class="dsec">')[0];

test('details: publisher campaigns show campaign, publisher and calls, with a capped total', () => {
  const pc = section(drawerCtx().renderDrawer({ ...AGENT, targets: TARGETS }), 'Publisher campaign IVRs');
  assert.match(pc, /<thead><tr><th>Campaign<\/th><th>Publisher<\/th><th class="num">Calls<\/th><\/tr><\/thead>/);
  assert.match(text(pc), /Find a Handyman \(Variable Rate\) Marketwisely, LLC 14 Pay Per Call API 1800Remodel/);
  assert.match(text(pc), /Top 2 of 15 campaigns · last 30 days 44$/, 'shown vs total, and all calls in the window');
  assert.doesNotMatch(pc, /<td><\/td>/, 'no empty cells');
});

test('details: buyer targets show advertiser, campaign with its vertical, and calls; header and body align', () => {
  const bt = section(drawerCtx().renderDrawer({ ...AGENT, targets: TARGETS }), 'Buyer targets');
  assert.match(bt, /<thead><tr><th>Advertiser<\/th><th>Campaign<\/th><th class="num">Calls<\/th><\/tr><\/thead>/);
  assert.doesNotMatch(bt, /<th>Publisher<\/th>/, 'no publisher column');
  assert.match(bt, /<td>RingPartner Pay Per Call<\/td><td>Handyman<span class="tgt-sub">Handyman \+2 more verticals<\/span><\/td><td class="num">10<\/td>/);
  assert.match(bt, /<td>Buyer &lt;B&gt;<\/td><td><span class="tgt-sub">No campaign<\/span><span class="tgt-sub">\(unknown\)<\/span><\/td>/, 'escaped, missing campaign labelled');
  assert.match(text(bt), /2 targets · last 30 days 15$/, 'routed calls');
  // Every column's header and cells share an alignment: text left, Calls right.
  assert.match(html, /\.canoe-table\.tgt-table thead th \{ text-align: left; \}/);
  assert.match(html, /\.canoe-table\.tgt-table \.num \{ text-align: right;/);
});

test('details: empty and failed states', () => {
  const ctx = drawerCtx();
  const quiet = ctx.renderDrawer({ ...AGENT, targets: { ...TARGETS, calls: 0, routed_calls: 0, publisher_campaigns: [], publisher_campaigns_total: 0, buyer_targets: [], buyer_targets_total: 0 } });
  assert.match(section(quiet, 'Publisher campaign IVRs'), /No calls in the last 30 days/);
  assert.match(section(quiet, 'Buyer targets'), /No calls in the last 30 days/);
  const unrouted = ctx.renderDrawer({ ...AGENT, targets: { ...TARGETS, routed_calls: 0, buyer_targets: [], buyer_targets_total: 0 } });
  assert.match(section(unrouted, 'Buyer targets'), /No calls reached a buyer in the last 30 days/);
  ctx.agentTargetsFailed = true;
  assert.equal(ctx.renderDrawer({ ...AGENT, targets: null }).split("Couldn't load. Reload the page to try again.").length - 1, 2);
});
