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

// Two months shaped like Sep/Oct 2026 in prod (~3.4k calls/day, one every 25s), spread over a
// few agents/publishers/advertisers/verticals, with the null names the page groups as '(unknown)'.
const DAY = 86400000, START = Date.parse('2026-09-01T00:00:00Z');
const isoDay = t => new Date(t).toISOString().slice(0, 10);
const ROWS = [];
for (let t = START; t < START + 61 * DAY; t += 25000) {
  const i = ROWS.length;
  ROWS.push({ id: 'c' + (i * 7919 % 1000003), created_at: t,
    ivr_name: ['ASCND - Roofing', 'ASCND - Solar', null][i % 3], publisher_name: ['Pub A', 'Pub B', 'Pub C', null][i % 4],
    advertiser_name: ['Adv X', 'Adv Y'][i % 2], vertical_name: ['Home Services', 'Solar', null][i % 5 % 3],
    connect_duration: i % 7 ? 30 : 0, result: i % 11 ? 'connected' : 'no answer',
    advertiser_payin: i % 3 ? 12.5 : 0, publisher_payout: i % 5 ? 4 : 0 });
}
const BY_DAY = {};
for (const r of ROWS) (BY_DAY[isoDay(r.created_at)] ||= []).push(r);
for (const d in BY_DAY) BY_DAY[d].sort((a, b) => (a.id < b.id ? -1 : 1));

const TIMEOUT = 'Supabase 500: {"code":"57014","details":null,"hint":null,"message":"canceling statement due to statement timeout"}';
const NO_RPC = 'Supabase 404: {"code":"PGRST202","details":"Searched for the function public.insights_period","hint":null,"message":"Could not find the function public.insights_period(from_day, to_day, verticals) in the schema cache"}';

// Fake PostgREST. rpc:false = migration 051 not applied yet. timeouts: how many times a request
// fails with 57014 before it succeeds, keyed 'rpc' or '<day>@<offset>' for a raw page.
function fakePostgrest(log, { rpc = true, timeouts = {} } = {}) {
  const timesOut = key => (timeouts[key] || 0) > 0 && timeouts[key]-- > 0;
  return async (url, opts) => {
    if (url === 'rpc/insights_period') {
      const { from_day, to_day, verticals } = JSON.parse(opts.body);
      log.push({ rpc: true, from_day, to_day, verticals });
      if (!rpc) throw new Error(NO_RPC);
      if (timesOut('rpc')) throw new Error(TIMEOUT);
      const groups = {};
      for (let t = Date.parse(from_day + 'T00:00:00Z'); t <= Date.parse(to_day + 'T00:00:00Z'); t += DAY)
        for (const c of BY_DAY[isoDay(t)] || []) {
          if (verticals && !verticals.includes(c.vertical_name)) continue;
          const g = { ivr_name: c.ivr_name || '(unknown)', publisher_name: c.publisher_name || '(unknown)', advertiser_name: c.advertiser_name || '(unknown)' };
          const k = JSON.stringify(g);
          const s = groups[k] || (groups[k] = { ...g, raw: 0, sent: 0, paid: 0, revenue: 0, payout: 0 });
          s.raw++; s.sent += c.connect_duration > 0 || c.result.includes('connected'); s.paid += c.advertiser_payin > 0;
          s.revenue += c.advertiser_payin; s.payout += c.publisher_payout;
        }
      return Object.values(groups);
    }
    const q = new URLSearchParams(url.split('?')[1]);
    const [gte, lt] = q.getAll('created_at').map(v => Date.parse(v.slice(v.indexOf('.') + 1) + 'T00:00:00Z'));
    const [from, to] = opts.headers.Range.split('-').map(Number);
    const day = isoDay(gte);
    log.push({ day, spanDays: (lt - gte) / DAY, from });
    if (timesOut(`${day}@${from}`)) throw new Error(TIMEOUT);
    return (BY_DAY[day] || []).slice(from, to + 1);
  };
}

function insightsContext(log, opts) {
  const ctx = { sbFetch: fakePostgrest(log, opts), insVerticalFilter: [], setTimeout: fn => setImmediate(fn), resolveIvrName: n => n };
  const fns = ['function isSent(', 'function isPaid(', 'function insDayWindows(', 'async function insFetchRetry(', 'async function insFetchPeriod('];
  vm.runInNewContext(fns.map(lift).join(';\n') + ';\nthis.insFetchPeriod = insFetchPeriod;', ctx);
  return ctx;
}
const plain = x => JSON.parse(JSON.stringify(x));   // out of the vm realm, for deepEqual
const callsIn = (from, to) => ROWS.filter(r => r.created_at >= Date.parse(from + 'T00:00:00Z') && r.created_at < Date.parse(to + 'T00:00:00Z') + DAY);

// Prod, 2026-11-12 18:30Z: a Sep-vs-Oct run paged raw calls per day, 3 days in parallel per
// period. The first pages of 2026-09-04 and 2026-10-02 took 8.5s/8.7s and hit the 8s timeout,
// and the whole run failed.
test('Insights: month vs month is one aggregate request per period, no raw call pages', async () => {
  const log = [];
  const { insFetchPeriod } = insightsContext(log, { timeouts: { '2026-09-04@0': 99, '2026-10-02@0': 99 } });
  const [sep, oct] = await Promise.all([insFetchPeriod('2026-09-01', '2026-09-30'), insFetchPeriod('2026-10-01', '2026-10-31')]);
  assert.deepEqual(plain(log), [
    { rpc: true, from_day: '2026-09-01', to_day: '2026-09-30', verticals: null },
    { rpc: true, from_day: '2026-10-01', to_day: '2026-10-31', verticals: null },
  ]);
  const raw = m => Object.values(m).reduce((s, r) => s + r.raw, 0);
  assert.equal(raw(sep.agents), callsIn('2026-09-01', '2026-09-30').length);
  assert.equal(raw(oct.pubs), callsIn('2026-10-01', '2026-10-31').length);
});

test('Insights: the aggregate gives the same numbers as summing every call', async () => {
  const viaRpc = await insightsContext([]).insFetchPeriod('2026-09-01', '2026-09-30');
  const perCall = await insightsContext([], { rpc: false }).insFetchPeriod('2026-09-01', '2026-09-30');
  assert.deepEqual(plain(viaRpc), plain(perCall));
  assert.equal(viaRpc.agents['(unknown)'].raw, callsIn('2026-09-01', '2026-09-30').filter(r => !r.ivr_name).length);
  assert.ok(viaRpc.pubs['Pub A'].byAgent['ASCND - Solar'].rev > 0, 'per-agent breakdown is filled');
});

test('Insights: verticals and the inclusive end day are passed to the aggregate', async () => {
  const log = [];
  const ctx = insightsContext(log);
  ctx.insVerticalFilter = ['Solar'];
  const { agents } = await ctx.insFetchPeriod('2026-09-30', '2026-09-30');
  assert.deepEqual(plain(log), [{ rpc: true, from_day: '2026-09-30', to_day: '2026-09-30', verticals: ['Solar'] }]);
  assert.equal(Object.values(agents).reduce((s, r) => s + r.raw, 0),
    callsIn('2026-09-30', '2026-09-30').filter(r => r.vertical_name === 'Solar').length);
});

test('Insights: a timed-out aggregate is retried', async () => {
  const log = [];
  const { agents } = await insightsContext(log, { timeouts: { rpc: 1 } }).insFetchPeriod('2026-09-01', '2026-09-30');
  assert.equal(log.length, 2);
  assert.equal(Object.values(agents).reduce((s, r) => s + r.raw, 0), callsIn('2026-09-01', '2026-09-30').length);
});

test('Insights fallback (before 051): the 18:30 run completes, timed-out pages are retried', async () => {
  const log = [];
  const { insFetchPeriod } = insightsContext(log, { rpc: false, timeouts: { '2026-09-04@0': 1, '2026-10-02@0': 2 } });
  const [sep, oct] = await Promise.all([insFetchPeriod('2026-09-01', '2026-09-30'), insFetchPeriod('2026-10-01', '2026-10-31')]);
  const raw = m => Object.values(m).reduce((s, r) => s + r.raw, 0);
  assert.equal(raw(sep.agents), callsIn('2026-09-01', '2026-09-30').length);
  assert.equal(raw(oct.agents), callsIn('2026-10-01', '2026-10-31').length);
  const pages = log.filter(r => !r.rpc);
  assert.equal(pages.filter(r => r.day === '2026-09-04' && r.from === 0).length, 2);
  assert.equal(pages.filter(r => r.day === '2026-10-02' && r.from === 0).length, 3);
  assert.ok(pages.every(r => r.spanDays === 1), 'each request covers one day');
  assert.ok(Math.max(...pages.map(r => r.from)) < 4000, 'offsets stay within one day of rows');
});

test('Insights fallback: a page that keeps timing out fails the run after 3 tries', async () => {
  const log = [];
  const { insFetchPeriod } = insightsContext(log, { rpc: false, timeouts: { '2026-09-04@0': 99 } });
  await assert.rejects(insFetchPeriod('2026-09-01', '2026-09-30'), /57014/);
  assert.equal(log.filter(r => r.day === '2026-09-04' && r.from === 0).length, 3);
});

test('Calls: "Has recording" filters on recording_id (recording_url is never populated)', () => {
  const values = { 'cr-rec-filter': 'yes', 'cr-pub-filter': '', 'cr-adv-filter': '' };
  const ctx = {
    crDrpPickStart: '2026-11-01', crDrpPickEnd: '2026-11-11', crLinkScope: null,
    crOutcomeGroupMembers: () => [], crSelectedVerticals: () => [],
    document: { getElementById: id => ({ value: values[id] ?? '', classList: { contains: () => false } }) },
  };
  vm.runInNewContext(['function localDayRange(', 'function crBuildFilters('].map(lift).join(';\n') + ';\nthis.crBuildFilters = crBuildFilters;', ctx);
  assert.match(ctx.crBuildFilters(), /&recording_id=not\.is\.null/);
  values['cr-rec-filter'] = 'no';
  assert.match(ctx.crBuildFilters(), /&recording_id=is\.null/);
  assert.doesNotMatch(ctx.crBuildFilters(), /recording_url/);
});
