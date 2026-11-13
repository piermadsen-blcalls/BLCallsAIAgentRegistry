// Regressions from the Nov 12 registry audit (data/ivr-audit/report.md): B3, B5-B7, N1, N5-N10,
// UI1, UI2, UI6, UI8, UI9, UI15. index.html has no build step, so the code is lifted out of the
// page and run with stubs. Run: node --test tests/
process.env.TZ = 'America/Denver';   // the audit ran in Mountain time; local-day bounds depend on it
process.env.DASHBOARD_URL = 'https://registry.example.invalid';   // read by scripts/alert.js at load
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tallyAccounts, rankAccounts, buildBaseline, buildEmail } = require('../scripts/alert.js');

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
const tick = () => new Promise(r => setImmediate(r));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const HELPERS = ['function esc(', 'function nullMark(', 'function labelOf(', 'function jsStr(', 'function httpUrl(', 'function toISO(', 'function fmtDate(', 'function fmtDateTime(', 'function personName(', 'function crFmtDuration(', 'function outcomeBadge(', 'function flagBadges('];
const OUTCOME_SETS = { POSITIVE_OUTCOMES: new Set(['sale']), NEGATIVE_OUTCOMES: new Set(['misrouted']) };

// ── B3 + UI6 + UI15: Review workspace call rows ────────────────────────────
function reviewCtx(over = {}) {
  const sent = [];
  const ctx = load({
    ...OUTCOME_SETS, console: { warn() {} }, alert: m => { ctx.alerts.push(m); }, alerts: [], sent,
    getAuthUser: () => over.me ?? 'me@example.com',
    RV: { agent: { ivrName: 'ASCND - Roofing' }, ivrs: ['ASCND - Roofing'], windowStart: new Date('2026-10-13T06:00:00Z'), reviewedSet: new Set(), reviewers: {}, notesByCall: {}, calls: [] },
    ivrQuery: () => 'ivr_name=in.(x)', renderReviewCalls() {},
    aeRowParts: () => null, aeDetailHtml: () => '', aeMarkQuotes: t => t,   // agent quality (056), tested in agent-quality-page.test.js
    sbFetch: async (url, opts = {}) => { sent.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null }); return over.sbFetch ? over.sbFetch(url, opts) : [{ call_id: 'c1' }]; },
  }, [...HELPERS, 'async function loadReviewedSet(', 'function reviewCallRow(', 'function rvCheckState(', 'function rvSetReviewed(', 'async function toggleCallReviewed(', 'async function rvSaveNote('],
  ['loadReviewedSet', 'reviewCallRow', 'toggleCallReviewed', 'rvSaveNote']);
  return ctx;
}
const fakeEl = () => ({ classList: { on: false, toggle(_, v) { this.on = v; } }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });

test('B3: un-marking your own review keeps the row and its note (PATCH reviewed=false, never DELETE)', async () => {
  const ctx = reviewCtx({ sbFetch: async url => (url.startsWith('call_reviews?select=') ? [
    { call_id: 'c1', note: 'asked twice for pricing', reviewed_by: 'me@example.com', reviewed_at: '2026-11-10T16:00:00Z', reviewed: true },
    { call_id: 'c2', note: 'old note', reviewed_by: 'me@example.com', reviewed_at: '2026-11-09T16:00:00Z', reviewed: false },
  ] : [{ call_id: 'c1' }]) });
  await ctx.loadReviewedSet();
  assert.deepEqual([...ctx.RV.reviewedSet], ['c1'], 'an un-marked row is not reviewed');
  assert.equal(ctx.RV.notesByCall.c2.note, 'old note', '...but its note still shows');
  assert.match(ctx.sent[0].url, /select=call_id,note,reviewed_by,reviewed_at,reviewed&/);

  const el = fakeEl();
  await ctx.toggleCallReviewed('c1', el);
  const req = ctx.sent.at(-1);
  assert.equal(req.method, 'PATCH');
  assert.match(req.url, /^call_reviews\?call_id=eq\.c1&reviewed_by=eq\.me%40example\.com&select=call_id$/);
  assert.deepEqual(req.body, { reviewed: false });
  assert.ok(!ctx.sent.some(r => r.method === 'DELETE'));
  assert.equal(ctx.RV.reviewedSet.has('c1'), false);
  assert.equal(ctx.RV.notesByCall.c1.note, 'asked twice for pricing', 'the note stays on screen and in the row');
  assert.equal(el.textContent, 'Mark reviewed');
  assert.equal(el.attrs['aria-pressed'], 'false');
  assert.equal(el.classList.on, false);

  await ctx.toggleCallReviewed('c1', el);   // re-mark: upsert reviewed=true, no note key (keeps the note)
  assert.equal(ctx.sent.at(-1).method, 'POST');
  assert.deepEqual(Object.keys(ctx.sent.at(-1).body).sort(), ['call_id', 'ivr_name', 'reviewed', 'reviewed_at', 'reviewed_by']);
  assert.equal(ctx.sent.at(-1).body.reviewed, true);
  assert.equal(ctx.RV.reviewedSet.has('c1'), true);
  assert.equal(el.textContent, 'Reviewed');
  assert.equal(el.attrs['aria-pressed'], 'true');
});

test("B3: a colleague's review is shown as theirs and can't be flipped off from your screen", async () => {
  const ctx = reviewCtx({ sbFetch: async () => [{ call_id: 'c1', note: null, reviewed_by: 'pat@example.com', reviewed_at: '2026-11-10T16:00:00Z', reviewed: true }] });
  await ctx.loadReviewedSet();
  const row = ctx.reviewCallRow({ id: 'c1', created_at: '2026-11-10T16:00:00Z', ivr_duration: 61 }, 0);
  assert.match(row, /<button type="button" class="rv-check on"[^>]* title="Marked reviewed by pat@example\.com" disabled[^>]*>Reviewed by Pat</);
  const before = ctx.sent.length;
  await ctx.toggleCallReviewed('c1', fakeEl());
  assert.equal(ctx.sent.length, before, 'no request');
  assert.equal(ctx.RV.reviewedSet.has('c1'), true, 'it used to flip to unreviewed on screen only');
});

test('B3: un-marking fails loudly when no row was updated', async () => {
  const ctx = reviewCtx({ sbFetch: async url => (url.startsWith('call_reviews?select=') ? [{ call_id: 'c1', reviewed_by: 'me@example.com', reviewed: true }] : []) });
  await ctx.loadReviewedSet();
  await ctx.toggleCallReviewed('c1', fakeEl());
  assert.match(ctx.alerts[0], /no review row was updated/);
  assert.equal(ctx.RV.reviewedSet.has('c1'), true);
});

test('UI6 + UI15: call rows show the Registry outcome and summary, Mark reviewed is a button, links are http(s) only', () => {
  const ctx = reviewCtx();
  const call = { id: "c'1", created_at: '2026-11-10T16:00:00Z', ivr_duration: 61, our_outcome: 'sale', our_summary: 'Booked <b>Tuesday</b> install.',
    recording_url: 'javascript:alert(1)', ascnd_recording_url: 'https://rec.example/a.mp3' };
  const row = ctx.reviewCallRow(call, 3);
  assert.match(row, /<span title="Registry outcome"><span class="outcome-badge outcome-positive">sale<\/span><\/span>/);
  assert.match(row, /<div class="rv-call-sum">Booked &lt;b&gt;Tuesday&lt;\/b&gt; install\.<\/div>/);
  assert.doesNotMatch(row, /AI summary|AI outcome/, 'no per-row "AI ..." labels (S-42)');
  assert.match(row, /<button type="button" class="rv-check" id="rv-chk-3" aria-pressed="false"/, 'a <span> was not keyboard-reachable');
  assert.match(row, /href="https:\/\/rec\.example\/a\.mp3"/, 'falls back to the ASCND recording');
  assert.doesNotMatch(row, /javascript:/);
  const none = ctx.reviewCallRow({ ...call, recording_url: 'javascript:x', ascnd_recording_url: 'data:text/html,x' }, 4);
  assert.doesNotMatch(none, /Recording<\/a>/);
});

test('B3: saving a note marks the call reviewed by you', async () => {
  const ctx = reviewCtx();
  ctx.document = { getElementById: () => ({ value: ' new note ' }) };
  await ctx.rvSaveNote('c9', 0);
  assert.equal(ctx.sent.at(-1).body.reviewed, true);
  assert.equal(ctx.sent.at(-1).body.note, 'new note');
  assert.deepEqual([...ctx.RV.reviewers.c9], ['me@example.com']);
});

// ── UI9: Review date picker ─────────────────────────────────────────────────
test('UI9: picking Nov 1 reviews from local midnight Nov 1 and says so (it said Oct 31)', () => {
  const els = { 'rv-window-date': {} };   // "Calls since [date input]" (S-44): the input is the label
  const ctx = load({ RV: { windowStart: new Date() }, document: { getElementById: id => els[id] }, loadReviewMetrics() {}, loadReviewedSet() {}, loadReviewCalls() {}, loadEvalDisagree() {} },
    ['function toISO(', 'function fmtDate(', 'function updateReviewWindowLabel(', 'function reviewSetWindow('], ['reviewSetWindow', 'updateReviewWindowLabel']);
  ctx.reviewSetWindow('2026-11-01');
  assert.equal(els['rv-window-date'].value, '2026-11-01');
  assert.equal(ctx.RV.windowStart.toISOString(), '2026-11-01T06:00:00.000Z');
  ctx.RV.windowStart = new Date('2026-10-14T03:30:00Z');   // 9:30 pm Oct 13 in Denver
  ctx.updateReviewWindowLabel();
  assert.equal(els['rv-window-date'].value, '2026-10-13', 'the input shows the local day, not the UTC one');
});

// ── B5 + B6: Insights ───────────────────────────────────────────────────────
test('B5: Insights groups a renamed IVR under its agent (old name was -100%, new name "new")', async () => {
  const aliasMap = { 'ASCND AI Agent - Roofing_13853550000 - Outgoing': 'ASCND AI Agent - Roofing - Outgoing' };
  const rpc = rows => load({ insVerticalFilter: [], resolveIvrName: n => aliasMap[n] || n, sbFetch: async () => rows, setTimeout },
    ['function pgQuote(', 'function isSent(', 'function isPaid(', 'function insDayWindows(', 'async function insFetchRetry(', 'async function insFetchPeriod('], ['insFetchPeriod']);
  const row = (ivr, raw) => ({ ivr_name: ivr, publisher_name: 'Pub A', advertiser_name: 'Adv X', raw, sent: raw, paid: 1, revenue: 10, payout: 2 });
  const sep = await rpc([row('ASCND AI Agent - Roofing - Outgoing', 40)]).insFetchPeriod('2026-09-01', '2026-09-30');
  const oct = await rpc([row('ASCND AI Agent - Roofing - Outgoing', 5), row('ASCND AI Agent - Roofing_13853550000 - Outgoing', 30)]).insFetchPeriod('2026-10-01', '2026-10-31');
  assert.deepEqual(Object.keys(oct.agents), ['ASCND AI Agent - Roofing - Outgoing']);
  assert.equal(oct.agents['ASCND AI Agent - Roofing - Outgoing'].raw, 35);
  assert.deepEqual(Object.keys(oct.pubs['Pub A'].byAgent), ['ASCND AI Agent - Roofing - Outgoing'], 'publisher breakdowns too');
  assert.equal(sep.agents['ASCND AI Agent - Roofing - Outgoing'].raw, 40);
});

// A small DOM for the Insights output: rows, headers and expand rows parsed out of the rendered
// HTML; sections can be replaced through outerHTML like the page does on sort.
function insightsDom() {
  const els = new Map(), all = [];
  const mkClass = () => { const set = new Set(); return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c), toggle(c, on) { (on ?? !set.has(c)) ? set.add(c) : set.delete(c); } }; };
  const mk = (kind, attrs) => {
    const el = { kind, dataset: {}, classList: mkClass(), listeners: [], addEventListener(t, fn) { this.listeners.push(fn); } };
    for (const [, k, v] of attrs.matchAll(/([a-z-]+)="([^"]*)"/g)) {
      if (k === 'id') el.id = v;
      else if (k === 'class') v.split(/\s+/).forEach(c => el.classList.add(c));
      else if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = unhtml(v);
    }
    el.closest = sel => (el.classList.contains(sel.slice(1)) ? el : null);
    if (kind === 'tr' && el.classList.contains('ins-expand-trigger')) { const chev = { classList: mkClass() }; el.querySelector = () => chev; }
    return el;
  };
  function scan(markup, sect) {
    for (const [, kind, attrs] of markup.matchAll(/<(tr|th|div)\b([^>]*)>/g)) {
      const el = mk(kind, attrs);
      if (!el.id && !el.dataset.sect) continue;
      el.sect = sect || el.dataset.sect || (el.id && el.id.split('-')[2]);
      if (el.id) els.set(el.id, el);
      all.push(el);
      if (el.id && el.id.startsWith('ins-section-')) {
        const s = el.id.slice('ins-section-'.length);
        Object.defineProperty(el, 'outerHTML', { set(h) { for (let i = all.length - 1; i >= 0; i--) if (all[i].sect === s) { els.delete(all[i].id); all.splice(i, 1); } scan(h, s); } });
      }
    }
  }
  const out = { id: 'ins-output', listeners: [], addEventListener(t, fn) { this.listeners.push(fn); } };
  Object.defineProperty(out, 'innerHTML', { set(h) { els.clear(); all.length = 0; scan(h); } });
  const document = {
    getElementById: id => (id === 'ins-output' ? out : els.get(id) || null),
    querySelectorAll: sel => all.filter(e => e.classList.contains(sel.slice(1))),
  };
  // A click runs the element's own listeners, then bubbles to #ins-output.
  const click = el => { const e = { target: el }; el.listeners.forEach(fn => fn(e)); out.listeners.forEach(fn => fn(e)); if (out.onclick) out.onclick(e); };
  const row = (sect, key) => all.find(e => e.kind === 'tr' && e.dataset.sect === sect && e.dataset.key === key);
  const th = (sect, col) => all.find(e => e.kind === 'th' && e.dataset.sect === sect && e.dataset.col === col);
  const isOpen = (sect, key) => els.get(`ins-exp-${sect}-${key.replace(/[^a-zA-Z0-9]/g, '_')}`).classList.contains('open');
  return { document, click, row, th, isOpen };
}

test('B6: Insights rows in other sections still expand after you sort one section (audit repro)', () => {
  const dom = insightsDom();
  const fns = ['function esc(', 'function nullMark(', 'function labelOf(', 'function fmtShortD(', 'function insConv(', 'function insFmtDelta(', 'function insFmtRev(', 'function insFmtConv(', 'function insPeriodLabel(',
    'function insBuildMovers(', 'function insSortRows(', 'function insRenderResults(', 'function insRenderSection(', 'function insExpandContent('];
  if (html.includes('function insOutputClick(')) fns.push('function insOutputClick('); else fns.push('function insAttachListeners(');
  const ctx = load({ document: dom.document, insSortState: { pub: { col: 'dRev', dir: -1 }, adv: { col: 'dRev', dir: -1 }, agent: { col: 'dRev', dir: -1 } }, insLastResults: null }, fns, ['insRenderResults']);
  const t = (raw, rev) => ({ raw, sent: raw, paid: Math.round(raw / 4), rev, margin: rev / 2, byAgent: { 'ASCND - Roofing': { raw, paid: 1, rev } } });
  const dA = { pubs: { 'Pub A': t(100, 1000), "Pub B's": t(80, 900) }, advs: { 'Adv X': t(120, 2000), 'Adv Y': t(60, 500) }, agents: { 'ASCND - Roofing': t(180, 2500) } };
  const dB = { pubs: { 'Pub A': t(40, 300), "Pub B's": t(90, 1500) }, advs: { 'Adv X': t(50, 600), 'Adv Y': t(70, 900) }, agents: { 'ASCND - Roofing': t(130, 1500) } };
  ctx.insLastResults = { dA, dB, thrCalls: 0, thrRevPct: 10, thrConv: Infinity, pA: { start: '2026-10-01', end: '2026-10-31' }, pB: { start: '2026-11-01', end: '2026-11-30' } };
  ctx.insRenderResults(ctx.insLastResults);

  dom.click(dom.row('adv', 'Adv X'));
  assert.equal(dom.isOpen('adv', 'Adv X'), true, 'opens before any sort');
  dom.click(dom.row('adv', 'Adv X'));
  assert.equal(dom.isOpen('adv', 'Adv X'), false);
  dom.click(dom.th('pub', 'revA'));   // sort Publishers
  dom.click(dom.row('adv', 'Adv X'));
  assert.equal(dom.isOpen('adv', 'Adv X'), true, 'another section still opens after a sort (it toggled twice)');
  dom.click(dom.row('pub', "Pub B's"));
  assert.equal(dom.isOpen('pub', "Pub B's"), true, 'the re-sorted section opens too');
  dom.click(dom.th('pub', 'revA'));
  dom.click(dom.th('adv', 'revB'));
  dom.click(dom.row('agent', 'ASCND - Roofing'));
  assert.equal(dom.isOpen('agent', 'ASCND - Roofing'), true, 'and after several sorts');
});

// ── B7: digest link = the calls the email counted ───────────────────────────
// A small PostgREST: the filter operators the Calls tab sends.
function pgSplit(s) {   // top-level comma split, respecting quotes and parentheses
  const out = []; let cur = '', depth = 0, q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === '\\') cur += s[++i]; else if (ch === '"') q = false; continue; }
    if (ch === '"') q = true;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && !depth) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  return out.concat(cur);
}
const unquote = v => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v);
function pgTermMatch(row, col, op, raw) {
  const cell = row[col], v = unquote(raw);
  const t = x => Date.parse(x);
  switch (op) {
    case 'eq': return String(cell) === v;
    case 'neq': return op === 'neq' && JSON.stringify(cell ?? null) !== v;
    case 'gt': return cell != null && t(cell) > t(v);
    case 'gte': return cell != null && t(cell) >= t(v);
    case 'lt': return cell != null && t(cell) < t(v);
    case 'lte': return cell != null && t(cell) <= t(v);
    case 'is': return v === 'null' ? cell == null : cell === (v === 'true');
    case 'cs': return JSON.parse(v).every(x => (cell || []).includes(x));
    case 'ilike': return new RegExp('^' + v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(cell || '');
    default: throw new Error('operator not in the fake: ' + op);
  }
}
function pgLogic(row, expr) {   // or(a,b) / and(or(..),or(..)) / col.op.value
  const m = expr.match(/^(or|and)\((.*)\)$/s);
  if (m) { const items = pgSplit(m[2]).map(x => pgLogic(row, x)); return m[1] === 'or' ? items.some(Boolean) : items.every(Boolean); }
  const [, col, op, val] = expr.match(/^([a-z_]+)\.([a-z]+)\.(.*)$/s);
  return pgTermMatch(row, col, op, val);
}
function pgMatch(row, filters) {
  for (const [k, v] of new URLSearchParams(filters.replace(/^&/, ''))) {
    if (k === 'or' || k === 'and') { if (!pgLogic(row, `${k}${v}`)) return false; continue; }
    const [, op, val] = v.match(/^([a-z]+)\.(.*)$/s);
    if (!pgTermMatch(row, k, op, val)) return false;
  }
  return true;
}

function callsPage(params) {
  const ctx = load({
    crDrpPickStart: null, crDrpPickEnd: null, crLinkScope: null, crPendingVerticals: null, crAutoLoaded: false,
    CR_OUTCOME_GROUPS: [], AGENTS: [], aliasesForAgent: () => [], crOutcomeGroupMembers: () => [], crSelectedVerticals: () => [],
    crApplyPendingVerticals() {}, crRenderLinkScope() {}, crLoad() {}, fmtShortD: x => x,
    values: { 'cr-rec-filter': '', 'cr-pub-filter': 'stale text', 'cr-adv-filter': '', 'cr-search': '' }, active: {},
  }, ['function localDayRange(', 'function pgQuote(', 'function crSearchFilter(', 'function crBuildFilters(', 'function applyCallsFilters('], ['crBuildFilters', 'applyCallsFilters']);
  ctx.document = { getElementById: id => ({ get value() { return ctx.values[id] ?? ''; }, set value(v) { ctx.values[id] = v; }, classList: { contains: c => !!ctx.active[id], add() { ctx.active[id] = true; } } }) };
  ctx.applyCallsFilters(new URLSearchParams(params));
  return ctx;
}

test('B7: the digest link opens exactly the calls the email counted for that account', () => {
  const from = '2026-11-09T23:58:00.000Z', to = '2026-11-12T21:54:00.000Z';   // last send → this send (late sends)
  const c = (id, o) => ({ id, publisher_name: 'Pub A', advertiser_name: 'Buyer', vertical_name: 'Roofing', is_test: false, suspicious_call: false,
    created_at: '2026-11-11T15:00:00.000Z', ai_processed_at: '2026-11-12T09:00:00.000Z', flags: [], ...o });
  const calls = [
    c('flagged', { flags: ['geo_mismatch'] }),
    c('two-flags', { flags: ['angry_caller', 'quoted_abandoned'] }),
    c('suspicious-only', { suspicious_call: true }),                                              // counted; "any flag" missed it
    c('quoted-abandoned-only', { flags: ['quoted_abandoned'] }),                                 // not a digest flag
    c('clean', {}),
    c('made-early', { flags: ['outbound_dial'], created_at: '2026-11-09T05:30:00.000Z' }),      // made before the last send, scored after it
    c('scored-before', { flags: ['geo_mismatch'], ai_processed_at: '2026-11-09T12:00:00.000Z' }),// last digest's
    c('scored-after', { flags: ['geo_mismatch'], ai_processed_at: '2026-11-12T23:00:00.000Z' }), // next digest's
    c('look-alike', { flags: ['geo_mismatch'], publisher_name: 'Pub A2' }),                       // substring match pulled it in
    c('test-call', { flags: ['geo_mismatch'], is_test: true }),
  ];
  // What alert.js counts: the window's non-test calls, tallied per account.
  const windowCalls = calls.filter(x => !x.is_test && Date.parse(x.ai_processed_at) > Date.parse(from) && Date.parse(x.ai_processed_at) <= Date.parse(to));
  const ranked = rankAccounts(tallyAccounts(windowCalls, new Set(), new Set(['Pub A']), buildBaseline(windowCalls)));
  const [acct] = ranked;
  const email = buildEmail({ manager_name: 'Pat Example' }, ranked, 'Nov 9 – Nov 12', from, to);
  const link = new URL(unhtml(email.match(/href="([^"]*digest=1[^"]*)"/)[1]));
  assert.equal(link.searchParams.get('account'), 'Pub A');
  assert.ok(!link.searchParams.get('flags').split(',').includes('quoted_abandoned'));

  const page = callsPage(link.search);
  assert.deepEqual({ ...page.crLinkScope, flags: [...page.crLinkScope.flags] }, { account: 'Pub A', type: 'publisher', flags: link.searchParams.get('flags').split(','), scoredFrom: from, scoredTo: to });
  assert.equal(page.values['cr-pub-filter'], '', 'the substring box is cleared, the exact scope applies');
  const shown = calls.filter(r => pgMatch(r, page.crBuildFilters())).map(r => r.id).sort();
  assert.deepEqual(shown, ['flagged', 'made-early', 'suspicious-only', 'two-flags']);
  assert.equal(shown.length, acct.curr.flaggedCalls, 'same number as the email');
  // The summary strip keeps the account + window but not the flag set (the flag rate stays a ratio).
  assert.deepEqual(calls.filter(r => pgMatch(r, page.crBuildFilters(false))).map(r => r.id).sort(), ['clean', 'flagged', 'made-early', 'quoted-abandoned-only', 'suspicious-only', 'two-flags']);
  // A search ANDs with the flag set as and=(or(…),or(…)).
  page.values['cr-search'] = 'Roofing';
  assert.match(page.crBuildFilters(), /&and=\(or\(/);
});

test('B7: links from digests already sent keep their substring match', () => {
  const page = callsPage('?tab=calls&account=Pub%20A&type=publisher&from=2026-11-05&to=2026-11-09T16%3A00%3A00&flagged=1');
  assert.equal(page.crLinkScope, null);
  assert.equal(page.values['cr-pub-filter'], 'Pub A');
  assert.match(page.crBuildFilters(), /&publisher_name=ilike\.\*Pub%20A\*/);
  assert.match(page.crBuildFilters(), /&flags=neq\.%5B%5D/);
});

// ── N6: Load more / Export use the loaded table's filters ───────────────────
test('N6: Load more and Export reuse the filters the table was loaded with, not later edits', async () => {
  const fetched = [];
  const els = { 'cr-run-btn': {}, 'cr-output': {}, 'cr-export-btn': {} };
  const ctx = load({
    crDrpPickStart: '2026-11-02', crDrpPickEnd: '2026-11-08', crRows: [], crOffset: 0, crPageSize: 25, crHasMore: false, crTotal: null, crLoadSeq: 0, crApplied: null,
    crSortCol: 'created_at', crSortDir: -1, live: '&publisher_name=ilike.*Acme*', compAssignments: [{}], AGENTS: [], aliasesForAgent: () => [],
    crBuildFilters(withFlags = true) { return this.live + (withFlags ? '' : '&strip'); },
    loadOutcomeWeights: async () => ({}), ensureVerticals: async () => {}, crRender() {}, callsLoadSummary() {},
    document: { getElementById: id => els[id] || {} }, alert() {}, console: { warn() {} },
    sbFetch: async url => { fetched.push(url); return Array.from({ length: 25 }, (_, i) => ({ id: 'r' + i })); },
    Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
  }, ['function crBuildQuery(', 'async function crLoad(', 'async function crExportAll('], ['crLoad', 'crExportAll']);
  ctx.crBuildFilters = ctx.crBuildFilters.bind(ctx);
  await ctx.crLoad(false);
  ctx.live = '&publisher_name=ilike.*Bolt*';   // typed, not applied
  ctx.crDrpPickStart = '2026-10-01';           // picked, not applied
  await ctx.crLoad(true);
  assert.equal(fetched.length, 2);
  assert.ok(fetched.every(u => u.includes('ilike.*Acme*') && !u.includes('Bolt')), fetched.join('\n'));
  ctx.sbFetch = async url => { fetched.push(url); return []; };
  await ctx.crExportAll();
  assert.ok(fetched.at(-1).includes('ilike.*Acme*'), 'export = what the table shows');
  assert.equal(ctx.crApplied.start, '2026-11-02');
  await ctx.crLoad(false);   // the next filter apply (crApply) loads the edits
  assert.ok(fetched.at(-1).includes('Bolt'));
});

// ── N5: Agents range race + failed load ─────────────────────────────────────
test('N5: a range change during a load is not dropped, and the older reply does not overwrite it', async () => {
  const replies = [];
  const els = { 'freshness-label': {} };
  const ctx = load({
    currentTab: 'agents', metricsSeq: 0, metricsFailed: false, agentsMetricsDeferred: false, AGENTS: [{ ivrName: 'A', status: 'live' }],
    activeRange: { start: new Date('2026-10-13T06:00:00Z'), end: new Date('2026-11-11T07:00:00Z'), label: '30d' },
    updateDataWindowLabels() {}, loadAllBreakdowns: () => Promise.resolve({}), loadAgentQuality() {}, aliasesForAgent: () => [], resolveIvrName: n => n,
    recomputeStats() {}, applyFilters() { ctx.drawn = (ctx.drawn || 0) + 1; }, loadFreshness() { ctx.fresh = true; }, console: { warn() {} },
    document: { getElementById: id => els[id] },
    sbFetch: () => { const d = deferred(); replies.push(d); return d.promise; },
  }, ['async function refreshMetrics('], ['refreshMetrics']);
  const first = ctx.refreshMetrics();
  ctx.activeRange = { ...ctx.activeRange, start: new Date('2026-11-04T07:00:00Z'), label: '7d' };
  const second = ctx.refreshMetrics();
  assert.equal(replies.length, 2, 'the second range was requested (it used to return early)');
  replies[1].resolve([{ ivr_name: 'A', raw: 7, sent: 7, paid: 1, revenue: 70, payout: 10 }]);
  await second;
  replies[0].resolve([{ ivr_name: 'A', raw: 300, sent: 300, paid: 30, revenue: 3000, payout: 100 }]);
  await first;
  assert.equal(ctx.AGENTS[0].raw_calls, 7, '7d numbers stay under the 7d label');
  assert.equal(ctx.drawn, 1);

  const fail = ctx.refreshMetrics();
  replies[2].reject(new Error('Supabase 500'));
  await fail;
  assert.equal(ctx.metricsFailed, true);
  assert.match(els['freshness-label'].textContent, /Couldn't load data/);
  const ok = ctx.refreshMetrics();
  replies[3].resolve([]);
  await ok;
  assert.equal(ctx.metricsFailed, false);
  assert.equal(ctx.fresh, true, 'the header pill error is replaced after a good load');
});

test('N5: after a failed load the cards say "No data" with dashes, not 0 and Inactive', () => {
  const ctx = load({ metricsFailed: true, openAgent: null, testCallMap: {}, vClass: () => '', rtLabel: () => 'Publisher-led', fmtPct: (a, b) => (b ? Math.round(a / b * 100) + '%' : '—'), renderTestCallRow: () => '', aeCardLine: () => '', agentLastCall: null },
    ['function esc(', 'function nullMark(', 'function labelOf(', 'function needsSetup(', 'function isInactive(', 'function getEffectiveStatus(', 'function renderCard('], ['renderCard']);
  const a = { name: 'Roofing', vertical: 'Home Services', status: 'live', raw_calls: 0, paid_calls: 0, revenue: 0, routingType: 'publisher-led', ivrName: 'A' };
  const card = ctx.renderCard(a, 0);
  assert.match(card, />No data</);
  assert.doesNotMatch(card, /Inactive|>0<|\$0/);
  ctx.metricsFailed = false;
  assert.match(ctx.renderCard(a, 0), />Inactive</);
});

// ── N7: stale replies ───────────────────────────────────────────────────────
test('N7: a slower Publisher reply does not overwrite the Advertiser view on Scores', async () => {
  const pending = [];
  const out = { innerHTML: '' };
  const ctx = load({
    scoresEntity: 'publisher', scoresWindow: 'master', scoresOpenKey: null, scoresExcluded: new Set(), scoresRows: [], scoresLoadSeq: 0, activeRange: {},
    document: { getElementById: id => (id === 'scores-output' ? out : null) },
    scoresFetchPairs: () => { const d = deferred(); pending.push(d); return d.promise; }, loadOutcomeWeights: async () => ({}),
    scoresComputeRows: pairs => pairs.map(p => ({ entity: p.entity_name, entityType: ctx.scoresEntity })), scoresRenderTable() { ctx.rendered = ctx.scoresRows.map(r => r.entity); },
    scoresWindowLabel() {},
  }, ['function esc(', 'function loadErrorHtml(', 'function scoresWindowRange(', 'async function scoresLoad('], ['scoresLoad']);
  const pub = ctx.scoresLoad();
  ctx.scoresEntity = 'advertiser';
  const adv = ctx.scoresLoad();
  pending[1].resolve([{ entity_name: 'Buyer X' }]);
  await adv;
  pending[0].resolve([{ entity_name: 'Pub A' }]);
  await pub;
  assert.deepEqual([...ctx.rendered], ['Buyer X']);
});

test('N7: the call drawer ignores a transcript that arrives after it moved to another call', async () => {
  const els = {};
  const el = id => (els[id] ??= { innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, value: '' });
  const pending = {};
  const ctx = load({
    ...OUTCOME_SETS, compDrawerCall: null, compDrawerFlags: [], copyId() {}, loadCorrectionHistory() {},
    document: { getElementById: el, querySelectorAll: () => [] },
    compFetch: url => { const d = deferred(); pending[decodeURIComponent(url.match(/id=eq\.([^&]*)/)[1])] = d; return d.promise; },
  }, ['function esc(', 'function nullMark(', 'function labelOf(', 'function outcomeBadge(', 'function flagBadges(', 'function openCallDrawer('], ['openCallDrawer']);
  ctx.openCallDrawer({ id: 'first' });
  ctx.openCallDrawer({ id: 'second' });
  pending.second.resolve([{ transcription: 'second call transcript' }]);
  await tick();
  pending.first.resolve([{ transcription: 'first call transcript' }]);
  await tick();
  assert.equal(els['drawer-transcript'].textContent, 'second call transcript');
});

test('N7: a Review board refresh does not draw over a review opened meanwhile', async () => {
  const d = deferred();
  const ctx = load({ RV: null, btn: {}, loadReviewBoardData: () => d.promise, renderReviewBoard() { ctx.drawn = true; } }, ['async function rvRefreshBoard('], ['rvRefreshBoard']);
  const p = ctx.rvRefreshBoard({});
  ctx.RV = { agent: {} };   // clicked into an agent
  d.resolve();
  await p;
  assert.equal(ctx.drawn, undefined);
});

// ── N8: Scores weights ──────────────────────────────────────────────────────
test('N8: a failed weights load is not kept for the session, and Scores says it failed', async () => {
  let calls = 0;
  const ctx = load({ scoresWeights: null, sbFetch: async () => { if (++calls === 1) throw new Error('Supabase 500'); return [{ outcome: 'sale', pub_score: 10, adv_score: 8 }]; } },
    ['async function loadOutcomeWeights('], ['loadOutcomeWeights']);
  await assert.rejects(ctx.loadOutcomeWeights(), /Supabase 500/);
  assert.equal(ctx.scoresWeights, null, 'it cached {} and every pairing read +0.0 / Tier 4');
  assert.deepEqual(JSON.parse(JSON.stringify(await ctx.loadOutcomeWeights())), { sale: { pub_score: 10, adv_score: 8 } });

  const out = { innerHTML: '' };
  const s = load({
    scoresEntity: 'publisher', scoresWindow: 'master', scoresOpenKey: null, scoresExcluded: new Set(), scoresLoadSeq: 0, activeRange: {},
    document: { getElementById: id => (id === 'scores-output' ? out : null) },
    scoresFetchPairs: async () => [{ entity_name: 'Pub A' }], loadOutcomeWeights: async () => { throw new Error('Supabase 500'); },
    scoresComputeRows() { throw new Error('should not compute'); }, scoresRenderTable() {}, scoresWindowLabel() {},
    warned: [], console: { warn: (...a) => s.warned.push(a.join(' ')) },
  }, ['function esc(', 'function loadErrorHtml(', 'function scoresWindowRange(', 'async function scoresLoad('], ['scoresLoad']);
  await s.scoresLoad();
  assert.match(out.innerHTML, /<div class="load-error" role="alert"><span>Couldn't load scores\.<\/span><button type="button" class="rv-btn" onclick="scoresLoad\(\)">Retry<\/button><\/div>/);
  assert.doesNotMatch(out.innerHTML, /Supabase/, 'the raw error is not shown (S-48)...');
  assert.match(s.warned.join('\n'), /Supabase 500/, '...it goes to the console');
});

// ── N1: Settings > Admin weights ────────────────────────────────────────────
function weightsCtx(compFetch) {
  const els = { 'settings-weights-table': { innerHTML: '' }, 'weights-execute-btn': { style: {} }, 'weights-execute-status': {} };
  const posts = [];
  const ctx = load({
    WEIGHT_GROUPS: [{ label: 'Positive', outcomes: ['sale', 'appointment'] }, { label: 'Defects', outcomes: ['misrouted'] }],
    weightsData: {}, weightsLoadError: null, weightsProcessedCount: null, weightsCountApprox: true, scoresWeights: null, console: { warn() {} },
    weightsLoadCount: async () => 123730, compFetch, compPost: async (table, rows) => { posts.push({ table, rows }); }, posts,
    sbFetch: async url => { ctx.recalc = url; return 123730; }, els,
  }, ['function esc(', 'function nullMark(', 'function labelOf(', 'function loadErrorHtml(', 'function weightsButtonLabel(', 'async function weightsInit(', 'function weightsRender(', 'async function weightsExecute('], ['weightsInit', 'weightsExecute']);
  // Inputs as rendered by weightsRender, editable by the test.
  ctx.inputs = () => [...els['settings-weights-table'].innerHTML.matchAll(/data-outcome="([^"]*)" data-field="([^"]*)"\s+value="([^"]*)"/g)]
    .map(([, outcome, field, value]) => ({ dataset: { outcome, field }, value }));
  ctx.document = { getElementById: id => els[id], querySelectorAll: () => ctx.shown };
  return ctx;
}

test('N1: a failed weights load shows the error and cannot save zeros over every outcome', async () => {
  const ctx = weightsCtx(async () => { throw new Error('Supabase 503'); });
  await ctx.weightsInit();
  assert.doesNotMatch(ctx.els['settings-weights-table'].innerHTML, /<input/, 'no editable zeros');
  assert.match(ctx.els['settings-weights-table'].innerHTML, /Couldn't load the current weights\.<\/span><button type="button" class="rv-btn" onclick="weightsInit\(\)">Retry</);
  assert.doesNotMatch(ctx.els['settings-weights-table'].innerHTML, /Supabase 503/, 'raw error to the console only (S-48)');
  assert.equal(ctx.els['weights-execute-btn'].disabled, true);
  assert.equal(ctx.els['weights-execute-btn'].textContent, 'Save (weights did not load)');
  ctx.shown = [];
  await ctx.weightsExecute();
  assert.deepEqual(ctx.posts, [], 'nothing written');
  assert.equal(ctx.recalc, undefined, 'no re-score of ~120k calls');
});

test('N1 + N8: Execute sends only the edited outcomes, then Scores uses the saved weights', async () => {
  const ctx = weightsCtx(async () => [{ outcome: 'sale', pub_score: 10, adv_score: 8 }, { outcome: 'misrouted', pub_score: -3, adv_score: -1 }]);
  await ctx.weightsInit();
  assert.equal(ctx.els['weights-execute-btn'].disabled, false);
  ctx.shown = ctx.inputs();
  await ctx.weightsExecute();
  assert.deepEqual(ctx.posts, [], 'no edits, no write');
  assert.equal(ctx.els['weights-execute-status'].textContent, 'No changes to save.');
  ctx.shown.find(i => i.dataset.outcome === 'misrouted' && i.dataset.field === 'pub_score').value = '-5';
  await ctx.weightsExecute();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.posts)), [{ table: 'outcome_weights', rows: [{ outcome: 'misrouted', pub_score: -5, adv_score: -1 }] }]);
  assert.equal(ctx.recalc, 'rpc/recalculate_call_scores');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.scoresWeights)), { sale: { pub_score: 10, adv_score: 8 }, misrouted: { pub_score: -5, adv_score: -1 } });
});

// ── N9: correction save ─────────────────────────────────────────────────────
function correctionCtx(patchRows) {
  const els = { 'correction-note': { value: 'AI missed the geo issue', focus() {} }, 'correction-outcome': { value: '' }, 'correction-save-btn': {}, 'correction-saved': { style: {} } };
  const ctx = load({
    compDrawerCall: { id: 'c1', our_outcome: 'sale', flags: [] }, compDrawerFlags: ['geo_mismatch'], crRows: [{ id: 'c1', flags: ['geo_mismatch'], compliance_reviewed: false }],
    getAuthUser: () => 'me@example.com', compPost: async () => {}, loadCorrectionHistory() {}, crRender() { ctx.rerendered = true; }, setTimeout() {},
    alert: m => { ctx.alerts.push(m); }, alerts: [], els, document: { getElementById: id => els[id] },
    sbFetch: async () => patchRows,
  }, ['async function saveCorrection('], ['saveCorrection']);
  return ctx;
}

test('N9: "Saved" shows only when the call was really marked reviewed, and the Calls row updates', async () => {
  const miss = correctionCtx([]);
  await miss.saveCorrection();
  assert.match(miss.alerts[0], /Correction saved, but the call could not be marked reviewed: no call was updated/);
  assert.notEqual(miss.els['correction-saved'].style.display, 'inline');
  assert.equal(miss.crRows[0].compliance_reviewed, false);

  const ok = correctionCtx([{ id: 'c1' }]);
  await ok.saveCorrection();
  assert.deepEqual(ok.alerts, []);
  assert.equal(ok.els['correction-saved'].style.display, 'inline');
  assert.equal(ok.crRows[0].compliance_reviewed, true, 'the Reviewed column showed "pending"');
  assert.equal(ok.rerendered, true);
});

// ── N10: managers / admin ───────────────────────────────────────────────────
test('N10: one failed managers load is retried, so admins get their sections back without a reload', async () => {
  let n = 0;
  const ctx = load({
    _assignmentsPromise: null, compManagers: [], compAssignments: [], window: {}, getAuthUser: () => 'admin@example.com', console: { warn() {} },
    compFetch: async url => {
      if (url.startsWith('account_managers') && ++n === 1) throw new Error('Supabase 503');
      return url.startsWith('account_managers') ? [{ id: 'm1', manager_email: 'admin@example.com', is_admin: true }] : [];
    },
    settingsRenderManagers() {}, document: { getElementById: () => ({}) },
  }, ['function ensureAssignments(', 'async function compLoadAssignments(', 'async function settingsLoadManagers('], ['ensureAssignments', 'settingsLoadManagers']);
  await ctx.ensureAssignments();
  assert.equal(ctx.window.isAdmin, undefined);
  assert.equal(ctx._assignmentsPromise, null, 'the failed load is not kept');
  await ctx.ensureAssignments();
  assert.equal(ctx.window.isAdmin, true);

  ctx.window.isAdmin = undefined;   // settingsInit's own retry path also settles admin status
  await ctx.settingsLoadManagers();
  assert.equal(ctx.window.isAdmin, true);
});

// ── UI1: Scores ─────────────────────────────────────────────────────────────
test('UI1: Scores opens on pairings whose scores are shown; low-volume rows sort last', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ entity: 'Low ' + i, vertical: 'Roofing', n: 3, gap: 8 - i / 10, canoeScore: 1, oursScore: 9 });
  for (let i = 0; i < 5; i++) rows.push({ entity: 'High ' + i, vertical: 'Roofing', n: 40 + i, gap: 1 + i / 10, canoeScore: 1, oursScore: 2 });
  const ctx = load({ scoresRows: rows, scoresSort: { key: 'gap', dir: -1 }, SCORES_MIN_CALLS: 20 }, ['function scoresSortRows('], ['scoresSortRows']);
  assert.deepEqual([...ctx.scoresSortRows().slice(0, 5).map(r => r.entity)], ['High 4', 'High 3', 'High 2', 'High 1', 'High 0']);
  for (const key of ['canoe', 'ours']) {
    ctx.scoresSort = { key, dir: -1 };
    assert.ok(ctx.scoresSortRows().slice(0, 5).every(r => r.n >= 20), key);
  }
});

test('UI1: the pairing detail has a View calls button that hands off with the exact account, vertical and window', () => {
  const r = { key: "Let's Lead\u0001Roofing", entity: "Let's Lead", vertical: 'Roofing', canoe: { sale: 30 }, ours: { sale: 30 }, n: 30, _dis: [] };
  const ctx = load({ scoresEntity: 'publisher', scoresWeights: { sale: { pub_score: 10 } }, scoresExcluded: new Set(), SCORES_MIN_CALLS: 20, scoresWindow: 'master', activeRange: {}, URLSearchParams },
    ['function esc(', 'function nullMark(', 'function labelOf(', 'function jsStr(', 'function httpUrl(', 'function crFmtDuration(', 'function scoresFmt(', 'function toISO(', 'function scoresRenderDetail(', 'function scoresWindowRange(', 'function scoresViewCalls('], ['scoresRenderDetail', 'scoresViewCalls']);
  const detail = ctx.scoresRenderDetail(r);
  const m = detail.match(/<button class="rv-btn" data-entity="([^"]*)" data-vertical="([^"]*)" onclick="([^"]*)">View all calls in Calls<\/button>/);
  assert.ok(m, 'scoresViewCalls had no caller');
  let handed = null;
  new Function('event', 'scoresViewCalls', unhtml(m[3])).call({ dataset: { entity: unhtml(m[1]), vertical: unhtml(m[2]) } }, { stopPropagation() {} }, (e, v) => { handed = [e, v]; });
  assert.deepEqual(handed, ["Let's Lead", 'Roofing']);

  let pushed = null;
  ctx.history = { pushState: (s, t, url) => { pushed = new URLSearchParams(url.slice(1)); } };
  ctx.applyRoute = () => {};
  ctx.scoresViewCalls("Let's Lead", 'Roofing');
  assert.equal(pushed.get('exact'), '1');
  assert.equal(pushed.get('account'), "Let's Lead");
  assert.equal(pushed.get('vertical'), 'Roofing');
  assert.match(pushed.get('from'), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(pushed.get('to'), /^\d{4}-\d{2}-\d{2}$/);
  const page = callsPage(pushed.toString());
  assert.match(page.crBuildFilters(), /&publisher_name=eq\.Let's%20Lead/);
  ctx.scoresViewCalls('Pub A', '(unknown)');
  assert.equal(pushed.get('vertical'), null, '"(unknown)" is not a real vertical_name');
});

// ── UI2: Calls columns ──────────────────────────────────────────────────────
test('UI2: mostly-empty columns start off, and column choices are saved and restored', () => {
  const store = {};
  const localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  const src = html.slice(html.indexOf('const CR_COLUMNS = ['), html.indexOf('function crColPickerToggle('));
  const run = () => { const ctx = { localStorage, console }; vm.runInNewContext(src.replace(/^const |\nlet /g, m => m.replace(/const |let /, 'var ')), ctx); return ctx; };
  const a = run();
  for (const k of ['recording', 'disposition', 'disposition_description']) assert.equal(a.crVisibleCols[k], false, k);
  for (const k of ['created_at', 'publisher_name', 'outcome', 'flags']) assert.equal(a.crVisibleCols[k], true, k);
  a.crVisibleCols.recording = true; a.crVisibleCols.flags = false;
  a.crSaveColPrefs();
  const b = run();
  assert.equal(b.crVisibleCols.recording, true, 'restored on the next visit');
  assert.equal(b.crVisibleCols.flags, false);
  store.cr_visible_cols = '{not json';
  assert.equal(run().crVisibleCols.flags, true, 'bad saved data falls back to the defaults');
  assert.doesNotMatch(lift('async function bootDashboard('), /crVisibleCols\s*=/, 'boot used to reset the columns to the defaults');
});

// ── UI8 / UI9: copy and model compare ───────────────────────────────────────
test('UI8: model labels match their ids, and the digest says what "other flagged accounts" are', () => {
  const catalog = html.slice(html.indexOf('const MODEL_CATALOG = ['), html.indexOf('];', html.indexOf('const MODEL_CATALOG = [')));
  assert.match(catalog, /'nvidia\/nemotron-super-49b-v1',\s+label: 'Nemotron Super 49B'/);
  assert.match(catalog, /'nvidia\/nemotron-ultra-253b-v1', label: 'Nemotron Ultra 253B'/);
  const email = buildEmail({ manager_name: 'Pat Example' }, rankAccounts(tallyAccounts([{ publisher_name: 'A', flags: ['geo_mismatch'], ai_processed_at: 'x' }], new Set(), new Set(['A']), buildBaseline([]))), 'Nov 9 – Nov 12', '2026-11-09T16:00:00Z', '2026-11-12T16:00:00Z');
  assert.doesNotMatch(email, /normal range/);
  assert.match(email, /fewer than 3 calls with any one flag/);
  // S-33: the label is just "Revenue"; its tooltip still says it covers every row the table matches.
  assert.match(html, /title="Advertiser payin on every call the table matches, including the Flagged only and flag-type filters\."><div class="summary-val" id="calls-stat-revenue">[^\n]*<div class="summary-lbl">Revenue<\/div>/);
});

test('UI9: model compare prices every catalog model and gemini-3.6-flash; an unpriced model says so instead of $0.00', () => {
  const tw = { innerHTML: '' };
  const src = html.slice(html.indexOf('const MODEL_CATALOG = ['), html.indexOf('let calibQueueCount')) + '\n' + html.slice(html.indexOf('const MT_PRICES = {'), html.indexOf('let mtState'));
  const ctx = { document: { getElementById: () => tw } };
  vm.runInNewContext(src.replace(/^const (MODEL_CATALOG|MT_PRICES)/gm, 'var $1') + '\n' + ['function esc(', 'function nullMark(', 'function labelOf(', 'function mtRender('].map(lift).join('\n') + '\nthis.mtRender = mtRender; var mtShort = m => m.split("/").pop();', ctx);
  for (const m of vm.runInNewContext('MODEL_CATALOG', ctx)) assert.ok(vm.runInNewContext('MT_PRICES', ctx)[m.id], m.id);
  const call = (models) => ({ id: 'c1-aaaaaaaa', byModel: Object.fromEntries(models.map(m => [m, { outcome: 'sale', flags: [], in: 4000, out: 300 }])) });
  const models = ['gemini-3.6-flash', 'nvidia/nemotron-super-49b-v1', 'anthropic/claude-sonnet-5'];
  vm.runInNewContext('mtState = s', Object.assign(ctx, { s: { models, calls: [call(models)] } }));
  ctx.mtRender();
  assert.match(tw.innerHTML, /gemini-3\.6-flash<\/div>[\s\S]*?\$8\.25\/1k/, '4000 in x $1.50 + 300 out x $7.50 per 1M = $8.25 per 1k calls');
  assert.match(tw.innerHTML, /nemotron-super-49b-v1<\/div>[\s\S]*?\$0\.48\/1k/);
  assert.match(tw.innerHTML, /claude-sonnet-5<\/div>[\s\S]*?price n\/a/);
  assert.doesNotMatch(tw.innerHTML, /\$0\.00/);
});
