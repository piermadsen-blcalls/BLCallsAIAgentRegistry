// Regressions from the Nov 9 bug bash + speed review (Calls, Scores, Insights filter, Settings).
// index.html has no build step, so the code is lifted out of the page and run with stubs.
// Run: node --test tests/
process.env.TZ = 'America/Denver';   // the bug bash ran in MST; local-day bounds depend on it
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// Source of a top-level `function name(` or `async function name(` declaration, by brace matching
// from the body's opening brace (after the parameter list, which may hold a `= {}` default).
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

// PostgREST list/or() syntax: comma-separated items, double-quoted ones with \-escapes.
function pgItems(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    let v = '';
    if (s[i] === '"') {
      for (i++; s[i] !== '"'; i++) { if (s[i] === '\\') i++; v += s[i]; }
      i++;
    } else {
      let depth = 0;
      for (; i < s.length && (depth || s[i] !== ','); i++) { if (s[i] === '(') depth++; if (s[i] === ')') depth--; if (s[i] === '"') { const j = s.indexOf('"', i + 1); v += s.slice(i, j + 1); i = j; continue; } v += s[i]; }
    }
    out.push(v); i++;   // skip the comma
  }
  return out;
}
// One or=() term: column, operator, value (unquoted).
function pgTerm(t) {
  const [, col, op, raw] = t.match(/^([a-z_]+)\.([a-z]+)\.(.*)$/s);
  return { col, op, value: raw.startsWith('"') ? pgItems(raw)[0] : raw };
}
const param = (url, name) => new URLSearchParams(url.split('?')[1] ?? url.replace(/^&/, '')).getAll(name);

// ── Calls query ──────────────────────────────────────────────────────────────
function callsCtx(over = {}) {
  const values = { 'cr-rec-filter': '', 'cr-pub-filter': '', 'cr-adv-filter': '', 'cr-search': '', ...over.values };
  return load({
    crDrpPickStart: '2026-11-02', crDrpPickEnd: '2026-11-08', crSortCol: 'created_at', crSortDir: -1,
    AGENTS: over.AGENTS || [], aliasesForAgent: ivr => (over.aliases || {})[ivr] || [],
    crOutcomeGroupMembers: () => [], crSelectedVerticals: () => over.verticals || [],
    document: { getElementById: id => ({ value: values[id] ?? '', classList: { contains: () => false } }) },
  }, ['function localDayRange(', 'function pgQuote(', 'function crSearchFilter(', 'function crBuildFilters(', 'function crBuildQuery('],
  ['crBuildFilters', 'crBuildQuery', 'localDayRange']);
}

// A fake PostgREST that applies `order` like Postgres (asc nulls last, desc nulls first unless
// overridden) and breaks remaining ties at random per request, as a top-N heapsort may.
function unstableOrderBy(rows, order) {
  const keys = order.split(',').map(k => { const [col, dir = 'asc', nulls] = k.split('.'); return { col, desc: dir === 'desc', nullsFirst: nulls ? nulls === 'nullsfirst' : dir === 'desc' }; });
  const salt = new Map(rows.map(r => [r, Math.random()]));
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const x = a[k.col], y = b[k.col];
      if (x == null || y == null) { if (x == null && y == null) continue; return (x == null) === k.nullsFirst ? -1 : 1; }
      if (x !== y) return (x < y ? -1 : 1) * (k.desc ? -1 : 1);
    }
    return salt.get(a) - salt.get(b);
  });
}
const PUBS = ['Acme', 'Bolt', 'Crest', "Let's Make a Lead"];
const CALLS = Array.from({ length: 3200 }, (_, i) => ({
  id: 'c' + String(i).padStart(5, '0'), publisher_name: PUBS[i % 4], publisher_score: i % 2 ? null : (i % 13) - 3,
  created_at: new Date(Date.parse('2026-11-02T07:00:00Z') + i * 180000).toISOString(),
}));
function pageAll(query) {
  const order = param(query, 'order')[0];
  const ids = [];
  for (let offset = 0; offset < CALLS.length; offset += 1000) ids.push(...unstableOrderBy(CALLS, order).slice(offset, offset + 1000).map(r => r.id));
  return ids;
}

test('Calls paging (Load more, CSV export): a non-unique sort no longer repeats or drops rows', () => {
  const ctx = callsCtx();
  ctx.crSortCol = 'publisher_name';
  const q = ctx.crBuildQuery(0);
  assert.match(q, /&order=publisher_name\.desc\.nullslast,id\.asc$/);
  assert.equal(new Set(pageAll(q)).size, CALLS.length, 'every call exactly once');
  // Control: the old order clause (no tiebreaker) loses rows against the same fake.
  assert.ok(new Set(pageAll(q.replace(',id.asc', ''))).size < CALLS.length, 'the fake reproduces the bug');
});

test('Calls sort: Pub/Adv Score descending puts unscored calls last', () => {
  const ctx = callsCtx();
  for (const col of ['publisher_score', 'advertiser_score']) {
    ctx.crSortCol = col;
    assert.match(ctx.crBuildQuery(0), new RegExp(`&order=${col}\\.desc\\.nullslast,id\\.asc$`));
  }
  ctx.crSortCol = 'publisher_score';
  const first = unstableOrderBy(CALLS, param(ctx.crBuildQuery(0), 'order')[0]).slice(0, 25);
  assert.ok(first.every(r => r.publisher_score != null));
  // created_at keeps its index-friendly order (never null inside the date filter).
  ctx.crSortCol = 'created_at';
  assert.match(ctx.crBuildQuery(0), /&order=created_at\.desc,id\.asc$/);
});

test('Calls date range: local-day bounds with an exclusive end (was UTC days, ~7 h off)', () => {
  const ctx = callsCtx();
  assert.deepEqual(param(ctx.crBuildFilters(), 'created_at'), ['gte.2026-11-02T07:00:00.000Z', 'lt.2026-11-09T07:00:00.000Z']);
  // Across the Nov 1 DST change: Oct 31 starts at MDT midnight, Nov 2 at MST midnight.
  assert.deepEqual([...ctx.localDayRange('2026-10-31', '2026-11-01')], ['2026-10-31T06:00:00.000Z', '2026-11-02T07:00:00.000Z']);
});

test('Calls search is a server-side filter over the whole range, with quoted values', () => {
  const text = `Let's (try), "x"_%`;
  const ctx = callsCtx({ values: { 'cr-search': text } });
  const or = param(ctx.crBuildFilters(), 'or')[0];
  assert.ok(or.startsWith('(') && or.endsWith(')'));
  const terms = pgItems(or.slice(1, -1)).map(pgTerm);
  const want = '*' + text.replace(/[\\%_]/g, '\\$&') + '*';   // what PostgREST hands to ILIKE
  for (const col of ['ivr_name', 'called_from', 'publisher_name', 'advertiser_name', 'disposition_description'])
    assert.ok(terms.some(t => t.col === col && t.op === 'ilike' && t.value === want), col);

  // Agent display names resolve to their IVR names (+ aliases); typed phone formats match digits.
  const ctx2 = callsCtx({ values: { 'cr-search': 'roof' }, AGENTS: [{ name: 'Roofing (GLS)', ivrName: 'ASCND - Roofing, v2' }], aliases: { 'ASCND - Roofing, v2': ['ASCND - Roofing'] } });
  const inTerm = pgItems(param(ctx2.crBuildFilters(), 'or')[0].slice(1, -1)).map(pgTerm).find(t => t.col === 'ivr_name' && t.op === 'in');
  assert.deepEqual(pgItems(inTerm.value.slice(1, -1)), ['ASCND - Roofing, v2', 'ASCND - Roofing']);
  const ctx3 = callsCtx({ values: { 'cr-search': '(385) 555-12' } });
  assert.ok(pgItems(param(ctx3.crBuildFilters(), 'or')[0].slice(1, -1)).map(pgTerm).some(t => t.col === 'called_from' && t.value === '*38555512*'));
  assert.equal(param(callsCtx().crBuildFilters(), 'or').length, 0, 'no search, no or=');
});

test('Calls + Insights vertical filters quote verticals with parentheses and commas', async () => {
  const verticals = ['Auto Insurance (Insured)', 'Flights (Domestic - US)', 'A, "B"'];
  assert.deepEqual(pgItems(param(callsCtx({ verticals }).crBuildFilters(), 'vertical_name')[0].replace(/^in\.\((.*)\)$/, '$1')), verticals);
  const urls = [];
  const ctx = load({ insVerticalFilter: verticals, sbFetch: async url => { urls.push(url); return []; } },
    ['function pgQuote(', 'function isSent(', 'function isPaid(', 'function insDayWindows(', 'async function insFetchPeriod('], ['insFetchPeriod']);
  await ctx.insFetchPeriod('2026-11-02', '2026-11-02');
  assert.equal(urls.length, 1);
  assert.equal(param(urls[0], 'or').length, 0, 'no or=(vertical_name.eq.…), which PostgREST misparsed');
  assert.deepEqual(pgItems(param(urls[0], 'vertical_name')[0].replace(/^in\.\((.*)\)$/, '$1')), verticals);
});

test('Export CSV: a zero-row export re-enables the button', async () => {
  const btn = { disabled: false, textContent: 'Export CSV' }, alerts = [];
  const ctx = load({
    crDrpPickStart: '2026-11-02', crDrpPickEnd: '2026-11-08', compAssignments: [{}], AGENTS: [],
    document: { getElementById: () => btn }, alert: m => alerts.push(m),
    sbFetch: async () => [], crBuildQuery: () => 'canoe_calls?select=id',
  }, ['async function crExportAll('], ['crExportAll']);
  await ctx.crExportAll();
  assert.deepEqual(alerts, ['No rows to export.']);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Export CSV');
});

// ── Calls summary strip ─────────────────────────────────────────────────────
function summaryCtx(sbFetch) {
  const els = {};
  const el = id => (els[id] ??= { textContent: '', style: { display: 'none' }, innerHTML: '' });
  return load({
    els, sbFetch, crLoadSeq: 1, crOffset: 25, crTotal: null, crHasMore: true, crRender() {}, callsFlagCounts: null,
    crDrpPickStart: '2026-11-02', crDrpPickEnd: '2026-11-08', console: { warn() {} },
    CALLS_FLAG_TYPES: ['outbound_dial', 'angry_caller', 'geo_mismatch'],
    crBuildFilters: (withFlags = true) => (withFlags ? '&scope=table' : '&scope=strip'),
    document: { getElementById: el },
  }, ['async function callsLoadSummary(', 'function callsFlagBreakdown(', 'function callsFlagBreakdownRender('], ['callsLoadSummary', 'callsFlagBreakdown']);
}

test('Calls summary: two aggregate requests fill the footer total, strip and hover breakdown', async () => {
  const urls = [];
  const ctx = summaryCtx(async url => {
    urls.push(url);
    if (url.includes('select=n:count(),revenue:advertiser_payin.sum()')) return [{ n: 120, revenue: 456.7 }];
    return [{ flags: [], n: 80 }, { flags: ['geo_mismatch'], n: 15 }, { flags: ['geo_mismatch', 'angry_caller'], n: 5 }, { flags: null, n: 3 }];
  });
  await ctx.callsLoadSummary(1);
  assert.equal(urls.length, 2, 'was 4 exact counts + 8 per-flag counts');
  assert.ok(urls.some(u => u.endsWith('&scope=strip&ai_processed_at=not.is.null')));
  const v = id => ctx.els[id].textContent;
  assert.deepEqual([v('calls-stat-total'), v('calls-stat-flagged'), v('calls-stat-rate'), v('calls-stat-revenue')], ['103', '20', '19.4%', '$457']);
  assert.equal(ctx.crTotal, 120);
  ctx.callsFlagBreakdown();   // hover: no request, already loaded
  assert.equal(urls.length, 2);
  assert.match(ctx.els['calls-flag-breakdown'].innerHTML, /geo_mismatch<\/span><span class="fb-n">20<.*angry_caller<\/span><span class="fb-n">5</);
});

test('Calls summary: a failed or superseded load never shows stale numbers', async () => {
  const ctx = summaryCtx(async url => { if (url.includes('flags,n:count()')) throw new Error('Supabase 500'); return [{ n: 7, revenue: 0 }]; });
  ctx.els['calls-stat-total'] = { textContent: '9,999' };
  await ctx.callsLoadSummary(1);
  assert.equal(ctx.els['calls-stat-total'].textContent, '—');
  assert.equal(ctx.els['calls-stat-flagged'].textContent, '—');
  const stale = summaryCtx(async () => [{ n: 1, revenue: 1 }]);
  stale.crLoadSeq = 2;
  await stale.callsLoadSummary(1);
  assert.equal(stale.crTotal, null, 'an older load does not overwrite the newer one');
});

// ── Scores ──────────────────────────────────────────────────────────────────
function scoresCtx(rows, openKey = null) {
  const out = { innerHTML: '' };
  const ctx = load({
    scoresRows: rows, scoresSort: { key: 'gap', dir: -1 }, scoresSearch: '', scoresEntity: 'publisher', scoresOpenKey: openKey,
    scoresExcluded: new Set(), scoresWeights: { sale: { pub_score: 10 } }, SCORES_MIN_CALLS: 20,
    SCORES_TIERS: { publisher: [{ tier: 1, minAvg: 0.9, maxDefect: 0.07, minConv: 0.15 }] },
    document: { getElementById: () => out },
  }, ['function esc(', 'function jsStr(', 'function httpUrl(', 'function crFmtDuration(', 'function scoresSortRows(', 'function scoresFmt(',
    'function scoresPct(', 'function scoresRenderTable(', 'function scoresRenderDetail('], ['scoresRenderTable']);
  ctx.scoresRenderTable();
  return out.innerHTML;
}

test("Scores: rows whose name has an apostrophe expand (the key is not spliced into JS)", () => {
  const key = "Let's Make a Lead LLC (dba \"A\") - DP\u0001Roofing";
  const row = { key, entity: "Let's Make a Lead LLC (dba \"A\") - DP", vertical: 'Roofing', canoe: { sale: 30 }, ours: { sale: 30 }, n: 30,
    canoeScore: 10, oursScore: 10, gap: 0, defect: 0, conv: 1, tier: 1 };
  const htmlOut = scoresCtx([row]);
  const m = htmlOut.match(/<tr class="scores-row [^"]*" data-key="([^"]*)" onclick="([^"]*)">/);
  assert.ok(m, 'row has a data-key');
  assert.equal(unhtml(m[1]), key);
  let opened = null;
  new Function('scoresToggleDetail', unhtml(m[2])).call({ dataset: { key: unhtml(m[1]) } }, k => { opened = k; });
  assert.equal(opened, key);

  const detail = scoresCtx([row], key);
  const cb = detail.match(/<input type="checkbox" checked data-key="([^"]*)" data-outcome="([^"]*)" onclick="([^"]*)">/);
  assert.ok(cb, 'what-if checkbox uses data attributes');
  let toggled = null;
  new Function('event', 'scoresToggleOutcome', unhtml(cb[3])).call({ dataset: { key: unhtml(cb[1]), outcome: unhtml(cb[2]) } }, { stopPropagation() {} }, (k, o) => { toggled = [k, o]; });
  assert.deepEqual(toggled, [key, 'sale']);
});

test('Scores: uses outcome_score_pairings, and folds outcome_score_vectors until 051 is applied', async () => {
  const pairs = [{ entity_name: 'Acme', vertical: 'Roofing', canoe: { sale: 2 }, ours: { sale: 1, misrouted: 1 } }];
  const calls = [];
  const mk = status => load({
    scoresEntity: 'publisher', scoresPairsRpc: true,
    sbRequest: async (p, o) => { calls.push(p); return status === 200 ? { ok: true, status, json: async () => pairs } : { ok: false, status, text: async () => 'x' }; },
    sbFetch: async p => { calls.push(p); return [
      { entity_name: 'Acme', vertical: 'Roofing', source: 'canoe', outcome: 'sale', n: '2' },
      { entity_name: 'Acme', vertical: 'Roofing', source: 'ours', outcome: 'sale', n: '1' },
      { entity_name: 'Acme', vertical: 'Roofing', source: 'ours', outcome: 'misrouted', n: '1' }]; },
  }, ['async function scoresFetchPairs('], ['scoresFetchPairs']);
  assert.deepEqual(await mk(200).scoresFetchPairs('a', 'b'), pairs);
  const fallback = mk(404);
  assert.deepEqual(JSON.parse(JSON.stringify(await fallback.scoresFetchPairs('a', 'b'))), pairs);
  calls.length = 0;
  await fallback.scoresFetchPairs('a', 'b');
  assert.deepEqual(calls, ['rpc/outcome_score_vectors'], 'a 404 is remembered for the session');
  await assert.rejects(mk(500).scoresFetchPairs('a', 'b'), /Supabase 500/);
});

// ── Escaping ────────────────────────────────────────────────────────────────
test('jsStr + esc: values with quotes, backslashes and newlines survive an inline handler', () => {
  const ctx = load({}, ['function esc(', 'function jsStr('], ['esc', 'jsStr']);
  for (const v of [`O'Brien`, `say "hi"`, 'back\\slash', 'two\nlines', `<b>&amp;</b>`, ' x']) {
    const attr = `f('${ctx.jsStr(v)}')`;
    assert.ok(!attr.includes('"'), 'nothing ends the double-quoted attribute');
    let got = null;
    new Function('f', unhtml(attr))(x => { got = x; });
    assert.equal(got, v);
  }
  assert.equal(ctx.esc(`<a href="x">it's</a>`), '&lt;a href=&quot;x&quot;&gt;it&#39;s&lt;/a&gt;');
});

// ── Settings ────────────────────────────────────────────────────────────────
test('AI Prompts: the list renders without waiting on (or failing with) call counts', async () => {
  const els = { 'settings-prompts-list': { innerHTML: '' } };
  const fetched = [];
  const ctx = load({
    allPrompts: [], document: { getElementById: id => els[id] },
    compFetch: async p => { fetched.push(p); return [{ id: 'p1', name: 'v3', is_active: false }, { id: 'p2', name: "v4 it's", is_active: true }]; },
    sbCount: async p => { if (p.includes('p2')) throw new Error('Supabase 500'); return 100685; },
    promptsRefreshABSelect() {},
  }, ['function esc(', 'async function promptsLoad(', 'function promptsRender('], ['promptsLoad']);
  await ctx.promptsLoad();
  assert.deepEqual(fetched, ['ai_prompts?select=*&order=created_at.asc'], 'no 120k-row prompt_id download');
  const out = els['settings-prompts-list'].innerHTML;
  assert.match(out, /v4 it&#39;s/);
  assert.match(out, /≈ 100,685/);
  assert.match(out, />—<\/td>/, 'a failed count shows a dash, not 0');
});

test('Weights: a failed count says "unavailable" instead of "will update 0 calls"', async () => {
  const btn = { style: {}, textContent: '' };
  const mk = sbCount => load({
    compFetch: async () => [], weightsRender() {}, console: { warn() {} }, sbCount, weightsData: {}, weightsProcessedCount: null, weightsCountApprox: true,
    document: { getElementById: () => btn },
  }, ['async function weightsLoadCount(', 'function weightsButtonLabel(', 'async function weightsInit('], ['weightsInit']);
  await mk(async () => { throw new Error('Supabase 500'); }).weightsInit();
  assert.equal(btn.textContent, 'Execute changes — call count unavailable');
  await mk(async () => 123730).weightsInit();
  assert.equal(btn.textContent, 'Execute changes — will update about 123,730 calls');
});

test('Calls/Settings requests refresh an expired token and retry once', async () => {
  const sent = [];
  let token = 'old';
  const ctx = load({
    SB_URL: 'https://x', SB_KEY: 'k', _refreshInFlight: null, sbTokenDue: () => false, getAuthToken: () => token,
    localStorage: { getItem: () => 'refresh-token' },
    refreshSession: async () => { token = 'new'; return true; },
    fetch: async (url, opts) => { sent.push(opts.headers.Authorization); return sent.length === 1 ? { ok: false, status: 401, text: async () => 'JWT expired' } : { ok: true, status: 200, json: async () => [1], text: async () => '[1]' }; },
    authExpired: false, onAuthError() { ctx.authErrors = (ctx.authErrors || 0) + 1; },
  }, ['async function sbRequest(', 'async function compRequest(', 'async function compFetch('], ['compFetch']);
  assert.deepEqual(await ctx.compFetch('account_managers?select=id'), [1]);
  assert.deepEqual(sent, ['Bearer old', 'Bearer new']);
  // Still 401 after the refresh: the login is shown once and the call fails.
  ctx.fetch = async () => ({ ok: false, status: 401, text: async () => '' });
  await assert.rejects(ctx.compFetch('x'), /Session expired/);
  await assert.rejects(ctx.compFetch('x'), /Session expired/);
  assert.equal(ctx.authErrors, 1);
});

// ── Page boot / Review ──────────────────────────────────────────────────────
test('Agents cards + breakdowns are deferred when the page lands on another tab', async () => {
  const fetched = [];
  const ctx = load({
    currentTab: 'scores', metricsLoading: false, agentsMetricsDeferred: false, AGENTS: [{ ivrName: 'A' }],
    activeRange: { start: new Date('2026-10-13T06:00:00Z'), end: new Date('2026-11-11T07:00:00Z'), label: 'x' },
    updateDataWindowLabels() { ctx.labelled = true; }, sbFetch: async p => { fetched.push(p); return []; },
    loadAllBreakdowns: () => { fetched.push('breakdowns'); return Promise.resolve({}); },
    aliasesForAgent: () => [], resolveIvrName: n => n, recomputeStats() {}, applyFilters() {}, console: { warn() {} },
  }, ['async function refreshMetrics('], ['refreshMetrics']);
  await ctx.refreshMetrics();
  assert.deepEqual(fetched, [], 'no agent_metrics / agent_breakdown_all on a Scores landing');
  assert.equal(ctx.agentsMetricsDeferred, true);
  assert.equal(ctx.labelled, true, 'the footer window label still renders');
  ctx.currentTab = 'agents';
  await ctx.refreshMetrics();
  assert.deepEqual(fetched, ['breakdowns', 'rpc/agent_metrics']);
  assert.equal(ctx.agentsMetricsDeferred, false);
});

test('Review KPIs show "—" when their load failed, not zeros', () => {
  const box = { innerHTML: '' };
  const ctx = load({ RV: { metrics: null }, document: { getElementById: () => box }, fmtPct: () => 'x' }, ['function updateReviewPerf('], ['updateReviewPerf']);
  ctx.updateReviewPerf();
  assert.equal((box.innerHTML.match(/rv-perf-val">—</g) || []).length, 4);
  ctx.RV.metrics = { raw: 10, paid: 2, revenue: 99.6 };
  ctx.updateReviewPerf();
  assert.match(box.innerHTML, /rv-perf-val">10<.*rv-perf-val">2<.*rv-perf-val">\$100</s);
});
