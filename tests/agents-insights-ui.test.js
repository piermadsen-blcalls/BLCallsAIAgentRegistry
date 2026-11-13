// UI cleanup pass 2 (Agents + Insights): details open under the clicked card's grid row (S-21b),
// Insights opens on default Before/After periods and runs once (S-29), plus the card, drawer, stats
// and Insights copy changes (S-18 to S-26, S-30, S-31). index.html has no build step, so the code is
// lifted out of the page and run with stubs. Run: node --test tests/
process.env.TZ = 'America/Denver';   // the Insights defaults are UTC days; prove they ignore local time
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// Source of a top-level `function name(` or `async function name(` declaration, by brace matching
// from the body's opening brace (after the parameter list, which may hold a `= new Date()` default).
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

// ── S-21b: details open right after the clicked card's grid row ─────────────
// A tiny DOM: nodes in parent child lists, with after() / nextElementSibling like the real thing.
function fakePage() {
  const nodeProto = {
    get nextElementSibling() { const k = this.parent ? this.parent.kids : []; return k[k.indexOf(this) + 1] || null; },
    after(x) {
      if (x.parent) x.parent.kids.splice(x.parent.kids.indexOf(x), 1);
      const k = this.parent.kids; k.splice(k.indexOf(this) + 1, 0, x); x.parent = this.parent;
    },
  };
  const node = props => Object.assign(Object.create(nodeProto), props);
  const body = node({ kids: [] });
  const grid = node({ kids: [], parent: body, cols: 3,
    querySelectorAll: sel => (assert.equal(sel, '.agent-card'), grid.kids.filter(k => k.card)) });
  // Setting innerHTML replaces the children (the details element, if inside, leaves the document).
  Object.defineProperty(grid, 'innerHTML', { set(h) {
    grid.kids.forEach(k => { k.parent = null; });
    grid.kids = [...h.matchAll(/data-idx="(\d+)"/g)].map(m => node({ card: true, dataset: { idx: m[1] }, parent: grid }));
  } });
  const drawer = node({ id: 'drawer-container', innerHTML: '', parent: body });
  body.kids.push(grid, drawer);
  const attached = n => { for (let p = n; p; p = p.parent) if (p === body) return true; return false; };
  const document = { getElementById: id => ({ 'agents-grid': grid, 'drawer-container': attached(drawer) ? drawer : null, 'search-input': { value: '' } })[id] || null };
  const getComputedStyle = el => ({ gridTemplateColumns: Array(el.cols).fill('336px').join(' ') });
  // Where the details are: 'after-grid', or the data-idx of the card right before them.
  const where = () => (drawer.parent === body ? (body.kids[body.kids.indexOf(drawer) - 1] === grid ? 'after-grid' : 'lost')
    : drawer.parent === grid ? grid.kids[grid.kids.indexOf(drawer) - 1].dataset.idx : 'detached');
  return { grid, drawer, document, getComputedStyle, where };
}
function placeCtx(over = {}) {
  const page = fakePage();
  const AGENTS = Array.from({ length: 7 }, (_, i) => ({ name: 'Agent ' + i, ivrName: 'IVR ' + i, vertical: 'Other' }));
  const ctx = load({ ...page, AGENTS, openAgent: null, agentLastCall: null, activeFilter: 'all', getSorted: a => [...a], aliasesForAgent: () => [],
    renderCard: (a, idx) => `<div class="agent-card" data-idx="${idx}"></div>`, ...over },
  ['function agentDrawerSlot(', 'function placeAgentDrawer(', 'function placeOpenAgentDrawer(', 'function needsSetup(', 'function agentLastDay(', 'function isInactive(', 'function byLastCall(', 'function applyFilters('], ['agentDrawerSlot', 'placeAgentDrawer', 'applyFilters']);
  ctx.page = page;
  return ctx;
}

test('S-21b: the row slot is the last card in the clicked card\'s row, or the last card on a short row', () => {
  const ctx = placeCtx();
  assert.equal(ctx.agentDrawerSlot(0, 3, 7), 2);
  assert.equal(ctx.agentDrawerSlot(2, 3, 7), 2);
  assert.equal(ctx.agentDrawerSlot(4, 3, 7), 5);
  assert.equal(ctx.agentDrawerSlot(6, 3, 7), 6, 'last, partial row');
  assert.equal(ctx.agentDrawerSlot(4, 1, 7), 4, 'one column (phones): right under the card');
});

test('S-21b: details sit right under the clicked card\'s row, follow a column change, and park when closed', () => {
  const ctx = placeCtx();
  const { grid, drawer, where } = ctx.page;
  ctx.applyFilters();
  assert.equal(where(), 'after-grid', 'closed: parked after the grid');

  ctx.openAgent = 1; ctx.applyFilters(true);   // first row (3 columns: cards 0-2)
  assert.equal(where(), '2', 'first row: after its last card, not after all 7');
  ctx.openAgent = 4; ctx.applyFilters(true);   // middle row (cards 3-5)
  assert.equal(where(), '5');
  ctx.openAgent = 6; ctx.applyFilters(true);   // last row holds one card
  assert.equal(where(), '6');

  ctx.openAgent = 4; ctx.applyFilters(true);
  grid.cols = 2; ctx.placeAgentDrawer(grid, drawer);   // resize: rows are now 0-1, 2-3, 4-5
  assert.equal(where(), '5');
  grid.cols = 4; ctx.placeAgentDrawer(grid, drawer);   // rows 0-3, 4-6
  assert.equal(where(), '6');
  grid.cols = 1; ctx.placeAgentDrawer(grid, drawer);
  assert.equal(where(), '4');
});

test('S-21b: a grid re-render keeps the open details (same element, same content) under the row', () => {
  const ctx = placeCtx();
  const { drawer, where } = ctx.page;
  ctx.openAgent = 3; ctx.applyFilters(true);
  drawer.innerHTML = '<div class="detail-drawer">Agent 3</div>';
  ctx.applyFilters(true);   // e.g. agent quality landing, or a saved test call
  assert.equal(ctx.openAgent, 3);
  assert.equal(where(), '5', 'still after the row: the element is grabbed before the grid is rewritten');
  assert.equal(drawer.innerHTML, '<div class="detail-drawer">Agent 3</div>');
  assert.ok(ctx.document.getElementById('drawer-container'), 'closeDrawer/retry still find it by id');

  ctx.applyFilters();   // a search/filter change closes it
  assert.equal(ctx.openAgent, null);
  assert.equal(drawer.innerHTML, '');
  assert.equal(where(), 'after-grid');
});

test('S-21b: an open agent filtered out of the grid parks its details after the grid', () => {
  const ctx = placeCtx({ getSorted: a => a.filter(x => x.name !== 'Agent 2') });
  ctx.openAgent = 2; ctx.applyFilters(true);
  assert.equal(ctx.page.where(), 'after-grid');
});

test('S-21b: cards carry data-idx, which placement and the scroll-to-card look up', () => {
  assert.match(lift('function renderCard('), /data-idx="\$\{idx\}"/);
  assert.match(lift('async function toggleAgent('), /\.agent-card\[data-idx="\$\{idx\}"\]/);
});

// ── S-29: Insights default periods + one run on first open ──────────────────
test('S-29: After = the last 7 complete UTC days, Before = the 7 days before that, whatever the local time', () => {
  const ctx = load({}, ['function insDefaultPeriods('], ['insDefaultPeriods']);
  const plain = o => JSON.parse(JSON.stringify(o));
  const nov = { a: { start: '2026-10-30', end: '2026-11-05' }, b: { start: '2026-11-06', end: '2026-11-12' } };
  assert.deepEqual(plain(ctx.insDefaultPeriods(new Date('2026-11-13T03:00:00Z'))), nov, 'still Nov 12 in Denver; Nov 13 in UTC');
  assert.deepEqual(plain(ctx.insDefaultPeriods(new Date('2026-11-13T23:59:00Z'))), nov);
  assert.deepEqual(plain(ctx.insDefaultPeriods(new Date('2026-03-01T00:30:00Z'))),
    { a: { start: '2026-02-15', end: '2026-02-21' }, b: { start: '2026-02-22', end: '2026-02-28' } }, 'across a month end');
  const p = ctx.insDefaultPeriods(new Date('2027-01-03T12:00:00Z'));
  const days = r => (Date.parse(r.end) - Date.parse(r.start)) / 86400000 + 1;
  assert.equal(days(p.a), 7); assert.equal(days(p.b), 7);
  assert.equal(Date.parse(p.b.start) - Date.parse(p.a.end), 86400000, 'back to back, no gap or overlap');
  assert.equal(p.b.end, '2027-01-02');
});

function insightsCtx() {
  const els = {};
  const el = id => els[id] || (els[id] = { id, textContent: '', classList: { removed: [], remove(c) { this.removed.push(c); } } });
  const ctx = load({
    document: { getElementById: el }, els, runs: 0, runInsights() { ctx.runs++; ctx.ranWith = JSON.parse(JSON.stringify(ctx.insPeriods)); },
    insInitDone: false,
    insPeriods: { a: { start: null, end: null }, b: { start: null, end: null } },
    insDrpState: { a: { year: 0, month: 0, pickStart: null, pickEnd: null, selecting: false }, b: { year: 0, month: 0, pickStart: null, pickEnd: null, selecting: false } },
  }, ['function fmtShortD(', 'function insDrpApply(', 'function insDefaultPeriods(', 'function insightsInit('], ['insightsInit', 'insDefaultPeriods', 'insDrpApply']);
  return ctx;
}

test('S-29: first open sets both periods and labels, runs the analysis once; later opens do not reset or rerun', () => {
  const ctx = insightsCtx();
  const d = JSON.parse(JSON.stringify(ctx.insDefaultPeriods()));
  ctx.insightsInit();
  assert.equal(ctx.runs, 1);
  assert.deepEqual(ctx.ranWith, d, 'ran on the defaults');
  const fmt = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  assert.equal(ctx.els['ins-drp-a-label'].textContent, `${fmt(d.a.start)} – ${fmt(d.a.end)}`);
  assert.equal(ctx.els['ins-drp-b-label'].textContent, `${fmt(d.b.start)} – ${fmt(d.b.end)}`);
  assert.equal(ctx.insDrpState.b.pickStart, d.b.start, 'the calendar opens on the default range');
  assert.equal(ctx.insDrpState.b.pickEnd, d.b.end);

  // Manual picking still works, and switching back to the tab keeps it.
  Object.assign(ctx.insDrpState.a, { pickStart: '2026-09-01', pickEnd: '2026-09-30' });
  ctx.insDrpApply('a');
  ctx.insightsInit();
  assert.equal(ctx.runs, 1, 'runs once');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.insPeriods.a)), { start: '2026-09-01', end: '2026-09-30' });
  assert.equal(ctx.els['ins-drp-a-label'].textContent, 'Sep 1 – Sep 30');
});

test('S-29: opening the tab (also from ?tab=insights) runs the first-open setup', () => {
  const calls = [];
  const pane = { classList: { add() {}, remove() {} } };
  const ctx = load({
    currentTab: 'agents', _suppressRoute: true, agentsMetricsDeferred: false, navBtnFor: () => null,
    document: { querySelectorAll: () => [], getElementById: () => pane },
    ensureVerticals: () => calls.push('verticals'), insightsInit: () => calls.push('init'),
    crAutoLoad() {}, reviewInit() {}, scoresInit() {}, ensureCompliance() {}, refreshMetrics() {},
  }, ['function switchTab('], ['switchTab']);
  ctx.switchTab('insights');
  assert.deepEqual(calls, ['verticals', 'init']);
  ctx.switchTab('calls');
  assert.equal(calls.length, 2);
});

test('S-29 + S-32: the period bar says Before / After with no "vs" badge or instructions; conversion threshold is in pp', () => {
  const bar = html.slice(html.indexOf('<div id="tab-insights"'), html.indexOf('<!-- CALL REPORTING TAB -->'));
  assert.match(bar, /<div class="period-label-sm">Before<\/div>[\s\S]*<div class="period-label-sm">After<\/div>/);
  assert.doesNotMatch(bar, /vs-badge|Period A|Period B|Select dates|Set your periods/);
  assert.match(bar, /id="thr-conv"[^>]*>\s*<span class="threshold-unit">pp<\/span>/);
});

// ── S-30 / S-31: Insights sections ──────────────────────────────────────────
const INS = ['function esc(', 'function nullMark(', 'function fmtShortD(', 'function insConv(', 'function insFmtDelta(', 'function insFmtRev(',
  'function insFmtConv(', 'function insPeriodLabel(', 'function insSortRows(', 'function insRenderSection(', 'function insExpandContent('];
const t = (raw, rev) => ({ raw, sent: raw, paid: Math.round(raw / 4), rev, margin: rev / 2, byAgent: { 'ASCND - Roofing': { raw, paid: 1, rev } } });
const pA = { start: '2026-10-30', end: '2026-11-05' }, pB = { start: '2026-11-06', end: '2026-11-12' };

test('S-30: section count says movers', () => {
  const ctx = load({ insSortState: { pub: { col: 'dRev', dir: -1 } } }, INS, ['insRenderSection']);
  const row = key => ({ key, a: t(100, 1000), b: t(50, 400), dRev: -600, dMargin: -300, dRevPct: -60, dConv: 0 });
  assert.match(ctx.insRenderSection('pub', 'Publishers', [row('A'), row('B')], pA, pB), /<div class="section-count">2 movers<\/div>/);
  assert.match(ctx.insRenderSection('pub', 'Publishers', [row('A')], pA, pB), /<div class="section-count">1 mover<\/div>/);
  assert.match(ctx.insRenderSection('pub', 'Publishers', [], pA, pB), /0 movers/);
  assert.doesNotMatch(ctx.insRenderSection('pub', 'Publishers', [row('A')], pA, pB), /flagged|Rev A|Rev B/);
});

test('S-31: an expanded row keeps both periods\' stats and the agent breakdown, without "What changed"', () => {
  const ctx = load({}, INS, ['insExpandContent']);
  const out = text(ctx.insExpandContent({ key: 'Pub A', a: t(100, 1000), b: t(40, 300), dRev: -700, dMargin: -350, dRevPct: -70, dConv: 0 }, pA, pB));
  assert.doesNotMatch(out, /What changed|▲|▼/);
  assert.match(out, /Before: Oct 30 – Nov 5 100 raw · 25 paid · 25\.0% conv · \$1\.0k/);
  assert.match(out, /After: Nov 6 – Nov 12 40 raw · 10 paid · 25\.0% conv · \$300/);
  assert.match(out, /Agent breakdown \(top movers\) Agent Raw before Raw after Rev before Rev after ∆ Rev ASCND - Roofing 100 40 \$1\.0k \$300/);
});

// ── S-18 / S-19 / S-20: cards ───────────────────────────────────────────────
function cardCtx(over = {}) {
  return load({ metricsFailed: false, openAgent: null, agentLastCall: null, testCallMap: {}, vClass: () => 'v-other', fmtPct: (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '-'),
    aeCardLine: () => '', ...over },
  ['function esc(', 'function nullMark(', 'function httpUrl(', 'function needsSetup(', 'function isInactive(', 'function getEffectiveStatus(', 'function renderTestCallRow(', 'function renderCard('], ['renderCard']);
}
const card = over => ({ name: 'Roofing', ivrName: 'IVR Roof', vertical: 'Home Services', status: 'live', routingType: 'publisher-led', raw_calls: 10, paid_calls: 2, revenue: 50, ...over });

test('S-19 + S-20: a live card has no status chip and no routing line; exceptions keep their chip', () => {
  const ctx = cardCtx();
  const live = ctx.renderCard(card(), 0);
  assert.doesNotMatch(live, /card-status|>Live</);
  assert.doesNotMatch(live, /card-routing|publisher-led/);
  assert.match(ctx.renderCard(card({ raw_calls: 0 }), 0), /status-inactive">Inactive</);
  assert.match(ctx.renderCard(card({ status: 'test' }), 0), /status-test">Test</);
  assert.match(ctx.renderCard(card({ status: 'needs_setup' }), 0), /status-setup">New · needs setup</);
  ctx.metricsFailed = true;
  assert.match(ctx.renderCard(card(), 0), /status-inactive">No data</);
});

test('S-18: the card shows a test-call link only when there is a URL, and no add/edit controls', () => {
  const ctx = cardCtx({ testCallMap: { 'IVR Roof': 'https://example.invalid/call', 'IVR Bad': 'javascript:alert(1)' } });
  const withUrl = ctx.renderCard(card(), 0);
  assert.match(withUrl, /<a class="card-test-link" href="https:\/\/example\.invalid\/call"[^>]*>Test call<\/a>/);
  assert.doesNotMatch(withUrl, /Edit|tcShowEdit|tcStartEdit/);
  for (const ivrName of ['IVR None', 'IVR Bad']) {
    const none = ctx.renderCard(card({ ivrName }), 1);
    assert.doesNotMatch(none, /card-test-call|No test call|\+ add/);
  }
});

// ── S-18 / S-23 / S-24 / S-26: agent details ────────────────────────────────
function drawerCtx(over = {}) {
  const els = {};
  const ctx = load({
    metricsFailed: false, agentTargetsFailed: false, openAgent: 0, tcEdit: null, testCallMap: {}, activeRange: { label: 'Oct 14, 2026 – Nov 12, 2026' },
    aeDrawerHtml: () => '<div class="dsec-title">Agent quality</div>', console: { warn() {} }, redraws: 0,
    applyFilters(keep) { ctx.redraws++; ctx.keptOpen = keep; },
    document: { getElementById: id => els[id] || null },
    els, sent: [], sbFetch: async (url, opts) => { ctx.sent.push({ url, body: JSON.parse(opts.body) }); if (ctx.failSave) throw new Error('Supabase 401'); return []; },
    ...over,
  }, ['function esc(', 'function nullMark(', 'function fmtPct(', 'function httpUrl(', 'function rtLabel(', 'function needsSetup(', 'function getEffectiveStatus(',
    'function bdPending(', 'async function saveTestCall(', 'function renderDrawerTestCall(', 'function tcRedraw(', 'function tcStartEdit(', 'function tcCancel(',
    'async function tcSave(', 'function renderDrawer('], ['renderDrawer', 'renderDrawerTestCall', 'tcStartEdit', 'tcCancel', 'tcSave']);
  // tcRedraw swaps #dtc-row's outerHTML: re-point the fake elements at the new markup.
  const row = { set outerHTML(h) { ctx.dtc = h; els['dtc-input'] = /id="dtc-input"/.test(h) ? { focus() { ctx.focused = true; } } : undefined;
    els['dtc-save'] = /id="dtc-save"/.test(h) ? { disabled: false, textContent: 'Save' } : undefined; els['dtc-err'] = /id="dtc-err"/.test(h) ? { textContent: '' } : undefined; } };
  els['dtc-row'] = row;
  return ctx;
}
const AGENT = { name: 'Roofing', ivrName: 'IVR Roof', vertical: 'Home Services', status: 'live', routingType: 'publisher-led', qualifying: [], targets: null,
  raw_calls: 200, sent_calls: 90, paid_calls: 40, revenue: 4000, margin: 1234, _bdKey: 'Oct 14, 2026 – Nov 12, 2026', pubBreakdown: [], advBreakdown: [] };

test('S-23 + S-24 + S-26: details show the range once, Sent / raw and Direct margin in the meta line, no perf strip, plain empty states', () => {
  const ctx = drawerCtx();
  const out = ctx.renderDrawer(AGENT);
  assert.equal(out.split('Oct 14, 2026 – Nov 12, 2026').length - 1, 1, 'range once');
  assert.match(text(out), /Home Services · publisher-led Oct 14, 2026 – Nov 12, 2026 · Sent \/ raw 45\.0% · Direct margin \$1,234/);
  assert.doesNotMatch(out, /perf-strip|Paid \/ raw|Raw calls/);
  assert.match(out, /<div class="dsec-title">Publishers<\/div>/);
  assert.match(out, /<div class="dsec-title">Advertisers<\/div>/);
  assert.doesNotMatch(out, /sending traffic|buying calls|No publisher campaign|No IVR targets|qualification data|Internal test agent|selected period/);
  assert.equal(out.split('<div class="canoe-none">None</div>').length - 1, 1, 'qualifying');
  assert.equal(out.split('<div class="canoe-none">No calls in the last 30 days</div>').length - 1, 2, 'campaign IVRs, buyer targets');
  assert.equal(out.split('No calls in this range').length - 1, 2, 'both breakdowns');
  assert.match(ctx.renderDrawer({ ...AGENT, status: 'test', qualifying: ['Owns the home'] }), /Qualifying for<\/div><div class="canoe-none">None</);
  ctx.metricsFailed = true;
  assert.match(text(ctx.renderDrawer(AGENT)), /Sent \/ raw - · Direct margin -/);
});

test('S-18: the test call is added and edited in the details, through saveTestCall', async () => {
  const ctx = drawerCtx({ AGENTS: [AGENT] });
  assert.match(ctx.renderDrawer(AGENT), /<button class="rv-btn" onclick="tcStartEdit\(\)">Add test call<\/button>/);
  ctx.tcStartEdit();
  assert.match(ctx.dtc, /id="dtc-input"[^>]*value=""/);
  assert.ok(ctx.focused, 'focus lands in the input');
  assert.match(ctx.renderDrawer(AGENT), /id="dtc-input"/, 'a re-render while editing keeps the input');

  ctx.tcEdit.draft = '  https://example.invalid/t1  ';
  await ctx.tcSave();
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].url, 'agent_test_calls?on_conflict=ivr_name');
  assert.equal(ctx.sent[0].body.ivr_name, 'IVR Roof');
  assert.equal(ctx.sent[0].body.url, 'https://example.invalid/t1');
  assert.equal(ctx.testCallMap['IVR Roof'], 'https://example.invalid/t1');
  assert.equal(ctx.tcEdit, null);
  assert.match(ctx.dtc, /href="https:\/\/example\.invalid\/t1"[^>]*>Test call<\/a><button class="rv-btn" onclick="tcStartEdit\(\)">Edit<\/button>/);
  assert.deepEqual([ctx.redraws, ctx.keptOpen], [1, true], 'cards re-render with the details kept open');

  ctx.tcStartEdit();
  assert.match(ctx.dtc, /value="https:\/\/example\.invalid\/t1"/, 'edit starts from the saved link');
  ctx.tcCancel();
  assert.match(ctx.dtc, />Edit</);

  ctx.failSave = true;
  ctx.tcStartEdit();
  ctx.tcEdit.draft = 'https://example.invalid/t2';
  await ctx.tcSave();
  assert.equal(ctx.tcEdit.draft, 'https://example.invalid/t2', 'a failed save keeps the draft');
  assert.match(ctx.els['dtc-err'].textContent, /Couldn't save the test call/);
  assert.equal(ctx.els['dtc-save'].disabled, false);
  assert.equal(ctx.testCallMap['IVR Roof'], 'https://example.invalid/t1');
});

// ── S-22: header stats ──────────────────────────────────────────────────────
test('S-22: "live agents" counts live agents only; zero money reads $0; dashes before the first load', () => {
  const els = {};
  const ctx = load({
    metricsFailed: false, metricsSeq: 1, agentLastCall: null,
    AGENTS: [{ status: 'live', raw_calls: 5, revenue: 1234, margin: 0 }, { status: 'live', raw_calls: 0 }, { status: 'test', raw_calls: 9 }, { status: 'needs_setup', raw_calls: 3 }],
    document: { getElementById: id => els[id] || (els[id] = { innerHTML: '', textContent: '' }) },
  }, ['function nullMark(', 'function needsSetup(', 'function getEffectiveStatus(', 'function recomputeStats('], ['recomputeStats']);
  ctx.recomputeStats();
  assert.equal(String(els['stat-agents'].innerHTML), '1');
  assert.equal(els['stat-calls'].innerHTML, '17');
  assert.equal(els['stat-revenue'].innerHTML, '$1.2k');
  assert.equal(els['stat-margin'].innerHTML, '$0');
  ctx.metricsSeq = 0;
  ctx.recomputeStats();
  assert.match(els['stat-agents'].innerHTML, /null-mark/);
  assert.match(els['stat-revenue'].innerHTML, /null-mark/);
  assert.match(html, /<div class="stat-label">live agents<\/div>/);
});

// ── S-21b + inactive agents (PR #16): the details open in whichever grid holds the card ──
test('S-21b: an inactive agent\'s details open in the Inactive grid; closed, they park after the main grid', () => {
  const calls = [], els = { 'agents-grid': { id: 'main' }, 'agents-inactive-grid': { id: 'inactive' }, 'drawer-container': { id: 'drawer' } };
  const ctx = load({
    AGENTS: [{ name: 'Live' }, { name: 'Gone' }], openAgent: null,
    isInactive: a => a.name === 'Gone',
    placeAgentDrawer: (grid, drawer, park) => calls.push([grid.id, drawer && drawer.id, park.id]),
    document: { getElementById: id => els[id] || null },
  }, ['function placeOpenAgentDrawer('], ['placeOpenAgentDrawer']);
  vm.runInContext('openAgent = 1', ctx); ctx.placeOpenAgentDrawer();
  vm.runInContext('openAgent = 0', ctx); ctx.placeOpenAgentDrawer();
  vm.runInContext('openAgent = null', ctx); ctx.placeOpenAgentDrawer();
  const held = { id: 'held' };   // a grid rewrite detached it: the caller passes the element it grabbed
  vm.runInContext('openAgent = 1', ctx); ctx.placeOpenAgentDrawer(held);
  assert.deepEqual(calls, [['inactive', 'drawer', 'main'], ['main', 'drawer', 'main'], ['main', 'drawer', 'main'], ['inactive', 'held', 'main']]);
});
