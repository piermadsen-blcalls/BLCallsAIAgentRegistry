// Inactive agents (no calls in 30 days) and the rebuilt Settings > Team view (migration 057).
// index.html has no build step, so the code is lifted out of the page and run with stubs.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// Source of a top-level `function name(` declaration, by brace matching from the body's opening brace.
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
const unhtml = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const ACTIVITY = ['function needsSetup(', 'function getEffectiveStatus(', 'function agentLastDay(', 'function isInactive(', 'function lastCallLabel(',
  'function byLastCall(', 'function esc(', 'function fmtDate(', 'function jsStr('];
function ctxWith(extra, decls, names, aliasMap = {}) {
  const ctx = { console, URLSearchParams, aliasMap, resolveIvrName: n => aliasMap[n] || n, ...extra };
  vm.runInNewContext(
    `var agentLastCall = null;\n` + [...ACTIVITY, ...decls].map(lift).join(';\n') + ';\n' +
    [...names, 'getEffectiveStatus', 'isInactive', 'byLastCall', 'lastCallLabel'].map(n => `this.${n} = ${n};`).join(' ') +
    ` this.setLastCall = m => { agentLastCall = m; };`, ctx);
  return ctx;
}

test('loadAgentActivity: aliases fold into the canonical agent, newest day wins', async () => {
  const aliasMap = { 'Old Plumber IVR': 'Plumber IVR' };
  const ctx = ctxWith({ sbFetch: async () => [
    { ivr_name: 'Plumber IVR', last_day: '2026-09-11' },
    { ivr_name: 'Old Plumber IVR', last_day: '2026-11-01' },
    { ivr_name: 'Painter IVR', last_day: '2026-09-08' },
  ] }, ['async function loadAgentActivity('], ['loadAgentActivity'], aliasMap);
  await ctx.loadAgentActivity();
  const m = vm.runInContext('agentLastCall', ctx);
  assert.equal(m['Plumber IVR'], '2026-11-01');
  assert.equal(m['Painter IVR'], '2026-09-08');
  assert.equal(m['Old Plumber IVR'], undefined);
});

test('loadAgentActivity failure leaves activity unknown: nothing is marked inactive', async () => {
  const ctx = ctxWith({ sbFetch: async () => { throw new Error('boom'); }, console: { warn() {} } },
    ['async function loadAgentActivity('], ['loadAgentActivity']);
  await ctx.loadAgentActivity();
  assert.equal(vm.runInContext('agentLastCall', ctx), null);
  assert.equal(ctx.isInactive({ ivrName: 'X', status: 'live', raw_calls: 0 }), false);
  // ...and the badge falls back to the old "calls in the selected range" rule.
  assert.equal(ctx.getEffectiveStatus({ ivrName: 'X', status: 'live', raw_calls: 0 }), 'inactive');
  assert.equal(ctx.getEffectiveStatus({ ivrName: 'X', status: 'live', raw_calls: 3 }), 'live');
});

test('isInactive: 30-day cutoff, never-called, test agents, and resolved aliases', () => {
  const ctx = ctxWith({}, [], [], { 'Alias IVR': 'Canon IVR' });
  ctx.setLastCall({ Recent: daysAgo(29), Edge: daysAgo(30), Old: daysAgo(31), 'Canon IVR': daysAgo(2) });
  const a = (ivrName, status = 'live') => ({ ivrName, status, name: ivrName, raw_calls: 0 });
  assert.equal(ctx.isInactive(a('Recent')), false);
  assert.equal(ctx.isInactive(a('Edge')), false, 'a call exactly 30 days ago still counts');
  assert.equal(ctx.isInactive(a('Old')), true);
  assert.equal(ctx.isInactive(a('Never')), true, 'no calls on record');
  assert.equal(ctx.isInactive(a('Old', 'test')), false, 'test agents keep their own status');
  assert.equal(ctx.isInactive(a('Alias IVR')), false, 'an agent registered under an alias uses the canonical history');
  // A live agent with no calls in a short selected range is still Live if it had calls in 30 days.
  assert.equal(ctx.getEffectiveStatus(a('Recent')), 'live');
  assert.equal(ctx.getEffectiveStatus(a('Old')), 'inactive');
  assert.match(ctx.lastCallLabel(a('Never')), /No calls on record/);
  assert.match(ctx.lastCallLabel(a('Old')), /^Last call /);
  // Inactive list order: most recent last call first, never-called last.
  const sorted = [a('Never'), a('Old'), a('Edge')].sort(ctx.byLastCall).map(x => x.ivrName);
  assert.deepEqual(sorted, ['Edge', 'Old', 'Never']);
});

test('Review board: inactive agents leave the table and the Needs review count', () => {
  let rootHtml = '';
  const reviewBoard = { managers: [], lastReview: { Active: new Date().toISOString() }, counts: {}, issues: {}, filter: 'all', myId: null,
    acctAssign: [], links: {}, draft: { side: 'advertiser', mgr: '', accts: [] }, applied: { side: 'advertiser', mgr: '', accts: [] },
    scopeInit: true, acctSearch: '' };
  const AGENTS = [
    { ivrName: 'Active', name: 'Active agent', status: 'live', vertical: 'Home Services' },
    { ivrName: 'Due', name: 'Due agent', status: 'live', vertical: 'Home Services' },
    { ivrName: 'Gone', name: 'Gone agent', status: 'live', vertical: 'Legal' },
    { ivrName: 'Never', name: 'Never agent', status: 'live', vertical: 'Legal' },
    { ivrName: 'T', name: 'Test agent', status: 'test', vertical: 'Other' },
  ];
  const ctx = ctxWith({
    AGENTS, reviewBoard,
    document: { getElementById: id => id === 'review-root' ? { set innerHTML(v) { rootHtml = v; } } : null },
    rvSideOf: (key, side) => (reviewBoard.links[key] || {})[side] || {},
  }, ['function renderReviewBoard(', 'function reviewBoardStatus(', 'function rvScopeSet(', 'function rvAcctLabel(', 'function rvInactiveSection('],
  ['renderReviewBoard']);
  ctx.setLastCall({ Active: daysAgo(1), Due: daysAgo(3), Gone: daysAgo(40) });
  ctx.renderReviewBoard();
  const out = unhtml(rootHtml);
  assert.match(out, /All <span style="opacity:.65">2<\/span>/, 'All counts active non-test agents only');
  assert.match(out, /Needs review <span style="opacity:.65">1<\/span>/, 'Due counts; Gone/Never do not');
  const [table, inactive] = out.split('<details class="inactive-section"');
  assert.ok(inactive, 'collapsed Inactive section is rendered');
  assert.doesNotMatch(table, /Gone agent|Never agent|Test agent/);
  assert.match(inactive, /Inactive \(no calls in 30 days\)<\/span><span class="inactive-count">2</);
  assert.ok(inactive.indexOf('Gone agent') < inactive.indexOf('Never agent'), 'most recent last call first');
  assert.match(inactive, /Never<\/span>/, 'never-called agent says Never');
  assert.match(inactive, /openReview\('Gone'\)/, 'inactive agents stay reviewable');
  assert.doesNotMatch(inactive, / open /, 'collapsed by default');

  // The next call moves an agent back automatically.
  ctx.setLastCall({ Active: daysAgo(1), Due: daysAgo(3), Gone: daysAgo(0) });
  ctx.renderReviewBoard();
  const after = unhtml(rootHtml);
  assert.match(after, /Needs review <span style="opacity:.65">2<\/span>/);
  assert.match(after.split('<details')[0], /Gone agent/);
});

test('Team: per-manager accounts, flagged calls, digest state, and Calls links', () => {
  const ctx = ctxWith({}, ['function renderTeam('], ['renderTeam']);
  const managers = [
    { id: 'm1', manager_name: 'Alex', manager_email: 'alex@example.com' },
    { id: 'm2', manager_name: 'Blair', manager_email: null },
    { id: 'm3', manager_name: 'Casey', manager_email: 'casey@example.com' },
  ];
  const assignments = [
    { manager_id: 'm1', account_name: 'Acme Adv', account_type: 'advertiser' },
    { manager_id: 'm1', account_name: 'Pub (One)', account_type: 'publisher' },
    { manager_id: 'm2', account_name: 'Quiet Pub', account_type: 'publisher' },
  ];
  const html_ = ctx.renderTeam(managers, assignments,
    { 'advertiser|Acme Adv': 4, 'publisher|Pub (One)': 2 }, { m1: 5 },
    { m1: { enabled: true, last_sent_at: '2026-11-10T12:00:00Z' }, m2: { enabled: false } }, '2026-11-05', '2026-11-12');
  const cards = html_.split('class="comp-team-card"').slice(1);
  assert.equal(cards.length, 3, 'one card per manager');
  assert.match(cards[0], /Alex/, 'most flagged manager first');
  assert.match(cards[0], />5<\/div>\s*<div class="comp-team-stat-label">flagged calls · 7 days/, 'manager total is the distinct count from the RPC');
  assert.match(cards[0], /accounts · 1 adv, 1 pub/);
  assert.match(cards[0], /Digest on/);
  assert.ok(cards[0].indexOf('Acme Adv') < cards[0].indexOf('Pub (One)'), 'accounts sorted by flagged calls');
  const href = unhtml(cards[0].match(/href="([^"]+)"/)[1]);
  const q = new URLSearchParams(href.slice(1));
  assert.deepEqual([q.get('tab'), q.get('account'), q.get('type'), q.get('from'), q.get('to'), q.get('flagged')],
    ['calls', 'Acme Adv', 'advertiser', '2026-11-05', '2026-11-12', '1']);
  assert.match(cards[1], /Blair/); assert.match(cards[1], /Digest off/);
  assert.match(cards[1], /<span class="comp-team-acct-flags">0<\/span>/, 'zero is not a link');
  assert.match(cards[2], /Casey/); assert.match(cards[2], /Digest off/, 'no settings row = off');
  assert.match(cards[2], /No accounts assigned/);
  assert.match(cards[2], /teamGoAssignments\(\)/);
  assert.doesNotMatch(html_, /Unassigned|total calls|pending review/, 'old sample-based stats are gone');
});

test('Team: long account lists collapse; empty assignments point admins to Admin > Assignments', () => {
  const ctx = ctxWith({}, ['function renderTeam('], ['renderTeam']);
  const many = Array.from({ length: 9 }, (_, i) => ({ manager_id: 'm1', account_name: 'Acct ' + i, account_type: 'publisher' }));
  const out = ctx.renderTeam([{ id: 'm1', manager_name: 'Alex' }], many, {}, {}, {}, '2026-11-05', '2026-11-12');
  assert.match(out, /<summary>Show 3 more<\/summary>/);
  const empty = unhtml(ctx.renderTeam([{ id: 'm1', manager_name: 'Alex' }], [], {}, {}, {}, 'a', 'b'));
  assert.match(empty, /No accounts are assigned to managers yet/);
  assert.match(empty, /Admin > Assignments/);
});

test('Team view no longer samples canoe_calls', () => {
  assert.doesNotMatch(html, /canoe_calls\?select=account_manager,flags,our_outcome,compliance_reviewed/);
  assert.match(lift('async function compLoadTeam('), /rpc\/team_overview/);
});
