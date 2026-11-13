// UI cleanup pass 3 (Calls, call drawer, Review, Scores, Settings): every Calls filter applies as it
// changes, with one Outcome select and the deep links intact (S-34), separate Outcome / Canoe columns
// (S-36), real toggle buttons (S-46), one load-error helper (S-48), plus the copy changes (S-33 to S-52).
// index.html has no build step, so the code is lifted out of the page and run with stubs.
// Run: node --test tests/
process.env.TZ = 'America/Denver';   // Calls local-day bounds depend on it
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// Source of a top-level `function name(` or `async function name(` declaration, by brace matching
// from the body's opening brace (after the parameter list, which may hold a `= 0` default).
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
// The flag-severity block (consts + helpers) can't be lifted by brace matching; load() adds it
// whenever a lifted function uses it.
function severityBlock() {
  const s = html.indexOf('const FLAG_SEVERITY = {'), e = html.indexOf('\n', html.indexOf('function callFlags(', s));
  return html.slice(s, e);
}
function load(ctx, decls, exportNames) {
  const src = decls.map(lift).join(';\n');
  const sev = /\b(bySeverity|flagSeverity|callFlags|HIGH_FLAGS|SEVERITY_ORDER|FLAG_SEVERITY)\b/.test(src) ? severityBlock() + ';\n' : '';
  vm.runInNewContext(sev + src + ';\n' + exportNames.map(n => `this.${n} = ${n};`).join(' '), ctx);
  return ctx;
}
const unhtml = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = s => unhtml(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// Fake timers: setTimeout queues, flush() runs what was not cleared.
function fakeTimers() {
  const q = new Map(); let id = 0;
  return { setTimeout: (fn, ms) => { q.set(++id, { fn, ms }); return id; }, clearTimeout: k => q.delete(k),
    pending: () => [...q.values()], flush() { const due = [...q.values()]; q.clear(); due.forEach(t => t.fn()); } };
}
const classes = (on = []) => { const set = new Set(on); return { set, add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c), toggle(c, v) { (v ?? !set.has(c)) ? set.add(c) : set.delete(c); return set.has(c); } }; };

// ── S-34: Calls filters apply as they change ────────────────────────────────
function applyCtx(over = {}) {
  const t = fakeTimers();
  const ctx = load({ crDrpPickStart: '2026-11-02', crDrpPickEnd: '2026-11-08', crApplyTimer: null, loads: [],
    crLoad(append) { ctx.loads.push(append); }, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, ...over },
  ['function crApply('], ['crApply']);
  ctx.timers = t;
  return ctx;
}

test('S-34: a select / toggle / range change loads at once; typed text waits 400 ms and loads once', () => {
  const ctx = applyCtx();
  ctx.crApply();
  assert.deepEqual(ctx.loads, [false], 'a fresh load (not Load more)');
  ctx.crApply(400); ctx.crApply(400); ctx.crApply(400);   // three keystrokes
  assert.equal(ctx.loads.length, 1, 'nothing until typing pauses');
  assert.deepEqual(ctx.timers.pending().map(p => p.ms), [400], 'each keystroke restarts the one timer');
  ctx.timers.flush();
  assert.deepEqual(ctx.loads, [false, false], 'one reload for the whole edit');
  ctx.crApply(400); ctx.crApply();   // a select change during the pause wins and cancels the pending one
  ctx.timers.flush();
  assert.equal(ctx.loads.length, 3);
  const none = applyCtx({ crDrpPickEnd: null });
  none.crApply(); none.crApply(400); none.timers.flush();
  assert.deepEqual(none.loads, [], 'no range yet: nothing to load');
});

test('S-34: every filter control is wired to apply on change, and the Load calls button is gone', () => {
  for (const id of ['cr-rec-filter', 'cr-flag-filter', 'cr-outcome-filter'])
    assert.match(html, new RegExp(`<select[^>]*id="${id}"[^>]*onchange="crApply\\(\\)"`), id);
  assert.doesNotMatch(html, /id="cr-run-btn"|>Load calls<|click <strong>Load calls/);
  assert.doesNotMatch(html, /cr-outcome-group-filter|crOutcomeChange|crOutcomeGroupChange/, 'one Outcome select');

  // The text inputs: an `input` listener each, debounced through crApply(400).
  const src = html.slice(html.indexOf('// ─── CR FILTER INPUTS'), html.indexOf('// ─── BOOT'));
  const inputs = {}, delays = [];
  let ready = null;
  vm.runInNewContext(src, {
    crApply: d => delays.push(d),
    document: { addEventListener: (ev, fn) => { assert.equal(ev, 'DOMContentLoaded'); ready = fn; },
      getElementById: id => (inputs[id] = { handlers: {}, addEventListener(ev, fn) { this.handlers[ev] = fn; } }) },
  });
  ready();
  assert.deepEqual(Object.keys(inputs).sort(), ['cr-adv-filter', 'cr-pub-filter', 'cr-search']);
  Object.values(inputs).forEach(el => el.handlers.input());
  assert.deepEqual(delays, [400, 400, 400]);
});

test('S-34: Flagged only is a pressed/unpressed toggle that applies; vertical ticks apply after a pause, a deep link\'s do not reload', () => {
  const applied = [];
  const btn = { classList: classes(), attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const boxes = ['Roofing', 'Solar', 'Legal'].map(value => ({ value, checked: false }));
  const all = { value: 'all', checked: true };
  const pop = { querySelector: () => all, querySelectorAll: sel => (sel.includes(':not') ? boxes : [all, ...boxes]) };
  const label = { textContent: '' };
  const ctx = load({ crApply: d => applied.push(d ?? 0), crPendingVerticals: null,
    document: { getElementById: id => ({ 'cr-vertical-popover': pop, 'cr-vertical-label': label })[id] } },
  ['function crToggleFlagged(', 'function crVerticalAll(', 'function crVerticalChange(', 'function crVerticalSync(', 'function crSelectedVerticals(',
    'function crVerticalUpdateLabel(', 'function crApplyPendingVerticals('], ['crToggleFlagged', 'crVerticalChange', 'crApplyPendingVerticals']);
  ctx.crToggleFlagged(btn);
  assert.equal(btn.classList.contains('active'), true);
  assert.equal(btn.attrs['aria-pressed'], 'true');
  ctx.crToggleFlagged(btn);
  assert.equal(btn.attrs['aria-pressed'], 'false');
  assert.deepEqual(applied, [0, 0]);

  ctx.crPendingVerticals = ['Solar'];   // ?vertical=Solar, options just rendered
  ctx.crApplyPendingVerticals();
  assert.equal(label.textContent, 'Solar');
  assert.equal(all.checked, false);
  assert.deepEqual(applied, [0, 0], 'the deep link\'s own crLoad applies it; no second load');
  boxes[0].checked = true;
  ctx.crVerticalChange();
  assert.equal(label.textContent, '2 verticals');
  assert.deepEqual(applied, [0, 0, 400]);
});

test('S-34: calendar clicks are a draft; Apply commits the range and loads, a half-picked range never leaks', () => {
  const pop = { classList: classes(['open']) };
  const els = { 'cr-drp-popover': pop, 'cr-drp-label': { textContent: 'Nov 2 – Nov 8' } };
  let applies = 0;
  const ctx = load({ crDrpPickStart: '2026-11-02', crDrpPickEnd: '2026-11-08', crDrpDraftStart: null, crDrpDraftEnd: null, crDrpSelecting: false,
    crDrpViewYear: 0, crDrpViewMonth: 0, crDrpRender() {}, crApply() { applies++; }, fmtShortD: x => x, Date,
    document: { getElementById: id => els[id] } },
  ['function crDrpToggle(', 'function crDrpClickDay(', 'function crDrpApply('], ['crDrpToggle', 'crDrpClickDay', 'crDrpApply']);
  const ev = { stopPropagation() {} };
  pop.classList.remove('open');
  ctx.crDrpToggle(ev);                       // open
  ctx.crDrpClickDay('2026-10-20');            // start only, then close without Apply
  ctx.crDrpToggle(ev);
  assert.deepEqual([ctx.crDrpPickStart, ctx.crDrpPickEnd], ['2026-11-02', '2026-11-08'], 'the applied range is untouched');
  ctx.crDrpApply();
  assert.equal(applies, 0, 'nothing to apply from a half pick');
  ctx.crDrpToggle(ev);                       // reopen: the draft restarts from the applied range
  assert.deepEqual([ctx.crDrpDraftStart, ctx.crDrpDraftEnd], ['2026-11-02', '2026-11-08']);
  ctx.crDrpClickDay('2026-10-25'); ctx.crDrpClickDay('2026-10-20');
  ctx.crDrpApply();
  assert.deepEqual([ctx.crDrpPickStart, ctx.crDrpPickEnd], ['2026-10-20', '2026-10-25']);
  assert.equal(els['cr-drp-label'].textContent, '2026-10-20 – 2026-10-25');
  assert.equal(pop.classList.contains('open'), false);
  assert.equal(applies, 1, 'Apply loads the new range');
});

// One page for the deep-link + Outcome select tests: applyCallsFilters fills the inputs, crBuildFilters reads them.
function linkPage(params, weights = null) {
  const values = { 'cr-rec-filter': '', 'cr-pub-filter': '', 'cr-adv-filter': '', 'cr-search': '', 'cr-flag-filter': '', 'cr-outcome-filter': '' };
  const flagged = { classList: classes(), attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const ctx = load({
    crDrpPickStart: null, crDrpPickEnd: null, crLinkScope: null, crPendingVerticals: null, crAutoLoaded: false, verts: [], loads: 0,
    scoresWeights: weights, AGENTS: [], aliasesForAgent: () => [], fmtShortD: x => x, crRenderLinkScope() {},
    crSelectedVerticals: () => ctx.verts, crApplyPendingVerticals() { ctx.verts = ctx.crPendingVerticals; },
    crLoad() { ctx.loads++; }, values, flagged,
    document: { getElementById: id => (id === 'cr-flagged-only' ? flagged
      : { get value() { return values[id] ?? ''; }, set value(v) { values[id] = v; }, classList: { contains: () => false } }) },
  }, ['function localDayRange(', 'function pgQuote(', 'function crSearchFilter(', 'function crOutcomeGroupMembers(', 'function crBuildFilters(', 'function applyCallsFilters('],
  ['crBuildFilters', 'applyCallsFilters']);
  // crBuildFilters checks Flagged only through the same element.
  ctx.flagged.classList.contains = c => ctx.flagged.classList.set.has(c);
  vm.runInNewContext('var CR_OUTCOME_GROUPS = ' + html.match(/const CR_OUTCOME_GROUPS = (\[[\s\S]*?\]);/)[1], ctx);
  ctx.applyCallsFilters(new URLSearchParams(params));
  return ctx;
}
const WEIGHTS = { sale: { pub_score: 10, adv_score: 8 }, misrouted: { pub_score: -3, adv_score: 0 }, outside_geo: { pub_score: 0, adv_score: -2 }, voicemail: { pub_score: 0, adv_score: -1 } };

test('S-34: the old deep link (?tab=calls&account&type&from&to&flagged=1&outcomeGroup&vertical) still lands filtered', () => {
  const p = linkPage('?tab=calls&account=Pub%20A&type=publisher&from=2026-11-05&to=2026-11-09&flagged=1&outcomeGroup=adv_neg&vertical=Roofing,Solar', WEIGHTS);
  assert.equal(p.values['cr-outcome-filter'], 'group:adv_neg', 'the group sits in the one Outcome select');
  assert.equal(p.flagged.classList.contains('active'), true);
  assert.equal(p.flagged.attrs['aria-pressed'], 'true');
  assert.equal(p.values['cr-pub-filter'], 'Pub A');
  assert.deepEqual([p.crDrpPickStart, p.crDrpPickEnd], ['2026-11-05', '2026-11-09']);
  assert.equal(p.loads, 1, 'one load with all of it applied');
  const q = new URLSearchParams(p.crBuildFilters().slice(1));
  assert.deepEqual(q.getAll('created_at'), ['gte.2026-11-05T07:00:00.000Z', 'lt.2026-11-10T07:00:00.000Z']);
  assert.equal(q.get('publisher_name'), 'ilike.*Pub A*');
  assert.equal(q.get('our_outcome'), 'in.(outside_geo,voicemail)', 'negative advertiser outcomes, from the weights');
  assert.equal(q.get('flags'), 'neq.[]');
  assert.equal(q.get('vertical_name'), 'in.("Roofing","Solar")');
  // An unknown group key in a link is ignored, as before.
  assert.equal(linkPage('?tab=calls&outcomeGroup=nope&from=2026-11-05&to=2026-11-09').values['cr-outcome-filter'], '');
});

test('S-34: one Outcome select: a single outcome, a group, and an empty group that matches nothing', () => {
  const p = linkPage('?tab=calls&from=2026-11-05&to=2026-11-09', WEIGHTS);
  p.values['cr-outcome-filter'] = 'sale';
  assert.equal(new URLSearchParams(p.crBuildFilters().slice(1)).get('our_outcome'), 'eq.sale');
  p.values['cr-outcome-filter'] = 'group:pub_pos';
  assert.equal(new URLSearchParams(p.crBuildFilters().slice(1)).get('our_outcome'), 'in.(sale)');
  p.scoresWeights = null;   // weights not loaded: a group must not silently drop the filter
  assert.equal(new URLSearchParams(p.crBuildFilters().slice(1)).get('our_outcome'), 'eq.__no_match__');
  p.values['cr-outcome-filter'] = '';
  assert.equal(new URLSearchParams(p.crBuildFilters().slice(1)).get('our_outcome'), null);

  // The select: "All outcomes", then an Outcome groups and an Outcomes optgroup, filled at load.
  assert.match(html, /<select[^>]*id="cr-outcome-filter"[^>]*>\s*<option value="">All outcomes<\/option>\s*<optgroup label="Outcome groups" id="cr-outcome-groups"><\/optgroup>\s*<optgroup label="Outcomes" id="cr-outcome-list"><\/optgroup>\s*<\/select>/);
  const groups = { kids: [], appendChild(o) { this.kids.push(o); } }, list = { kids: [], appendChild(o) { this.kids.push(o); } };
  const ctx = { document: { getElementById: id => ({ 'cr-outcome-groups': groups, 'cr-outcome-list': list })[id], createElement: () => ({}) }, labelOf: v => v.replace(/_/g, ' ') };
  vm.runInNewContext('var CR_OUTCOME_GROUPS = ' + html.match(/const CR_OUTCOME_GROUPS = (\[[\s\S]*?\]);/)[1] + ';\n'
    + html.match(/\(\(\) => \{ const s = document\.getElementById\('cr-outcome-groups'\);[^\n]*/)[0] + '\n'
    + 'var REVIEW_OUTCOMES = ' + html.match(/const REVIEW_OUTCOMES = (\[[^\]]*\]);/)[1] + ';\n'
    + html.match(/\(\(\) => \{ const s = document\.getElementById\('cr-outcome-list'\);[^\n]*/)[0], ctx);
  assert.deepEqual(groups.kids.map(o => o.value), ['group:adv_pos', 'group:adv_neu', 'group:adv_neg', 'group:pub_pos', 'group:pub_neu', 'group:pub_neg']);
  assert.equal(groups.kids[2].textContent, 'Negative advertiser outcomes');
  assert.equal(list.kids[0].value, 'sale');
  assert.ok(list.kids.every(o => !o.value.startsWith('group:')));
});

// ── S-33 / S-36: Calls strip, columns and footer ────────────────────────────
test('S-33: strip labels, and "flagged" is coral only when calls are flagged', async () => {
  assert.match(html, /<div class="summary-lbl">AI-scored calls<\/div>/);
  assert.match(html, /<div class="summary-val" id="calls-stat-flagged">/, 'no static coral');
  assert.doesNotMatch(html, /processed by AI|revenue · all table rows/);
  const els = {};
  const el = id => (els[id] ??= { textContent: '', style: { display: 'none' }, innerHTML: '', classList: classes() });
  const run = async rows => {
    const ctx = load({ sbFetch: async url => (url.includes('select=flags') ? rows : [{ n: 5, revenue: 0 }]), crLoadSeq: 1, crOffset: 5, crTotal: null, crHasMore: false,
      crRender() {}, callsFlagCounts: null, crDrpPickStart: 'a', crDrpPickEnd: 'b', console: { warn() {} }, CALLS_FLAG_TYPES: ['geo_mismatch'],
      crApplied: { table: '', strip: '' }, document: { getElementById: el } },
    ['function nullMark(', 'function labelOf(', 'async function callsLoadSummary(', 'function callsStripTotals(', 'function callsHighLine(', 'function callsFlagBreakdownRender('], ['callsLoadSummary']);
    await ctx.callsLoadSummary(1);
  };
  await run([{ flags: [], n: 5 }]);
  assert.equal(els['calls-stat-flagged'].textContent, '0');
  assert.equal(els['calls-stat-flagged'].classList.contains('neg'), false, '0 is not coral');
  await run([{ flags: ['geo_mismatch'], n: 2 }, { flags: [], n: 3 }]);
  assert.equal(els['calls-stat-flagged'].classList.contains('neg'), true);
  await run([]);
  assert.equal(els['calls-stat-flagged'].classList.contains('neg'), false, 'reset for the next scope');
});

test('S-36: Outcome and Canoe are separate columns; footer counts once the total is in', () => {
  const store = {};
  const src = html.slice(html.indexOf('const CR_COLUMNS = ['), html.indexOf('function crColPickerToggle('));
  const out = { innerHTML: '' };
  const ctx = { localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, console,
    POSITIVE_OUTCOMES: new Set(['sale']), NEGATIVE_OUTCOMES: new Set(), AGENTS: [], aliasesForAgent: () => [], vClass: () => '',
    crSortCol: 'created_at', crSortDir: -1, crHasMore: true, crTotal: null, document: { getElementById: () => out } };
  store.cr_visible_cols = JSON.stringify({ outcome: true, publisher_score: false });   // saved before the split
  vm.runInNewContext(src.replace(/^const |\nlet /g, m => m.replace(/const |let /, 'var ')) + ';\n' + severityBlock() + ';\n' + ['function esc(', 'function nullMark(', 'function labelOf(', 'function httpUrl(',
    'function crFmtDuration(', 'function crFmtDateTime(', 'function crFmtRev(', 'function crDispoClass(', 'function outcomeBadge(', 'function flagBadges(', 'function crRender('].map(lift).join(';\n'), ctx);
  assert.equal(ctx.crVisibleCols.outcome, true, 'the column picker key still works');
  assert.equal(ctx.crVisibleCols.canoe_outcome, true, 'the new column starts on');
  assert.equal(ctx.crVisibleCols.publisher_score, false, 'other saved choices are kept');
  ctx.crRows = [{ id: 'c1', created_at: '2026-11-10T16:00:00Z', our_outcome: 'sale', canoe_outcome: 'quoted_interested' }, { id: 'c2', created_at: '2026-11-10T17:00:00Z' }];
  vm.runInNewContext('crRender()', ctx);
  assert.match(out.innerHTML, /<th>Outcome<\/th><th>Canoe<\/th>/);
  assert.doesNotMatch(out.innerHTML, /Registry:|Canoe:|Registry · Canoe/);
  assert.match(out.innerHTML, /<td><span class="outcome-badge outcome-positive">sale<\/span><\/td><td [^>]*>quoted interested<\/td>/);
  assert.match(out.innerHTML, /<td><span class="null-mark">-<\/span><\/td><td [^>]*><span class="null-mark">-<\/span><\/td>/, 'unscored: a mark in each');
  assert.match(out.innerHTML, /<span>Showing 2 rows<\/span>/, 'not "of counting… rows"');
  ctx.crTotal = 1240;
  vm.runInNewContext('crRender()', ctx);
  assert.match(out.innerHTML, /<span>Showing 2 of 1,240<\/span>/);
  // CSV export keeps both outcome columns.
  assert.match(lift('async function crExportAll('), /'our_outcome','canoe_outcome'/);
});

// ── S-46: toggles are buttons with aria-pressed and .on ─────────────────────
test('S-46: "AI was wrong" flips .on and aria-pressed, and saves only the disagree column', async () => {
  const sent = [];
  const ctx = load({ RV: { agent: { ivrName: 'IVR' }, disagreeBy: {} }, getAuthUser: () => 'me@example.com', alert: m => { throw new Error(m); },
    sbFetch: async (url, o) => { sent.push(JSON.parse(o.body)); return null; } }, ['async function rvToggleDisagree('], ['rvToggleDisagree']);
  const el = { classList: classes(), attrs: {}, textContent: 'AI was wrong', setAttribute(k, v) { this.attrs[k] = v; } };
  await ctx.rvToggleDisagree('c1', el);
  assert.equal(el.classList.contains('on'), true);
  assert.equal(el.attrs['aria-pressed'], 'true');
  assert.equal(el.textContent, 'AI was wrong', 'the label stays; the pressed state shows it');
  assert.equal(sent[0].eval_disagree, true);
  assert.ok(!('reviewed' in sent[0]) && !('note' in sent[0]), 'a reviewed mark or note on the row is kept');
  await ctx.rvToggleDisagree('c1', el);
  assert.equal(el.classList.contains('on'), false);
  assert.equal(el.attrs['aria-pressed'], 'false');
  assert.equal(sent[1].eval_disagree, false);
});

test('S-46: Mark reviewed / Reviewed / Reviewed by Name, no checkbox glyphs anywhere', () => {
  const ctx = load({ RV: { reviewers: { mine: ['me@example.com'], theirs: ['pat.lee@example.com'] } }, getAuthUser: () => 'me@example.com' },
    ['function personName(', 'function rvCheckState('], ['rvCheckState', 'personName']);
  assert.deepEqual({ ...ctx.rvCheckState('none') }, { on: false, locked: false, label: 'Mark reviewed', title: '' });
  assert.equal(ctx.rvCheckState('mine').label, 'Reviewed');
  assert.equal(ctx.rvCheckState('theirs').label, 'Reviewed by Pat Lee');
  assert.equal(ctx.rvCheckState('theirs').locked, true);
  assert.equal(ctx.personName('pier@buyerlink.com'), 'Pier');
  assert.doesNotMatch(html, /☐|☑|AI got this wrong/);
});

// ── S-40 / S-37: Review call row ────────────────────────────────────────────
function rowCtx(aeParts) {
  return load({ RV: { reviewers: {}, notesByCall: { c1: { note: 'Asked twice for price.', by: 'pier@buyerlink.com', at: '2026-11-03T18:00:00Z' } }, disagreeBy: {} },
    POSITIVE_OUTCOMES: new Set(['sale']), NEGATIVE_OUTCOMES: new Set(), getAuthUser: () => 'me@example.com',
    aeRowParts: () => aeParts, aeDetailHtml: () => '<div class="rv-ae-detail" id="rv-ae-0">ASSESSMENT</div>', aeMarkQuotes: t => t },
  ['function esc(', 'function nullMark(', 'function labelOf(', 'function jsStr(', 'function httpUrl(', 'function fmtDateTime(', 'function personName(', 'function crFmtDuration(',
    'function outcomeBadge(', 'function flagBadges(', 'function rvCheckState(', 'function reviewCallRow('], ['reviewCallRow']);
}
const CALL = { id: 'c1', created_at: '2026-11-10T16:00:00Z', publisher_name: 'Pub A', advertiser_name: 'Buyer X', ivr_duration: 61, our_outcome: 'sale',
  disposition: 'Transferred', disposition_description: 'Caller wants a quote', our_summary: 'Booked an install.', flags: ['geo_mismatch', 'angry_caller'], ascnd_transcript: 'bot: hi' };
const split = row => { const at = row.indexOf('<div class="rv-x"'); return [row.slice(0, at), row.slice(at)]; };
const chipCount = s => (s.match(/class="(rv-chip|outcome-badge|flag-badge)[ "]/g) || []).length;

test('S-40: an unscored row: outcome + one flag, the buyer-call summary; the rest is in Details', () => {
  const [row, panel] = split(rowCtx(null).reviewCallRow(CALL, 0));
  assert.equal(chipCount(row), 2);
  assert.match(row, /title="Registry outcome"><span class="outcome-badge outcome-positive">sale/);
  assert.match(row, /flag-angry_caller/, 'the most severe flag (medium) is the one shown');
  assert.doesNotMatch(row, /geo mismatch|Transferred|Caller wants a quote|1m 01s/);
  assert.match(row, /<div class="rv-call-sum">Booked an install\.<\/div>/);
  assert.match(panel, /^<div class="rv-x" id="rv-x-0" style="display:none">/);
  assert.match(panel, /1m 01s[\s\S]*Transferred[\s\S]*geo mismatch/);
  assert.match(panel, /"Caller wants a quote"/);
  assert.doesNotMatch(panel, /Buyer call/, 'one summary only, already on the row');
  assert.match(panel, /ASSESSMENT[\s\S]*id="rv-tx-0">bot: hi/);
  assert.match(row, /<button type="button" class="rv-btn" aria-expanded="false" aria-controls="rv-x-0" onclick="rvToggleDetails\(0,this\)">Details<\/button>/);
});

test('S-40 + S-37: a scored row: verdict + finding, the agent-review summary; the buyer-call summary moves to Details; note line', () => {
  const ae = { chips: '<span class="rv-chip neg rv-ae-verdict">Major issue</span><span class="rv-chip neg">Over-rejected</span>', summary: 'Rejected a caller from TV.' };
  const [row, panel] = split(rowCtx(ae).reviewCallRow(CALL, 0));
  assert.equal(chipCount(row), 2);
  assert.match(row, /Major issue[\s\S]*Over-rejected/);
  assert.doesNotMatch(row, /outcome-badge|flag-badge/);
  assert.match(row, /<div class="rv-call-sum">Rejected a caller from TV\.<\/div>/);
  assert.doesNotMatch(row, /Booked an install/);
  assert.match(panel, /outcome-badge outcome-positive">sale[\s\S]*angry caller[\s\S]*geo mismatch/, 'outcome and every flag in Details, most severe first');
  assert.match(panel, /<span class="rv-x-lbl">Buyer call<\/span> Booked an install\./);
  assert.match(text(row), /Asked twice for price\. Note by Pier · Nov 3/);
  assert.doesNotMatch(row + panel, /AI summary|AI agent review|📝/);
});

test('S-40: Details opens and closes the panel and says so', () => {
  const panel = { style: { display: 'none' } }, btn = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const ctx = load({ document: { getElementById: id => (id === 'rv-x-3' ? panel : null) } }, ['function rvToggleDetails('], ['rvToggleDetails']);
  ctx.rvToggleDetails(3, btn);
  assert.equal(panel.style.display, '');
  assert.equal(btn.attrs['aria-expanded'], 'true');
  ctx.rvToggleDetails(3, btn);
  assert.equal(panel.style.display, 'none');
  assert.equal(btn.attrs['aria-expanded'], 'false');
});

// ── S-48: one load-error helper ─────────────────────────────────────────────
test('S-48: a failed load shows "Couldn\'t load <thing>." + Retry; the raw error only reaches the console', () => {
  const warned = [];
  const ctx = load({ console: { warn: (...a) => warned.push(a.join(' ')) } }, ['function esc(', 'function loadErrorHtml('], ['loadErrorHtml']);
  const out = ctx.loadErrorHtml('scores', 'scoresLoad()', new Error('Supabase 401: {"message":"JWT expired"}'));
  assert.equal(out, '<div class="load-error" role="alert"><span>Couldn\'t load scores.</span><button type="button" class="rv-btn" onclick="scoresLoad()">Retry</button></div>');
  assert.match(warned[0], /Couldn't load scores: Supabase 401/);
  assert.equal(ctx.loadErrorHtml('<b>x</b>', ''), '<div class="load-error" role="alert"><span>Couldn\'t load &lt;b&gt;x&lt;/b&gt;.</span></div>');
  assert.equal(warned.length, 1, 'no error passed, nothing logged');
  // Every loader that rendered "Could not load …: Supabase …" / "Error: …" uses it now.
  for (const [fn, call] of [['async function scoresLoad(', "'scoresLoad()'"], ['function runInsights(', "'runInsights()'"], ['async function crLoad(', "'crLoad(false)'"],
    ['async function loadReviewCalls(', "'loadReviewCalls(true)'"], ['async function settingsLoadManagers(', "'settingsLoadManagers()'"],
    ['async function settingsLoadAccountsTable(', "'settingsLoadAccountsTable()'"], ['async function settingsLoadUsers(', "'settingsLoadUsers()'"],
    ['function weightsRender(', "'weightsInit()'"], ['async function modeltestLoadHistory(', "'modeltestLoadHistory()'"],
    ['async function modeltestViewResults(', '`modeltestViewResults('], ['async function reviewOpen(', '`reviewOpen('], ['async function promptsLoad(', "'promptsLoad()'"]])
    assert.ok(lift(fn).includes('loadErrorHtml(') && lift(fn).includes(call), fn);
  assert.doesNotMatch(html, /innerHTML\s*=[^;\n]*e\.message/, 'no raw error is written into the page');

  // Agents: a failed list load shows the error + Retry in the grid (it used to be overwritten by "No agents match.").
  const grid = { innerHTML: '' };
  const a = load({ AGENTS: [], agentsLoadFailed: true, activeFilter: 'all', openAgent: null, getSorted: x => x, aliasesForAgent: () => [], placeAgentDrawer() {}, placeOpenAgentDrawer() {}, isInactive: () => false, byLastCall: () => 0,
    document: { getElementById: id => ({ 'search-input': { value: '' }, 'agents-grid': grid, 'drawer-container': { innerHTML: '' } })[id] } },
  ['function esc(', 'function loadErrorHtml(', 'function applyFilters('], ['applyFilters']);
  a.applyFilters();
  assert.match(grid.innerHTML, /Couldn't load agents\.<\/span><button type="button" class="rv-btn" onclick="retryAgentsLoad\(\)">Retry/);
  a.agentsLoadFailed = false;
  a.applyFilters();
  assert.match(grid.innerHTML, /No agents match\./);
});

// ── S-47: Scores window label ───────────────────────────────────────────────
test('S-47: the second window button names the Agents range it uses, and follows it', () => {
  const btn = { textContent: 'Agents range' };
  const ctx = load({ activeRange: { start: new Date(2026, 9, 13), end: new Date(2026, 10, 11) }, document: { querySelector: () => btn } },
    ['function toISO(', 'function fmtShortD(', 'function scoresWindowLabel('], ['scoresWindowLabel']);
  ctx.scoresWindowLabel();
  assert.equal(btn.textContent, 'Agents range (Oct 13 – Nov 11)');
  ctx.activeRange = {};
  ctx.scoresWindowLabel();
  assert.equal(btn.textContent, 'Agents range');
  for (const fn of ['function setPreset(', 'function agentDrpApply(']) assert.match(lift(fn), /scoresWindowLabel\(\);refreshMetrics\(\)/, fn);
  assert.doesNotMatch(html, /scores-window-note|Selected window|Master · /);
});

// ── Copy (S-37, S-38, S-41 to S-45, S-49 to S-52) and dead code (S-54) ──────
test('Pass 3 copy: drawer, Review, Scores and Settings wording', () => {
  const has = [
    '>Correct this call<', 'Call ${esc(call.id', '<span class="drawer-src">Registry</span>',                                  // S-37
    'No calls with both a Canoe and a Registry outcome in this window.', 'Under ${SCORES_MIN_CALLS} scored calls, so the score is hidden.', // S-41, S-42
    '<span class="t">Calls</span>', '<span class="rv-ae-lbl">Agent quality</span>',                                               // S-42
    '<span class="t">Change log</span>', 'placeholder="What changed and why"', 'No changes logged.',                              // S-43
    'Calls since <input type="date" id="rv-window-date"',                                                                       // S-44
    '<label class="rv-q-label" for="rv-top-change">Top fix</label>', 'Details <span class="rv-q-hint">(optional)</span>',         // S-45
    "'Save (call count unavailable)'", 'Save and rescore ${', 'Save (counting calls…)', "'Save (weights did not load)'",           // S-49
    'Scores a sample with each selected model. Production calls are not touched.', '` Unprocessed: ${',                           // S-50
    'None selected = no flags.', '<div class="train-h" style="margin:20px 0 8px">Outcomes', '>Correct outcome</label>',           // S-51
    '>Label calls</button>', '>Compare models</button>', '>Label one by one</button>', 'id="review-title">Label calls<',          // S-52
  ];
  for (const s of has) assert.ok(html.includes(s), s);
  const gone = [
    'our AI', 'Recording: ${', 'Make a correction', 'Click a row to review its calls', 'rv-board-open', 'not scored yet', 'AI calls · ASCND transcript',
    'Notes · what changed and why', 'Reviewing calls since', '${i+1} · ', 'The #1 change', 'Execute changes', 'click Execute', 'all from the same batch',
    'Your unprocessed queue', 'Leave all off', 'Review one-by-one', 'Compare grid<', 'font-family:var(--serif);font-size:22px', 'font-family:var(--serif);font-size:19px',
  ];
  for (const s of gone) assert.ok(!html.includes(s), s);
  assert.doesNotMatch(html, /<td class="rv-board-open">|<th>Last reviewed<\/th><th><\/th>/, 'no Review column on the board');
});

test('S-54: the dead upload/intake code is gone; the new-IVR form keeps its field styles', () => {
  for (const fn of ['checkForUnregisteredAgents', 'buildIntakeCard', 'showIntakeFullForm', 'saveIntakeAlias', 'saveNewAgent', 'handleFile',
    'setupFileUpload', 'parseCSV', 'enrichUploadedCalls', 'buildBQSQL', 'copySQL', 'toggleUpdatePanel', 'saveAlias'])
    assert.doesNotMatch(html, new RegExp(`\\b${fn}\\b`), fn);
  for (const cls of ['update-panel', 'update-link', 'file-drop', 'new-agent-intake', 'intake-alias', 'intake-rename-box', 'intake-full-form', 'intake-save-btn'])
    assert.doesNotMatch(html, new RegExp(`\\.${cls}\\b`), cls);
  for (const cls of ['intake-field', 'intake-label', 'intake-input', 'intake-select', 'intake-textarea']) {
    assert.match(html, new RegExp(`\\.${cls}[ ,{]`), `${cls} CSS kept`);
    assert.match(lift('function renderIvrSetupForm('), new RegExp(cls), `${cls} still used by the setup form`);
  }
});
