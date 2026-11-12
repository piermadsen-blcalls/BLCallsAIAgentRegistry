// Insights + Calls loading against the 8s statement timeout for signed-in users (57014).
// index.html has no build step, so the code is lifted out of the page and run against a
// fake PostgREST. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
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

// A month shaped like Sep 2026 in prod (~103k calls, ~3.4k/day), one call every 25s.
const DAY = 86400000, START = Date.parse('2026-09-01T00:00:00Z');
const ROWS = [];
for (let t = START; t < START + 30 * DAY; t += 25000) {
  ROWS.push({ id: 'c' + (ROWS.length * 7919 % 1000003), created_at: t, ivr_name: 'ASCND - Roofing',
    publisher_name: 'Pub', advertiser_name: 'Adv', connect_duration: 1, result: 'connected',
    advertiser_payin: 10, publisher_payout: 4, vertical_name: 'Home Services' });
}
// Rows one statement may walk (OFFSET re-reads every earlier row) before the timeout hits.
// Prod: offset ~44k pages timed out; one full day (~3.4k, busiest ~10k) is well inside.
const TIMEOUT_ROWS = 20000;

function fakePostgrest(log) {
  return async (url, opts) => {
    const q = new URLSearchParams(url.split('?')[1]);
    const [gte, lt] = q.getAll('created_at').map(v => Date.parse(v.slice(v.indexOf('.') + 1) + 'T00:00:00Z'));
    let rows = ROWS.filter(r => r.created_at >= gte && r.created_at < lt);
    if (q.get('order') === 'id.asc') rows = rows.sort((a, b) => (a.id < b.id ? -1 : 1));
    const [from, to] = opts.headers.Range.split('-').map(Number);
    log.push({ spanDays: (lt - gte) / DAY, from });
    if (to + 1 > TIMEOUT_ROWS) throw new Error('Supabase 500: {"code":"57014","message":"canceling statement due to statement timeout"}');
    return rows.slice(from, to + 1);
  };
}

function insightsContext(log) {
  const ctx = { sbFetch: fakePostgrest(log), insVerticalFilter: [] };
  const fns = ['function isSent(', 'function isPaid(', 'function insDayWindows(', 'async function insFetchPeriod('];
  vm.runInNewContext(fns.map(lift).join(';\n') + ';\nthis.insFetchPeriod = insFetchPeriod;', ctx);
  return ctx;
}

test('Insights: a month-long period loads every call without a timed-out page', async () => {
  const log = [];
  const { insFetchPeriod } = insightsContext(log);
  const { agents, pubs } = await insFetchPeriod('2026-09-01', '2026-09-30');
  assert.equal(agents['ASCND - Roofing'].raw, ROWS.length);
  assert.equal(pubs.Pub.paid, ROWS.length);
  assert.ok(log.every(r => r.spanDays === 1), 'each request covers one day');
  assert.ok(Math.max(...log.map(r => r.from)) < 4000, 'offsets stay within one day of rows');
});

test('Insights: end day is inclusive and a one-day period is one window', async () => {
  const log = [];
  const { insFetchPeriod } = insightsContext(log);
  const { agents } = await insFetchPeriod('2026-09-30', '2026-09-30');
  assert.equal(agents['ASCND - Roofing'].raw, ROWS.filter(r => r.created_at >= START + 29 * DAY).length);
});

test('Calls: "Has recording" filters on recording_id (recording_url is never populated)', () => {
  const values = { 'cr-rec-filter': 'yes', 'cr-pub-filter': '', 'cr-adv-filter': '' };
  const ctx = {
    crDrpPickStart: '2026-11-01', crDrpPickEnd: '2026-11-11',
    crOutcomeGroupMembers: () => [], crSelectedVerticals: () => [],
    document: { getElementById: id => ({ value: values[id] ?? '', classList: { contains: () => false } }) },
  };
  vm.runInNewContext(['function localDayRange(', 'function crBuildFilters('].map(lift).join(';\n') + ';\nthis.crBuildFilters = crBuildFilters;', ctx);
  assert.match(ctx.crBuildFilters(), /&recording_id=not\.is\.null/);
  values['cr-rec-filter'] = 'no';
  assert.match(ctx.crBuildFilters(), /&recording_id=is\.null/);
  assert.doesNotMatch(ctx.crBuildFilters(), /recording_url/);
});
