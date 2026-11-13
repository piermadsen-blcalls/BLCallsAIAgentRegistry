// Calls page overview (MK-176): the filter bar on Mountain Time days, the five overview cards (one
// RPC each over the 064/065 rollups), the outcome drill-down into the list, the quality gauge and
// trend, CPA by publisher / tier, and the list strip read from the rollups. index.html has no build
// step, so the overview section is cut out of the page and run against a fake DOM and PostgREST.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const section = html.slice(html.indexOf('// ─── CALLS PAGE OVERVIEW (MK-176)'), html.indexOf('// ─── INSIGHTS TAB'));
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
const SCORES_TIERS_SRC = 'var SCORES_TIERS = ' + html.match(/const SCORES_TIERS = (\{[\s\S]*?\n\});/)[1];

function fakeEl(id) {
  const set = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', disabled: false, max: '', style: {}, clientWidth: 700, options: [],
    classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
      toggle: (c, on = !set.has(c)) => (on ? set.add(c) : set.delete(c)) },
    querySelector: () => null, focus() {}, scrollIntoView() { this.scrolled = true; },
    appendChild(o) { this.options.push(o); },
  };
}
function fakeDoc() {
  const els = {};
  const doc = { els, getElementById: id => els[id] || (els[id] = fakeEl(id)), querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => ({}) };
  // The list's Outcome select: its options are the Outcomes optgroup's plus the groups.
  const sel = doc.getElementById('cr-outcome-filter'), list = doc.getElementById('cr-outcome-list');
  list.options = sel.options = [{ value: '' }, { value: 'group:qualified' }, { value: 'group:adv_pos' }, { value: 'group:adv_neg' }, { value: 'sale' }, { value: 'voicemail' }];
  return doc;
}
const SUMMARY = {
  from: '2026-10-13', to: '2026-11-11', prev_from: '2026-09-13', prev_to: '2026-10-12',
  current:  { calls: 55690, unique_calls: 47325, paid_calls: 13874, scored: 25273, revenue: 490345.12, publisher_cost: 312000, margin: 178345.12,
              unique_pct: 0.8498, paid_pct: 0.2491, revenue_per_call: 8.8, revenue_per_paid_call: 35.34, margin_pct: 0.3637 },
  previous: { calls: 50000, unique_calls: 47325, paid_calls: 14000, scored: 24000, revenue: 500000, publisher_cost: 300000, margin: 200000,
              unique_pct: 0.9465, paid_pct: 0.28, revenue_per_call: 10, revenue_per_paid_call: 35.71, margin_pct: 0.4 },
};
const OUTCOMES = { calls: 55690, scored: 25273, not_scored: 30417, qualified: 2200, qualified_rate: 0.0395, qualified_pct_of_scored: 0.087,
  conversions: 1800, conversion_rate: 0.0323,
  outcomes: [{ outcome: 'ivr_hangup', calls: 6500, pct_of_scored: 0.2572 }, { outcome: 'appointment', calls: 1683, pct_of_scored: 0.0666 },
             { outcome: 'voicemail', calls: 659, pct_of_scored: 0.0261 }, { outcome: 'test', calls: 5, pct_of_scored: 0.0002 }] };
const QUALITY = { current: { calls: 55690, scored: 25273, qualified: 2200, rate: 0.0395, scored_rate: 0.087 },
  previous: { calls: 50000, scored: 24000, qualified: 2000, rate: 0.04, scored_rate: 0.0833 },
  verticals: [{ vertical: 'Roofing', calls: 900, scored: 400, qualified: 70, rate: 0.0778, scored_rate: 0.175 },
              { vertical: 'Solar', calls: 500, scored: 200, qualified: 4, rate: 0.008, scored_rate: 0.02 },
              { vertical: 'Unscored', calls: 50, scored: 0, qualified: 0, rate: 0, scored_rate: null }] };
const TREND = { days: [
  { day: '2026-11-09', scored: 100, matched: 9, scored_rate: 0.09, scored_rate_7d: 0.085 },
  { day: '2026-11-10', scored: 0, matched: 0, scored_rate: null, scored_rate_7d: 0.085 },
  { day: '2026-11-11', scored: 120, matched: 12, scored_rate: 0.1, scored_rate_7d: 0.09 }] };
const CPA = { conversion_outcomes: ['appointment', 'sale'], total: { calls: 3000, scored: 1400, scored_pct: 0.4667, paid: 800, revenue: 30000, conversions: 120, cpa: 250 },
  rows: [
    { publisher_name: 'Pub A', vertical: 'Roofing', calls: 1000, scored: 500, revenue: 12000, conversions: 60, avg_score: 1.2, defect_rate: 0.05, conv_adjacent_rate: 0.2 },
    { publisher_name: 'Pub A', vertical: 'Solar', calls: 500, scored: 10, revenue: 3000, conversions: 0, avg_score: 0, defect_rate: 0, conv_adjacent_rate: 0 },
    { publisher_name: 'Pub B', vertical: 'Roofing', calls: 1500, scored: 890, revenue: 15000, conversions: 60, avg_score: -1, defect_rate: 0.5, conv_adjacent_rate: 0.01 }] };
const FLAGS = [{ flags: ['geo_mismatch'], suspicious_call: false, n: 2000 }, { flags: ['outbound_dial'], suspicious_call: true, n: 30 }, { flags: [], suspicious_call: true, n: 70 }];
const ANSWERS = { dashboard_summary: SUMMARY, dashboard_outcomes: OUTCOMES, dashboard_quality: QUALITY, dashboard_trend: TREND, dashboard_cpa: CPA, dashboard_flags: FLAGS };

// The overview section in a sandbox. rpc(name, body) answers the RPCs; log records every call.
function page({ rpc = async name => ANSWERS[name], now = '2026-11-12T15:00:00Z' } = {}) {
  const log = [], doc = fakeDoc(), timers = [];
  const ctx = {
    document: doc, window: { addEventListener() {} }, console, log, timers, VERTICALS: ['Roofing', 'Solar'],
    crDrpPickStart: null, crDrpPickEnd: null, SCORES_MIN_CALLS: 20,
    scoresWeights: { appointment: { adv_score: 10 }, voicemail: { adv_score: -3 }, ivr_hangup: { adv_score: 0 } },
    ensureVerticals: async () => {}, loadOutcomeWeights: async () => ctx.scoresWeights, esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    nullMark: () => '<span class="null-mark">-</span>', fmtShortD: iso => iso, labelOf: v => String(v).replace(/_/g, ' '),
    loadErrorHtml: (thing, retry) => `ERROR ${thing} ${retry}`,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
    crLoad: append => log.push({ crLoad: append }), crApply: () => log.push({ crApply: true }),
    sbFetch: async (url, opts) => {
      const body = JSON.parse(opts.body), name = url.replace('rpc/', '');
      log.push({ name, body });
      if (name === 'get_distinct_accounts') return [{ account_name: 'Pub, A (1)', account_type: 'publisher' }, { account_name: 'Adv X', account_type: 'advertiser' }];
      return rpc(name, body);
    },
  };
  ctx.Date = class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return Date.parse(now); } };
  vm.runInNewContext(SCORES_TIERS_SRC + ';\n' + lift('function scoresTierOf(') + ';\n' + section + `
    Object.assign(this, { dashMtDay, dashMtMidnight, dashMtRange, dashPresetRange, dashInit, dashApply, dashLoad, dashSetPreset,
      dashCustomChange, dashMsPick, dashMsClear, dashFilterBody, dashRpc, dashSummaryHtml, dashDelta, dashMoney, dashOutcomesHtml, dashDrill,
      dashQualityBands, dashTierOf, dashGaugeSvg, dashQualityHtml, dashTrendSvg, dashTrendIndexAt, dashCpaGroups, dashCpaHtml,
      dashCpaSetQuoted, dashStripRows, crSelectedVerticals, dashOpts, dashSel, dashData });
    Object.defineProperty(this, 'trendGeo', { get: () => dashTrendGeo });`, ctx);
  return { ctx, doc, log };
}
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
const plain = x => JSON.parse(JSON.stringify(x));
const rpcs = log => log.filter(l => l.name && l.name.startsWith('dashboard_'));

test('Calls page: one page; nothing loads at boot; first open loads the overview and the list once', () => {
  assert.doesNotMatch(html, /switchTab\('dashboard'/, 'no Dashboard tab');
  assert.doesNotMatch(html, /id="tab-dashboard"/);
  assert.match(lift('async function applyRoute('), /if \(tab === 'reporting' \|\| tab === 'dashboard'\) tab = 'calls';/, 'old ?tab=dashboard links land on Calls');
  assert.match(lift('function switchTab('), /if \(id === 'calls'\) crAutoLoad\(\);/);
  const first = lift('function crAutoLoad(');
  assert.match(first, /dashInit\(\);\s*if \(crAutoLoaded\) return;\s*crAutoLoaded = true;\s*dashApply\(\);/);
  // RPCs only from the overview loader, its cache, the strip and the CPA toggle: nothing at boot.
  const callers = [...html.matchAll(/dashRpc\('dashboard_\w+'/g)].length + [...html.matchAll(/card\('dash-[a-z]+', 'dashboard_\w+'/g)].length;
  assert.equal(callers, 4 + 5, 'strip (3) + CPA toggle (1) + five cards');
  const tab = html.slice(html.indexOf('<div id="tab-calls"'), html.indexOf('<!-- SCORES TAB'));
  for (const id of ['dash-output', 'dash-outcomes', 'dash-quality', 'dash-trend', 'dash-cpa', 'dash-ms-vertical', 'dash-ms-publisher', 'dash-ms-advertiser', 'calls-list', 'calls-summary-strip', 'cr-output'])
    assert.ok(tab.includes(`id="${id}"`), id);
  assert.ok(tab.indexOf('id="dash-cpa"') < tab.indexOf('id="calls-summary-strip"'), 'overview above the list');
  assert.doesNotMatch(tab, /cr-drp|cr-pub-filter|cr-adv-filter|cr-vertical-wrap/, 'the filter bar owns dates, publishers, advertisers, verticals');
});

test('Mountain Time days: presets are complete Mountain days; a day starts at Mountain midnight across DST', () => {
  const { ctx } = page();
  // 06:30 UTC on Nov 13 is still Nov 12 in Mountain Time (23:30 MST).
  assert.deepEqual(plain(ctx.dashPresetRange(30, new Date('2026-11-13T06:30:00Z'))), { from: '2026-10-13', to: '2026-11-11' });
  assert.deepEqual(plain(ctx.dashPresetRange(7, new Date('2026-11-13T07:30:00Z'))), { from: '2026-11-06', to: '2026-11-12' });
  assert.equal(ctx.dashMtMidnight('2026-11-01'), '2026-11-01T06:00:00.000Z', 'Nov 1 starts in MDT');
  assert.equal(ctx.dashMtMidnight('2026-11-02'), '2026-11-02T07:00:00.000Z', 'Nov 2 starts in MST');
  assert.equal(ctx.dashMtMidnight('2026-03-08'), '2026-03-08T07:00:00.000Z', 'Mar 8 starts in MST');
  assert.equal(ctx.dashMtMidnight('2026-03-09'), '2026-03-09T06:00:00.000Z', 'Mar 9 starts in MDT');
  assert.deepEqual([...ctx.dashMtRange('2026-11-01', '2026-11-01')], ['2026-11-01T06:00:00.000Z', '2026-11-02T07:00:00.000Z'], 'the 25-hour day');
});

test('first open: five card RPCs with the same filters, the list once, every card rendered', async () => {
  const { ctx, doc, log } = page();
  ctx.dashInit(); ctx.dashInit();
  assert.deepEqual([ctx.crDrpPickStart, ctx.crDrpPickEnd], ['2026-10-13', '2026-11-11'], '30-day default');
  ctx.dashApply();
  await tick();
  const calls = rpcs(log);
  assert.deepEqual(calls.map(c => c.name).sort(), ['dashboard_cpa', 'dashboard_outcomes', 'dashboard_quality', 'dashboard_summary', 'dashboard_trend']);
  for (const c of calls) assert.deepEqual({ ...c.body, include_quoted: undefined }, { from_day: '2026-10-13', to_day: '2026-11-11', verticals: null, publishers: null, advertisers: null, include_quoted: undefined });
  assert.equal(calls.find(c => c.name === 'dashboard_cpa').body.include_quoted, false);
  assert.deepEqual(log.filter(l => 'crLoad' in l), [{ crLoad: false }], 'the list loads once, fresh');
  for (const [id, s] of [['dash-output', '55,690'], ['dash-outcomes', 'Qualified Lead'], ['dash-quality', '8.7%'], ['dash-trend', 'Call Quality Trend'], ['dash-cpa', '$250.00']])
    assert.ok(doc.els[id].innerHTML.includes(s), `${id} shows ${s}`);
  assert.equal(doc.els['dash-period'].textContent, '2026-10-13 – 2026-11-11, compared with 2026-09-13 – 2026-10-12 (Mountain Time days)');
  assert.deepEqual(plain(ctx.dashOpts.publisher), ['Pub, A (1)']);
});

test('filter bar: picks reload overview + list once after a pause; Clear; a half-set custom range does nothing', async () => {
  const { ctx, doc, log } = page();
  ctx.dashInit(); await tick();   // the picker options load first; ticks come after
  ctx.dashOpts.publisher = ['Pub, A (1)', 'Pub B'];
  ctx.dashMsPick('publisher', 0, true); ctx.dashMsPick('publisher', 1, true); ctx.dashMsPick('vertical', 1, true);
  assert.equal(doc.els['dash-ms-publisher-label'].textContent, '2 publishers');
  assert.equal(doc.els['dash-ms-vertical-label'].textContent, 'Solar');
  assert.deepEqual([...ctx.crSelectedVerticals()], ['Solar'], 'the list reads the bar\'s verticals');
  const live = ctx.timers.filter(t => t.fn.toString() !== '() => {}');
  assert.equal(live.length, 1, 'three ticks, one pending reload');
  assert.equal(live[0].ms, 500);
  live[0].fn(); await tick();
  assert.equal(log.filter(l => 'crLoad' in l).length, 1, 'list reloaded with the overview');
  assert.deepEqual(rpcs(log)[0].body.publishers, ['Pub, A (1)', 'Pub B']);
  ctx.dashMsClear('publisher');
  assert.equal(ctx.dashFilterBody().publishers, null);

  ctx.dashSetPreset('custom');
  assert.equal(doc.els['dash-from'].value, '2026-10-13', 'Custom starts from the range on screen');
  assert.equal(doc.els['dash-to'].max, '2026-11-12', 'no future Mountain days');
  const before = log.length;
  doc.els['dash-from'].value = '';
  ctx.dashCustomChange();
  assert.equal(log.length, before, 'one date missing: nothing applies');
  doc.els['dash-from'].value = '2026-11-05'; doc.els['dash-to'].value = '2026-11-01';
  ctx.dashCustomChange(); await tick();
  assert.deepEqual([ctx.crDrpPickStart, ctx.crDrpPickEnd], ['2026-11-01', '2026-11-05'], 'reversed dates swap');
});

test('one request per RPC and filters (the strip reuses the overview\'s summary); a failure is not cached', async () => {
  let n = 0, fail = true;
  const { ctx } = page({ rpc: async name => { n++; if (name === 'dashboard_flags' && fail) { fail = false; throw new Error('Supabase 500'); } return ANSWERS[name]; } });
  const body = { from_day: '2026-11-01', to_day: '2026-11-07', verticals: null, publishers: null, advertisers: null };
  await Promise.all([ctx.dashRpc('dashboard_summary', body), ctx.dashRpc('dashboard_summary', { ...body })]);
  assert.equal(n, 1);
  await assert.rejects(ctx.dashRpc('dashboard_flags', body));
  await tick();
  assert.deepEqual(plain(await ctx.dashRpc('dashboard_flags', body)), FLAGS, 'retried after the failure');
});

test('a slower earlier load never overwrites a newer one; a failed card shows Retry and keeps the rest', async () => {
  let release, first = true;
  const slow = new Promise(r => { release = r; });
  const { ctx, doc } = page({ rpc: async (name, b) => {
    if (name === 'dashboard_summary' && first) { first = false; return slow; }
    if (name === 'dashboard_quality') throw new Error('Supabase 500');
    return name === 'dashboard_summary' ? { ...SUMMARY, current: { ...SUMMARY.current, calls: 7 } } : ANSWERS[name];
  } });
  ctx.dashInit();
  ctx.dashLoad();
  ctx.dashSetPreset(7); await tick();
  assert.ok(doc.els['dash-output'].innerHTML.includes('>7<'), 'newer result shown');
  release(SUMMARY); await tick();
  assert.ok(doc.els['dash-output'].innerHTML.includes('>7<'), 'stale result dropped');
  assert.equal(doc.els['dash-quality'].innerHTML, 'ERROR this card dashLoad()');
  assert.ok(doc.els['dash-cpa'].innerHTML.includes('Cost per Acquisition'));
});

test('summary card: change vs previous period, money, empty averages', () => {
  const { ctx } = page();
  assert.deepEqual(plain(ctx.dashDelta(55690, 50000)), { text: '▲ 11.4%', cls: 'up' });
  assert.deepEqual(plain(ctx.dashDelta(490345, 500000)), { text: '▼ 1.9%', cls: 'down' });
  assert.deepEqual(plain(ctx.dashDelta(312000, 300000, false)), { text: '▲ 4.0%', cls: '' }, 'publisher cost: no good/bad color');
  assert.deepEqual(plain(ctx.dashDelta(5, 0)), { text: 'new', cls: '' });
  assert.equal(ctx.dashMoney(-1234.5), '-$1,235');
  const out = ctx.dashSummaryHtml(SUMMARY);
  assert.ok(out.includes('<div class="dash-delta up" title="Previous period: 50,000">▲ 11.4%</div>'));
  assert.ok(out.includes('<div class="dash-delta " title="Previous period: $300,000">▲ 4.0%</div>'));
  assert.ok(ctx.dashSummaryHtml({ ...SUMMARY, current: { ...SUMMARY.current, revenue_per_call: null } }).includes('<div class="dash-val"><span class="null-mark">-</span></div>'));
});

test('outcomes: Qualified Lead first, signs from advertiser weights, a row drills into the list', () => {
  const { ctx, doc, log } = page();
  const out = ctx.dashOutcomesHtml(OUTCOMES, false);
  const labels = [...out.matchAll(/<span class="dash-bar-lbl"><span class="dash-sign">(.)<\/span>([^<]*)<\/span>/g)].map(m => m[1] + m[2]);
  assert.deepEqual(labels, ['+Qualified Lead', '·ivr hangup', '+appointment', '−voicemail', '·test']);
  assert.ok(out.includes('% of 25,273 AI-scored calls · 30,417 not scored'), 'the unscored count is said');
  assert.ok(out.includes('2,200 <span class="dash-muted">(8.7%)</span>'));
  assert.match(out, /dashDrill\('group:qualified'\)/);
  assert.match(out, /width:100\.0%/, 'the longest bar fills the track');
  ctx.dashDrill('voicemail');
  assert.equal(doc.els['cr-outcome-filter'].value, 'voicemail');
  assert.deepEqual(log.at(-1), { crApply: true });
  assert.ok(doc.els['calls-list'].scrolled, 'scrolls to the list');
  ctx.dashDrill('test');   // not in the select's outcome list: added first, so the filter can't silently drop
  assert.ok(doc.els['cr-outcome-list'].options.some(o => o.value === 'test'));
  assert.equal(doc.els['cr-outcome-filter'].value, 'test');
});

test('quality: Scores tier cutoffs as gauge bands per vertical, % of AI-scored calls with the all-calls rate', () => {
  const { ctx } = page();
  assert.deepEqual(plain(ctx.dashQualityBands('Roofing')), [{ tier: 3, min: 0.03 }, { tier: 2, min: 0.08 }, { tier: 1, min: 0.15 }]);
  const bands = ctx.dashQualityBands(null);
  assert.deepEqual([0.01, 0.03, 0.087, 0.2, null].map(r => ctx.dashTierOf(r, bands)), [4, 3, 2, 1, null]);
  const svg = ctx.dashGaugeSvg(0.087, bands);
  assert.equal([...svg.matchAll(/<path d="M/g)].length, 4, 'four tier arcs');
  assert.deepEqual([...svg.matchAll(/>T(\d)</g)].map(m => +m[1]), [4, 3, 2, 1]);
  assert.match(svg, /class="dash-needle"/);
  const out = ctx.dashQualityHtml(QUALITY, false);
  assert.ok(out.includes('8.7% <span class="dash-tier t2">Tier 2</span>'));
  assert.ok(out.includes('2,200 of 25,273 AI-scored calls · 4.0% of all calls'), 'the all-calls rate under it');
  assert.ok(out.includes('▲ 0.4 pts vs prev.'));
  assert.ok(out.includes('<td>Roofing</td><td class="num">17.5%</td><td class="num">400</td><td><span class="dash-tier t1">Tier 1</span></td>'));
  assert.ok(out.includes('<span class="dash-tier t4">Tier 4</span>'), 'Solar at 2%');
  assert.ok(!out.includes('Unscored'), 'a vertical with no AI-scored calls has no rate to band');
  assert.match(out, /Tier definition pending Vicky/);
});

test('trend: daily + 7-day lines with a gap for a day without scored calls, reference lines, nearest-day crosshair', () => {
  const { ctx } = page();
  const svg = ctx.dashTrendSvg(TREND.days, 640);
  const [day, seven] = [...svg.matchAll(/<path d="([^"]*)" class="dash-line-(day|7d)"/g)].map(m => m[1]);
  assert.equal((day.match(/M/g) || []).length, 2, 'the daily line breaks at the empty day');
  assert.equal((seven.match(/[ML]/g) || []).length, 3);
  assert.ok(svg.includes('Top performers (Tier 1) 15%') && svg.includes('Threshold (Tier 3) 3%'));
  assert.match(svg, /class="dash-cross-g" visibility="hidden"/);
  const g = ctx.trendGeo;
  assert.deepEqual([g.L, g.L + g.pw / 2 + 1, g.L + g.pw].map(px => ctx.dashTrendIndexAt(px, g)), [0, 1, 2]);
  ctx.dashData['dash-trend'] = TREND;
  assert.ok(lift('function dashTrendRender(').includes('<details class="dash-details"><summary>Daily values</summary>'), 'every value in a table');
});

test('CPA: by publisher across verticals, by Scores tier per publisher × vertical; quoted toggle refetches', async () => {
  const { ctx, doc, log } = page();
  const pubs = plain(ctx.dashCpaGroups(CPA.rows, 'publisher'));
  assert.deepEqual(pubs.map(g => [g.key, g.revenue, g.conversions, g.cpa]), [['Pub A', 15000, 60, 250], ['Pub B', 15000, 60, 250]]);
  const tiers = plain(ctx.dashCpaGroups(CPA.rows, 'tier'));
  assert.deepEqual(tiers.map(g => [g.key, g.pairings, g.revenue]), [['Tier 1', 1, 12000], ['Tier 4', 1, 15000], ['Not tiered', 1, 3000]],
    'under 20 scored calls: not tiered');
  const out = ctx.dashCpaHtml(CPA, 'publisher', false, false);
  assert.ok(out.includes('$250.00') && out.includes('47% of calls are AI-scored'));
  ctx.dashSel.publisher.add('Pub A');
  assert.ok(ctx.dashCpaHtml(CPA, 'publisher', false, false).includes('Group of 1 publisher (filter bar).'));
  ctx.dashInit();
  ctx.crDrpPickStart = '2026-11-01'; ctx.crDrpPickEnd = '2026-11-07';
  await ctx.dashCpaSetQuoted(true);
  assert.deepEqual(rpcs(log).at(-1), { name: 'dashboard_cpa', body: { from_day: '2026-11-01', to_day: '2026-11-07', verticals: null, publishers: ['Pub A'], advertisers: null, include_quoted: true } });
  assert.ok(doc.els['dash-cpa'].innerHTML.includes('seg-btn active" onclick="dashCpaSetQuoted(true)'));
});

test('list strip: from the rollups when no list-only filter is on (same totals as raw rows), raw otherwise', async () => {
  const { ctx } = page();
  const rows = plain(ctx.dashStripRows(25273, FLAGS));
  assert.deepEqual(rows.at(-1), { flags: [], suspicious_call: false, n: 25273 - 2100 }, 'unflagged remainder');
  const totals = new Function('CALLS_FLAG_TYPES', 'flagSeverity', lift('function callsStripTotals(') + '; return callsStripTotals;')(
    ['outbound_dial', 'geo_mismatch'], f => ({ outbound_dial: 'high' }[f] || 'info'))(rows);
  assert.deepEqual({ total: totals.total, flagged: totals.flagged, high: totals.high }, { total: 25273, flagged: 2030, high: 100 });

  // callsLoadSummary: rollup flags → dashRpc; none → the raw aggregate queries, as before.
  const asked = [];
  const run = async crApplied => {
    const c = { crApplied, crLoadSeq: 1, crOffset: 0, crTotal: null, crHasMore: false, console: { warn() {} },
      document: { getElementById: () => ({ textContent: '', classList: { toggle() {} } }) },
      callsHighLine() {}, callsFlagBreakdownRender() {}, crRender() {}, callsStripTotals: r => ({ total: r.length, flagged: 0, high: 0, counts: {} }),
      sbFetch: async url => { asked.push(url.split('?')[0]); return [{ n: 1, revenue: 1 }]; },
      dashRpc: async name => { asked.push(name); return name === 'dashboard_flags' ? FLAGS : SUMMARY; }, dashStripRows: ctx.dashStripRows };
    vm.runInNewContext(lift('async function callsLoadSummary(') + ';this.f = callsLoadSummary;', c);
    await c.f(1);
    return c;
  };
  const r = await run({ table: '&t', strip: '&s', rollup: { table: true, strip: true, body: {} } });
  assert.deepEqual(asked.splice(0).sort(), ['dashboard_flags', 'dashboard_summary', 'dashboard_summary']);
  assert.equal(r.crTotal, 55690, 'the table total from the summary');
  await run({ table: '&t', strip: '&s', rollup: { table: false, strip: false, body: {} } });
  assert.deepEqual(asked.splice(0), ['canoe_calls', 'canoe_calls']);
});

test('list-only filters: digest scope, outcome, recording and search; the flag drill-downs only for the table', () => {
  const vals = {}, on = new Set();
  const c = { crLinkScope: null, document: { getElementById: id => ({ value: vals[id] || '', classList: { contains: x => x === 'active' && on.has(id) } }) } };
  vm.runInNewContext(lift('function crListOnly(') + ';this.f = crListOnly;', c);
  assert.deepEqual([c.f(true), c.f(false)], [false, false], 'only the filter bar: rollups for both');
  on.add('cr-flagged-only');
  assert.deepEqual([c.f(true), c.f(false)], [true, false], 'flag drill-down: the strip still from rollups');
  on.clear();
  for (const id of ['cr-outcome-filter', 'cr-rec-filter', 'cr-search']) { vals[id] = 'x'; assert.equal(c.f(false), true, id); vals[id] = ''; }
  c.crLinkScope = { account: 'A' };
  assert.equal(c.f(false), true, 'digest scope');
});
