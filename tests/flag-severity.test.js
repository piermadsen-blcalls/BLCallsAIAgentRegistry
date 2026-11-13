// Compliance flag severity, the captain's Option A (2026-11-13): High = outbound_dial,
// facebook_marketplace, coached_call, suspicious_call; Medium = duplicate_caller, wrong_business,
// angry_caller; Info = geo_mismatch, quoted_abandoned. It drives badge color, the Calls "High
// severity only" toggle, the strip's high-severity count, the click/tap breakdown, and digest order.
// index.html has no build step, so the code is lifted out of the page and run with stubs.
// Run: node --test tests/
process.env.TZ = 'America/Denver';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
function severityBlock() {
  const s = html.indexOf('const FLAG_SEVERITY = {'), e = html.indexOf('\n', html.indexOf('function callFlags(', s));
  return html.slice(s, e);
}
function load(ctx, decls, names) {
  vm.runInNewContext(severityBlock() + ';\n' + decls.map(lift).join(';\n') + ';\n' + names.map(n => `this.${n} = ${n};`).join(' '), ctx);
  return ctx;
}
const plain = v => JSON.parse(JSON.stringify(v));   // copy out of the vm realm

test('tiers match Option A, and the page and the digest use the same map', () => {
  const ctx = load({}, ['function esc('], ['flagSeverity', 'HIGH_FLAGS', 'FLAG_SEVERITY']);
  const tiers = { high: ['outbound_dial', 'facebook_marketplace', 'coached_call', 'suspicious_call'],
    medium: ['duplicate_caller', 'wrong_business', 'angry_caller'], info: ['geo_mismatch', 'quoted_abandoned'] };
  for (const [sev, flags] of Object.entries(tiers)) for (const f of flags) assert.equal(ctx.flagSeverity(f), sev, f);
  assert.equal(ctx.flagSeverity('incentivized_caller'), 'info', 'an unknown or retired flag counts as info');
  assert.deepEqual(plain(ctx.HIGH_FLAGS), tiers.high);
  const alertSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'alert.js'), 'utf8');
  const alertMap = vm.runInNewContext('(' + alertSrc.match(/const FLAG_SEVERITY = (\{[\s\S]*?\});/)[1] + ')');
  assert.deepEqual(plain(alertMap), plain(ctx.FLAG_SEVERITY), 'scripts/alert.js FLAG_SEVERITY matches index.html');
});

test('badges: colored by tier, most severe first; suspicious_call shows as a high badge', () => {
  const ctx = load({}, ['function esc(', 'function labelOf(', 'function flagBadges('], ['flagBadges', 'callFlags']);
  const out = ctx.flagBadges(['geo_mismatch', 'angry_caller', 'outbound_dial']);
  const order = [...out.matchAll(/class="flag-badge sev-(\w+) flag-(\w+)"/g)].map(m => `${m[1]}:${m[2]}`);
  assert.deepEqual(order, ['high:outbound_dial', 'medium:angry_caller', 'info:geo_mismatch']);
  assert.match(out, /title="High severity">outbound dial</);
  assert.deepEqual(plain(ctx.callFlags({ flags: ['geo_mismatch'], suspicious_call: true })), ['geo_mismatch', 'suspicious_call']);
  assert.deepEqual(plain(ctx.callFlags({ flags: null, suspicious_call: false })), []);
  assert.match(ctx.flagBadges(ctx.callFlags({ flags: [], suspicious_call: true })), /sev-high flag-suspicious_call" title="High severity">suspicious call/);
  assert.match(html, /\.flag-badge\.sev-high\s*\{ background:var\(--coral-bg\); color:var\(--coral\); \}/);
  assert.doesNotMatch(html, /\.flag-outbound_dial\s*\{/, 'per-flag colors are gone');
});

test('Calls: "High severity only" matches any high flag or suspicious_call, and combines with other filters', () => {
  const on = new Set(['cr-high-only']);
  const values = { 'cr-rec-filter': 'yes', 'cr-search': '' };
  const ctx = load({
    crDrpPickStart: '2026-11-02', crDrpPickEnd: '2026-11-08', crLinkScope: null, AGENTS: [], aliasesForAgent: () => [],
    crOutcomeGroupMembers: () => [], crSelectedVerticals: () => [], DASH_TZ: 'America/Denver', dashSel: { vertical: new Set(), publisher: new Set(), advertiser: new Set() },
    document: { getElementById: id => ({ value: values[id] ?? '', classList: { contains: c => c === 'active' && on.has(id) } }) },
  }, ['function dashAddDays(', 'function dashMtMidnight(', 'function dashMtRange(', 'function pgQuote(', 'function crSearchFilter(', 'function crBuildFilters('], ['crBuildFilters']);
  const q = decodeURIComponent(ctx.crBuildFilters());
  assert.match(q, /&and=\(or\(recording_url\.not\.is\.null,ascnd_recording_url\.not\.is\.null\),or\(flags\.cs\.\["outbound_dial"\],flags\.cs\.\["facebook_marketplace"\],flags\.cs\.\["coached_call"\],suspicious_call\.is\.true\)\)/);
  assert.doesNotMatch(decodeURIComponent(ctx.crBuildFilters(false)), /coached_call/, 'the strip scope ignores flag drill-downs, so its rates stay real ratios');
  on.clear();
  assert.doesNotMatch(decodeURIComponent(ctx.crBuildFilters()), /coached_call|suspicious_call/);
  assert.match(html, /<button class="pill" id="cr-high-only" aria-pressed="false" onclick="crToggleFlagged\(this\)"[^>]*>High severity only<\/button>/);
});

test('strip: the high-severity count includes suspicious calls; "flagged" is unchanged', () => {
  const ctx = load({ CALLS_FLAG_TYPES: ['outbound_dial', 'angry_caller', 'geo_mismatch', 'coached_call'] }, ['function callsStripTotals('], ['callsStripTotals']);
  const t = plain(ctx.callsStripTotals([
    { flags: [], suspicious_call: false, n: 50 },
    { flags: ['geo_mismatch'], suspicious_call: false, n: 30 },
    { flags: ['geo_mismatch', 'outbound_dial'], suspicious_call: false, n: 4 },
    { flags: ['coached_call'], suspicious_call: true, n: 2 },
    { flags: [], suspicious_call: true, n: 3 },
    { flags: null, n: 1 },
  ]));
  assert.equal(t.total, 90);
  assert.equal(t.flagged, 36, 'calls with an entry in flags, what Flagged only matches');
  assert.equal(t.high, 9, '4 outbound + 2 coached/suspicious + 3 suspicious-only');
  assert.equal(t.counts.suspicious_call, 5);
  assert.equal(t.counts.geo_mismatch, 34);
  const els = {};
  const page = load({ document: { getElementById: id => (els[id] ??= { textContent: '', classList: { on: false, toggle(c, v) { this.on = v; } } }) } }, ['function callsHighLine('], ['callsHighLine']);
  page.callsHighLine(9); assert.equal(els['calls-stat-high'].textContent, '9 high severity'); assert.equal(els['calls-stat-high'].classList.on, true);
  page.callsHighLine(0); assert.equal(els['calls-stat-high'].classList.on, false, 'not coral at 0');
  page.callsHighLine(null); assert.equal(els['calls-stat-high'].textContent, '', 'blank while loading or after a failure');
});

test('breakdown: opens on click/tap/keyboard (not hover), grouped High, Medium, Info; closes again', () => {
  const tip = { style: { display: 'none' }, innerHTML: '' }, card = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const ctx = load({
    crDrpPickStart: 'a', crDrpPickEnd: 'b',
    callsFlagCounts: { outbound_dial: 4, suspicious_call: 5, angry_caller: 2, geo_mismatch: 34, quoted_abandoned: 0 },
    document: { getElementById: id => ({ 'calls-flag-breakdown': tip, 'calls-flag-card': card })[id] },
  }, ['function nullMark(', 'function labelOf(', 'function callsFlagBreakdownToggle(', 'function callsFlagBreakdownRender(', 'function callsFlagBreakdownHide('],
  ['callsFlagBreakdownToggle', 'callsFlagBreakdownHide']);
  let stopped = 0;
  ctx.callsFlagBreakdownToggle({ stopPropagation() { stopped++; } });
  assert.equal(tip.style.display, 'block');
  assert.equal(card.attrs['aria-expanded'], 'true');
  assert.equal(stopped, 1, 'the opening click does not reach the close-on-click-elsewhere listener');
  const heads = [...tip.innerHTML.matchAll(/fb-head sev-(\w+)">(\w+)</g)].map(m => m[2]);
  assert.deepEqual(heads, ['High', 'Medium', 'Info']);
  assert.match(tip.innerHTML, /High<\/div><div class="fb-row"><span>suspicious call<\/span><span class="fb-n">5<\/span><\/div><div class="fb-row"><span>outbound dial<\/span><span class="fb-n">4</);
  ctx.callsFlagBreakdownToggle();
  assert.equal(tip.style.display, 'none');
  assert.equal(card.attrs['aria-expanded'], 'false');
  // Markup: a focusable button-like card, Enter/Space open it, no hover handlers left.
  assert.match(html, /id="calls-flag-card" role="button" tabindex="0" aria-expanded="false" aria-controls="calls-flag-breakdown"[^>]*onclick="callsFlagBreakdownToggle\(event\)"[^>]*onkeydown="if\(event\.key==='Enter'\|\|event\.key===' '\)/);
  assert.doesNotMatch(html, /onmouseenter="callsFlagBreakdown/);
  assert.match(html, /e\.key === 'Escape' && t && t\.style\.display !== 'none'/, 'Escape closes it');
});

test('Review: the one flag shown on a collapsed row is the most severe', () => {
  assert.match(lift('function reviewCallRow('), /const flags=bySeverity\(c\.flags\);/);
});

// ── Digest (scripts/alert.js) ───────────────────────────────────────────────
const { buildBaseline, tallyAccounts, rankAccounts } = require('../scripts/alert.js');
const call = (pub, flags, extra = {}) => ({ publisher_name: pub, vertical_name: 'V', ai_processed_at: '2026-11-10T00:00:00Z', flags, suspicious_call: false, ...extra });

test('digest: accounts with high-severity calls come first, then the higher flag rate; flags list high first', () => {
  const calls = [
    // Geo: many flags, all info, high rate (5/10).
    ...Array.from({ length: 5 }, () => call('Geo', ['geo_mismatch'])), ...Array.from({ length: 5 }, () => call('Geo', [])),
    // Dial: one outbound dial in 10 calls (low rate, but high severity).
    call('Dial', ['outbound_dial']), ...Array.from({ length: 9 }, () => call('Dial', [])),
    // Sus: one suspicious-only call and one wrong business in 4 calls.
    call('Sus', [], { suspicious_call: true }), call('Sus', ['wrong_business']), call('Sus', []), call('Sus', []),
    // Angry: medium only, rate 2/4.
    call('Angry', ['angry_caller']), call('Angry', ['angry_caller']), call('Angry', []), call('Angry', []),
  ];
  const pubs = new Set(['Geo', 'Dial', 'Sus', 'Angry']);
  // A big baseline so nobody is an outlier and only the new ordering decides.
  const base = buildBaseline([...calls, ...Array.from({ length: 2000 }, (_, i) => call('X' + i, i % 2 ? ['geo_mismatch', 'angry_caller', 'wrong_business'] : ['outbound_dial']))]);
  const ranked = rankAccounts(tallyAccounts(calls, new Set(), pubs, base));
  assert.ok(ranked.every(a => !a.outlier), 'no outliers in this setup');
  // Dial and Sus each have 1 high-severity call; Sus has the higher flag rate (2/4 vs 1/10).
  assert.deepEqual(ranked.map(a => a.name), ['Sus', 'Dial', 'Geo', 'Angry']);
  assert.equal(ranked.find(a => a.name === 'Sus').curr.highCalls, 1);
  assert.deepEqual(ranked.find(a => a.name === 'Sus').reasons.map(r => r.flag), ['suspicious_call', 'wrong_business'], 'high before medium');
});
