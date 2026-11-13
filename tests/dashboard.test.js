// Dashboard tab (MK-176, PR 2): filters, the Calls Breakdown / Calls Payout cards from one
// dashboard_summary RPC (064), and the calls export. index.html has no build step, so the
// Dashboard section is cut out of the page and run against a fake DOM and PostgREST.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const section = html.slice(html.indexOf('// ─── DASHBOARD TAB (MK-176)'), html.indexOf('// ─── INSIGHTS TAB'));
// Source of a top-level `function name(` or `async function name(` declaration, by brace matching.
function lift(decl) {
  const start = html.indexOf(decl);
  assert.ok(start >= 0, `${decl} not found in index.html`);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(start, i + 1);
}

function fakeEl(id) {
  const set = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', disabled: false, max: '', style: {},
    classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
      toggle: (c, on = !set.has(c)) => (on ? set.add(c) : set.delete(c)) },
    querySelector: () => null, focus() {},
  };
}
function fakeDoc() {
  const els = {};
  return { els, getElementById: id => els[id] || (els[id] = fakeEl(id)), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
}
const SUMMARY = {
  from: '2026-10-14', to: '2026-11-12', prev_from: '2026-09-14', prev_to: '2026-10-13',
  current:  { calls: 55690, unique_calls: 47325, paid_calls: 13874, revenue: 490345.12, publisher_cost: 312000, margin: 178345.12,
              unique_pct: 0.8498, paid_pct: 0.2491, revenue_per_call: 8.8, revenue_per_paid_call: 35.34, margin_pct: 0.3637 },
  previous: { calls: 50000, unique_calls: 47325, paid_calls: 14000, revenue: 500000, publisher_cost: 300000, margin: 200000,
              unique_pct: 0.9465, paid_pct: 0.28, revenue_per_call: 10, revenue_per_paid_call: 35.71, margin_pct: 0.4 },
};

// The Dashboard section in a sandbox. rpc(body) answers dashboard_summary; log records calls.
function dashboard({ rpc = async () => SUMMARY, now } = {}) {
  const log = [], doc = fakeDoc();
  const ctx = {
    document: doc, console, log, VERTICALS: ['Roofing', 'Solar'],
    ensureVerticals: async () => {}, esc: s => String(s).replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    nullMark: () => '<span class="null-mark">-</span>', fmtShortD: iso => iso, pgQuote: v => '"' + String(v).replace(/"/g, '\\"') + '"',
    loadErrorHtml: (thing, retry) => `ERROR ${thing} ${retry}`,
    setTimeout: (fn, ms) => ({ fn, ms }), clearTimeout: () => {},
    callsExportCsv: async (filters, filename, onPage) => { log.push({ export: filters, filename }); onPage(1000); return 1000; },
    sbFetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      log.push({ url, body });
      if (url === 'rpc/get_distinct_accounts') return [{ account_name: 'Pub, A (1)', account_type: 'publisher' }, { account_name: 'Adv X', account_type: 'advertiser' }];
      return rpc(body);
    },
  };
  if (now) ctx.Date = class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return Date.parse(now); } };
  vm.runInNewContext(section + `
    this.dashUtcDay = dashUtcDay; this.dashPresetRange = dashPresetRange; this.dashInit = dashInit; this.dashLoad = dashLoad;
    this.dashSetPreset = dashSetPreset; this.dashCustomChange = dashCustomChange; this.dashMsPick = dashMsPick; this.dashMsClear = dashMsClear;
    this.dashFilterBody = dashFilterBody; this.dashSummaryHtml = dashSummaryHtml; this.dashDelta = dashDelta; this.dashMoney = dashMoney;
    this.dashExportFilters = dashExportFilters; this.dashExport = dashExport; this.dashOpts = dashOpts; this.dashSel = dashSel;`, ctx);
  return { ctx, doc, log };
}
const tick = () => new Promise(r => setImmediate(r));
const plain = x => JSON.parse(JSON.stringify(x));

test('Dashboard: nothing loads at boot; the tab loads on first open, once', () => {
  const calls = [...html.matchAll(/dashInit\(\)/g)].length;
  assert.equal(calls, 2, 'declared once and called once');
  assert.match(lift('function switchTab('), /if \(id === 'dashboard'\) dashInit\(\);/);
  assert.equal([...html.matchAll(/rpc\/dashboard_summary/g)].length, 1, 'one RPC call site, inside dashLoad');
  assert.ok(lift('async function dashLoad(').includes("'rpc/dashboard_summary'"));
  assert.match(html, /<button class="nav-tab" onclick="switchTab\('dashboard',this\)">Dashboard<\/button>/);
  assert.match(html, /<div id="tab-insights" class="tab-pane">/, 'Insights stays');
});

test('Dashboard: presets are the last N complete UTC days, whatever the local time', () => {
  const { ctx } = dashboard();
  assert.deepEqual(plain(ctx.dashPresetRange(30, new Date('2026-11-13T00:30:00Z'))), { from: '2026-10-14', to: '2026-11-12' });
  assert.deepEqual(plain(ctx.dashPresetRange(7, new Date('2026-11-13T23:59:00Z'))), { from: '2026-11-06', to: '2026-11-12' });
  assert.deepEqual(plain(ctx.dashPresetRange(90, new Date('2026-03-01T12:00:00Z'))), { from: '2025-12-01', to: '2026-02-28' });
});

test('Dashboard: first open runs one summary RPC with no filters and renders both cards', async () => {
  const { ctx, doc, log } = dashboard({ now: '2026-11-13T15:00:00Z' });
  ctx.dashInit();
  ctx.dashInit();   // reopening the tab doesn't reload
  await tick(); await tick();
  const rpcs = log.filter(l => l.url === 'rpc/dashboard_summary');
  assert.equal(rpcs.length, 1);
  assert.deepEqual(rpcs[0].body, { from_day: '2026-10-14', to_day: '2026-11-12', verticals: null, publishers: null, advertisers: null });
  const out = doc.els['dash-output'].innerHTML;
  for (const s of ['Calls Breakdown', 'Calls Payout', '55,690', '47,325', '85.0%', '13,874', '24.9%', '$490,345', '$8.80', '$35.34', '$312,000', '$178,345', '36.4%'])
    assert.ok(out.includes(s), `cards show ${s}`);
  assert.equal(doc.els['dash-period'].textContent, '2026-10-14 – 2026-11-12, compared with 2026-09-14 – 2026-10-13 (UTC days)');
  assert.equal(doc.els['dash-export-btn'].textContent, 'Export 55,690 calls');
  assert.equal(doc.els['dash-export-btn'].disabled, false);
  assert.deepEqual(plain(ctx.dashOpts.publisher), ['Pub, A (1)']);
  assert.deepEqual(plain(ctx.dashOpts.vertical), ['Roofing', 'Solar']);
});

test('Dashboard: picks become RPC arrays, Clear goes back to all, a custom range swaps reversed dates', async () => {
  const { ctx, doc, log } = dashboard({ now: '2026-11-13T15:00:00Z' });
  ctx.dashInit(); await tick(); await tick();
  ctx.dashOpts.publisher = ['Pub, A (1)', 'Pub B'];
  ctx.dashMsPick('publisher', 0, true); ctx.dashMsPick('publisher', 1, true); ctx.dashMsPick('vertical', 1, true);
  assert.equal(doc.els['dash-ms-publisher-label'].textContent, '2 publishers');
  assert.equal(doc.els['dash-ms-vertical-label'].textContent, 'Solar');
  assert.deepEqual(plain(ctx.dashFilterBody()), { from_day: '2026-10-14', to_day: '2026-11-12', verticals: ['Solar'], publishers: ['Pub, A (1)', 'Pub B'], advertisers: null });
  ctx.dashMsClear('publisher');
  assert.equal(ctx.dashFilterBody().publishers, null);
  assert.equal(doc.els['dash-ms-publisher-label'].textContent, 'All publishers');

  ctx.dashSetPreset('custom');
  assert.equal(doc.els['dash-from'].value, '2026-10-14', 'custom starts from the range on screen');
  assert.equal(doc.els['dash-to'].max, '2026-11-13', 'no future days');
  doc.els['dash-from'].value = '2026-11-05'; doc.els['dash-to'].value = '2026-11-01';
  ctx.dashCustomChange(); await tick();
  assert.deepEqual(log.at(-1).body.from_day + '/' + log.at(-1).body.to_day, '2026-11-01/2026-11-05');
});

test('Dashboard: a slower earlier load never overwrites a newer one; a failure shows Retry', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  let n = 0;
  const { ctx, doc } = dashboard({ rpc: async () => (++n === 1 ? slow : { ...SUMMARY, current: { ...SUMMARY.current, calls: 7 } }) });
  ctx.dashInit();
  ctx.dashSetPreset(7); await tick(); await tick();
  assert.ok(doc.els['dash-output'].innerHTML.includes('>7<'), 'newer result shown');
  release(SUMMARY); await tick(); await tick();
  assert.ok(doc.els['dash-output'].innerHTML.includes('>7<'), 'stale result dropped');

  const failing = dashboard({ rpc: async () => { throw new Error('Supabase 500'); } });
  failing.ctx.dashInit(); await tick(); await tick();
  assert.equal(failing.doc.els['dash-output'].innerHTML, 'ERROR the dashboard dashLoad()');
  assert.equal(failing.doc.els['dash-export-btn'].disabled, true, 'nothing to export');
});

test('Dashboard: change vs previous period', () => {
  const { ctx } = dashboard();
  assert.deepEqual(plain(ctx.dashDelta(55690, 50000)), { text: '▲ 11.4%', cls: 'up' });
  assert.deepEqual(plain(ctx.dashDelta(490345, 500000)), { text: '▼ 1.9%', cls: 'down' });
  assert.deepEqual(plain(ctx.dashDelta(312000, 300000, false)), { text: '▲ 4.0%', cls: '' }, 'publisher cost: no good/bad color');
  assert.deepEqual(plain(ctx.dashDelta(100, 100)), { text: '0.0%', cls: '' });
  assert.deepEqual(plain(ctx.dashDelta(5, 0)), { text: 'new', cls: '' });
  assert.deepEqual(plain(ctx.dashDelta(5, null)), { text: '', cls: '' });
  assert.deepEqual(plain(ctx.dashDelta(-50, -100)), { text: '▲ 50.0%', cls: 'up' }, 'a smaller loss is up');
  assert.equal(ctx.dashMoney(-1234.5), '-$1,235');
  assert.equal(ctx.dashMoney(8.8, true), '$8.80');
  const out = ctx.dashSummaryHtml(SUMMARY);
  assert.ok(out.includes('<div class="dash-delta up" title="Previous period: 50,000">▲ 11.4%</div>'), 'calls up, previous on hover');
  assert.ok(out.includes('<div class="dash-delta " title="Previous period: $300,000">▲ 4.0%</div>'), 'cost neutral');
  const empty = ctx.dashSummaryHtml({ ...SUMMARY, current: { ...SUMMARY.current, calls: 0, revenue_per_call: null } });
  assert.ok(empty.includes('<div class="dash-val"><span class="null-mark">-</span></div>'), 'no calls: no average');
});

test('Dashboard: export is the Calls CSV for the same UTC days and filters, test calls excluded', async () => {
  const { ctx, doc, log } = dashboard({ now: '2026-11-13T15:00:00Z' });
  const q = ctx.dashExportFilters({ from_day: '2026-10-01', to_day: '2026-10-31', verticals: ['Auto Insurance (Insured)'], publishers: ['Pub, A'], advertisers: null });
  assert.equal(decodeURIComponent(q),
    '&created_at=gte.2026-10-01T00:00:00Z&created_at=lt.2026-11-01T00:00:00Z&is_test=not.is.true'
    + '&vertical_name=in.("Auto Insurance (Insured)")&publisher_name=in.("Pub, A")');
  ctx.dashInit(); await tick(); await tick();
  await ctx.dashExport();
  const ex = log.find(l => l.export);
  assert.equal(ex.filename, 'calls_2026-10-14_to_2026-11-12.csv');
  assert.equal(decodeURIComponent(ex.export),
    '&created_at=gte.2026-10-14T00:00:00Z&created_at=lt.2026-11-13T00:00:00Z&is_test=not.is.true', 'no filters picked: only the days');
  assert.equal(doc.els['dash-export-btn'].textContent, 'Export 55,690 calls', 'label restored');
});

test('Calls export: the shared CSV writer pages to the end, reports progress and keeps the Calls filename', async () => {
  const pages = [Array(1000).fill({ id: 'x', ivr_name: 'IVR', flags: [] }), Array(3).fill({ id: 'y', ivr_name: 'IVR', publisher_name: 'P', flags: ['geo_mismatch'] })];
  const seen = [], progress = [];
  let csv = null, filename = null;
  const anchor = { click() {}, set download(v) { filename = v; } };
  const ctx = {
    compAssignments: [{ account_type: 'publisher', account_name: 'P', manager_name: 'M' }], compLoadAssignments: async () => {},
    AGENTS: [], aliasesForAgent: () => [], crBuildQuery: (offset, filters) => `${filters}@${offset}`,
    sbFetch: async (q) => { seen.push(q); return pages.shift() || []; },
    Blob: class { constructor(parts) { csv = parts.join(''); } }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { createElement: () => anchor, body: { appendChild() {}, removeChild() {} } },
  };
  vm.runInNewContext(lift('async function callsExportCsv(') + ';this.callsExportCsv = callsExportCsv;', ctx);
  assert.equal(await ctx.callsExportCsv('&f=1', 'out.csv', n => progress.push(n)), 1003);
  assert.deepEqual(seen, ['&f=1@0', '&f=1@1000']);
  assert.deepEqual(progress, [1000, 1003]);
  assert.equal(filename, 'out.csv');
  assert.equal(csv.split('\n').length, 1004, 'header + rows');
  assert.ok(csv.includes(',P,M,'), 'publisher manager column');
  pages.length = 0;
  assert.equal(await ctx.callsExportCsv('&f=2', 'none.csv'), 0, 'nothing matched: no file');

  const cr = lift('async function crExportAll(');
  assert.match(cr, /callsExportCsv\(scope\.table, `call_report_\$\{scope\.start\}_to_\$\{scope\.end\}\.csv`\)/, 'Calls keeps its filter snapshot and filename');
});
