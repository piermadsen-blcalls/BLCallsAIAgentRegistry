// The Suspicious tab (MK-195, MK-196): verdict chips and buttons per caller, one Decide per repeat
// caller with its 30-day margin, Hide decided, the Odd timing list (every connected call against its
// agent's typical length, a % over typical slider and an agent pick), and saving/removing a verdict.
// Same script is gone (MK-196). The SQL side has its own tests
// (supabase/tests/069_suspicious_callers_test.sql, 070_suspicious_tab_v2_test.sql). Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// The tab's whole script section, run as is.
const SRC = html.slice(html.indexOf('// ── SUSPICIOUS TAB'), html.indexOf('// ── UTILITIES'));

const unhtml = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = s => unhtml(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const plain = x => JSON.parse(JSON.stringify(x));   // values made inside the vm context, compared here

function el(id, init = {}) {
  const classes = new Set(init.classes || []);
  return {
    id, innerHTML: '', textContent: '', value: init.value || '', style: { display: init.display ?? '' }, attrs: {},
    classList: { contains: c => classes.has(c), toggle: c => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)) },
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}
function page({ me = 'me@example.com', fetch } = {}) {
  const els = {
    'sus-days': el('sus-days', { value: '30' }), 'sus-pct': el('sus-pct', { value: '50' }),
    'sus-hidedec': el('sus-hidedec', { classes: ['active'] }), 'sus-cross': el('sus-cross', { classes: ['active'] }),
    'sus-timing-agent': el('sus-timing-agent'),
    'sus-pane-repeat': el('sus-pane-repeat'), 'sus-pane-timing': el('sus-pane-timing', { display: 'none' }),
  };
  const calls = [], alerts = [];
  const ctx = {
    document: { getElementById: id => els[id] || (els[id] = el(id)), querySelectorAll: () => [] },
    esc: s => s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    jsStr: s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
    nullMark: () => '<span class="null-mark">-</span>',
    labelOf: v => String(v ?? '').replace(/_/g, ' '),
    outcomeBadge: o => `<span class="outcome-badge">${o}</span>`,
    httpUrl: u => /^https?:\/\//i.test(String(u || '')) ? String(u) : '',
    pgQuote: v => '"' + String(v) + '"',
    loadErrorHtml: (thing) => `<div class="load-error">Couldn't load ${thing}.</div>`,
    getAuthUser: () => me,
    AGENTS: [{ ivrName: 'Pest IVR', name: 'Pest Pro' }],   // 'Roof IVR' has no agent row: shown by its IVR name
    resolveIvrName: n => ({ 'Pest IVR old': 'Pest IVR' })[n] || n,
    alert: m => alerts.push(m),
    console: { warn() {} },
    sbFetch: async (p, o) => { calls.push([p, o && o.body ? JSON.parse(o.body) : null]); return fetch ? fetch(p, o) : []; },
    Promise, Date, JSON, Math, Set, Number, parseInt, encodeURIComponent, String, Array, Object,
  };
  vm.runInNewContext(SRC + '\nthis.api = { susVerdicts, susVStateHtml, susVerdictHtml, susVote, susLoadRepeat, susLoadOdd, susRenderLong, susRenderRepeat, susToggleHide, susStats, susExpandGroup, susMoney, currentSusSource, set: (k, v) => { if (k === "repeat") susRepeatRows = v; if (k === "odd") susOddRows = v; } };', ctx);
  return { ...ctx.api, els, calls, alerts };
}

test('chips: Needs verdict, You: <verdict>, Decided · n, 1/2 decided, All decided', () => {
  const p = page();
  assert.equal(text(p.susVStateHtml(['5550100001'])), 'Needs verdict');
  p.susVerdicts['5550100001'] = [{ decided_by: 'me@example.com', verdict: 'coached' }];
  assert.equal(text(p.susVStateHtml(['5550100001'])), 'You: Agree');
  p.susVerdicts['5550100001'].push({ decided_by: 'luke@example.com', verdict: 'unknown' });
  assert.equal(text(p.susVStateHtml(['5550100001'])), 'You: Agree · 2');
  p.susVerdicts['5550100002'] = [{ decided_by: 'luke@example.com', verdict: 'not_coached' }];
  assert.equal(text(p.susVStateHtml(['5550100002'])), 'Decided · 1');
  assert.equal(text(p.susVStateHtml(['5550100002', '5550100003'])), '1/2 decided');
  assert.equal(text(p.susVStateHtml(['5550100001', '5550100002'])), 'All decided');
});

test('buttons: counts per verdict, yours pressed, the team listed; no number = no verdict', () => {
  const p = page();
  p.susVerdicts['5550100001'] = [{ decided_by: 'me@example.com', verdict: 'coached' }, { decided_by: 'luke@example.com', verdict: 'coached' }];
  const h = p.susVerdictHtml('5550100001', 'call-1');
  assert.match(h, /class="sus-vbtn active" aria-pressed="true" title="Your verdict. Click again to remove it."[^>]*>Agree<span class="ct">2<\/span>/);
  assert.match(text(h), /Disagree Unknown 2 verdicts on this caller/);
  assert.match(unhtml(h), /title="me@example.com: Agree, luke@example.com: Agree"/);
  assert.match(text(p.susVerdictHtml(null, 'call-2')), /cannot get a verdict/);
  assert.doesNotMatch(p.susVerdictHtml(null, 'call-2'), /sus-vbtn/);
});

test('voting saves per caller through the RPC with the open sub-tab as its source; your verdict again removes it; a failure changes nothing', async () => {
  let fail = false;
  const p = page({ fetch: () => { if (fail) throw new Error('Supabase 401'); return null; } });
  p.els['sus-pane-timing'].style.display = '';
  p.els['sus-pane-repeat'].style.display = 'none';
  assert.equal(p.currentSusSource(), 'timing');
  await p.susVote('5550100001', 'coached', 'call-1');
  assert.deepEqual(p.calls.at(-1), ['rpc/coached_verdict_set', { p_caller: '5550100001', p_verdict: 'coached', p_source: 'timing', p_call_id: 'call-1' }]);
  assert.deepEqual(plain(p.susVerdicts['5550100001'].map(r => r.verdict)), ['coached']);
  await p.susVote('5550100001', 'unknown', 'call-1');
  assert.deepEqual(plain(p.susVerdicts['5550100001'].map(r => r.verdict)), ['unknown'], 'one verdict per person: changed, not added');
  await p.susVote('5550100001', 'unknown', 'call-1');
  assert.deepEqual(p.calls.at(-1), ['rpc/coached_verdict_clear', { p_caller: '5550100001' }]);
  assert.deepEqual(plain(p.susVerdicts['5550100001']), []);
  fail = true;
  await p.susVote('5550100001', 'coached', 'call-1');
  assert.deepEqual(plain(p.susVerdicts['5550100001']), [], 'unchanged after a failed save');
  assert.equal(p.alerts.length, 1);
  const out = page({ me: null });
  await out.susVote('5550100001', 'coached', 'call-1');
  assert.equal(out.calls.length, 0, 'signed out: nothing sent');
});

test('money: whole dollars with a sign', () => {
  const p = page();
  assert.equal(p.susMoney(1234.56), '$1,235');
  assert.equal(p.susMoney(-12.4), '-$12');
  assert.equal(p.susMoney('45'), '$45');
  assert.equal(p.susMoney(null), '$0');
});

test('odd timing: every connected call, highest % over typical first; the % slider and agent pick filter live; decided callers hide', async () => {
  const row = (id, caller, duration, pct, extra) => ({ id, caller, called_from: '+1' + caller, ivr_name: 'Roof IVR', agent_key: 'Roof IVR', vertical_name: 'Roofing',
    our_outcome: null, duration, typical_secs: 400, typical_n: 35, typical_from: 'agent', pct_above: pct, total: 4, ...extra });
  const rows = [
    row('o2', '5550100012', 500, 25),
    row('o1', '5550100011', 1600, 300, { our_outcome: 'appointment' }),
    row('o3', '5550100013', 900, 125, { ivr_name: 'Pest IVR old', agent_key: 'Pest IVR' }),
    row('o4', '5550100014', 150, 50, { ivr_name: null, agent_key: null, vertical_name: 'Tiny', typical_secs: 100, typical_n: 3, typical_from: 'vertical' }),
  ];
  const p = page({ fetch: path => path.startsWith('rpc/suspicious_odd_timing') ? rows : [] });
  const count = () => (p.els['sus-conv-long'].innerHTML.match(/<details/g) || []).length;
  await p.susLoadOdd();
  assert.equal(p.calls[0][1].min_pct, 0, 'loaded from the slider floor (0%), filtered on the page');
  assert.equal(p.calls[0][1].min_secs, undefined);
  let h = p.els['sus-conv-long'].innerHTML;
  assert.equal(count(), 3, 'default 50%: 300%, 125% and 50% (inclusive); 25% is out');
  assert.ok(h.indexOf('+15550100011') < h.indexOf('+15550100013') && h.indexOf('+15550100013') < h.indexOf('+15550100014'), 'highest % first');
  assert.equal(p.els['sus-pct-label'].textContent, '50% over typical');
  assert.equal(p.els['sus-ct-timing'].textContent, '(3)');
  assert.match(h, /sus-sev-hot">\+300%</, '100% or more over: hot');
  assert.match(h, /sus-sev-warm">\+50%</, 'under 100% over: warm');
  assert.match(text(h), /Pest Pro · Roofing/, 'the agent on the row, by display name, aliases resolved');
  assert.match(text(h), /26m 40s call, 300% over Roof IVR's typical call \(6m 40s\)/);
  assert.match(text(h), /the median of Roof IVR's 35 connected calls in the last 30 days/, 'an agent with 20+ calls: its own typical');
  assert.match(text(h), /2m 30s call, 50% over the typical Tiny call \(1m 40s\)/, 'no agent: the vertical');
  assert.match(text(h), /the Tiny vertical's median over the last 30 days, 3 connected calls, as this call has no agent/);
  assert.match(h, /outcome-badge">appointment/, 'an outcome still shows as a badge');
  assert.doesNotMatch(text(h), /became an appointment or sale/);
  assert.equal(p.els['sus-timing-agent'].innerHTML, '<option value="">All agents</option><option value="Pest IVR">Pest Pro</option><option value="Roof IVR">Roof IVR</option>');
  p.els['sus-pct'].value = '0'; p.susRenderLong();
  assert.equal(count(), 4); assert.equal(p.els['sus-pct-label'].textContent, '0% over typical'); assert.equal(p.els['sus-stat-timing'].innerHTML, '4');
  p.els['sus-pct'].value = '200'; p.susRenderLong();
  assert.equal(count(), 1, '200%: only the 300% call');
  p.els['sus-pct'].value = '300'; p.susRenderLong();
  assert.equal(count(), 1, 'the slider is inclusive');
  p.els['sus-timing-agent'].value = 'Pest IVR'; p.susRenderLong();
  assert.match(text(p.els['sus-conv-long'].innerHTML), /No calls 300% or more over typical for this agent in this window. Slide left to widen./);
  p.els['sus-pct'].value = '0'; p.susRenderLong();
  assert.equal(count(), 1, 'the picked agent only (an alias counts as its agent)'); assert.equal(p.els['sus-ct-timing'].textContent, '(1)');
  p.els['sus-timing-agent'].value = ''; p.susVerdicts['5550100011'] = [{ decided_by: 'luke@example.com', verdict: 'not_coached' }]; p.susRenderLong();
  assert.equal(count(), 3, 'decided caller hidden');
  assert.match(text(p.els['sus-conv-long'].innerHTML), /1 decided row is hidden/);
  assert.equal(p.els['sus-stat-await'].innerHTML, '3', 'callers with no verdict: 12, 13 and 14');
  p.susToggleHide(p.els['sus-hidedec']);
  assert.equal(count(), 4, 'toggle restores it');
  p.els['sus-timing-agent'].value = 'Pest IVR'; await p.susLoadOdd();
  assert.equal(p.els['sus-timing-agent'].value, 'Pest IVR', 'a refresh keeps the pick');
});

test('odd timing: a capped list says so', async () => {
  const rows = [{ id: 'o1', caller: '5550100011', called_from: '+15550100011', duration: 900, typical_secs: 300, typical_n: 40, typical_from: 'agent', pct_above: 200, total: 2500 }];
  const p = page({ fetch: path => path.startsWith('rpc/suspicious_odd_timing') ? rows : [] });
  await p.susLoadOdd();
  assert.match(text(p.els['sus-conv-long'].innerHTML), /Showing the 1 furthest over typical of 2500 calls/);
});

test('repeat callers: one Decide per caller, the 30-day margin on the row and in the why, no conversions tag; capped lists say so', async () => {
  const group = { caller: '5550100021', called_from: '+15550100021', calls: 3, distinct_zips: 2, distinct_verticals: 1, distinct_publishers: 2,
    zips: ['30301', '60601'], verticals: ['Pest'], publishers: ['A', 'B'], flagged: 0, last_call: '2026-11-19T15:00:00Z',
    call_ids: ['c3', 'c2', 'c1'], payin_30d: '105.50', payout_30d: '70', margin_30d: '35.50', total: 450 };
  const loser = { ...group, caller: '5550100022', called_from: '+15550100022', payin_30d: '0', payout_30d: '5', margin_30d: '-5', total: 450 };
  const p = page({ fetch: path => {
    if (path.startsWith('rpc/suspicious_repeat_callers')) return [group, loser];
    if (path.startsWith('coached_verdicts')) return [];
    if (path.startsWith('canoe_calls?id=in.')) return [{ id: 'c3', called_from: '+15550100021', created_at: '2026-11-19T15:00:00Z' }, { id: 'c2', called_from: '+15550100021' }];
    return [];
  } });
  await p.susLoadRepeat();
  const h = p.els['sus-repeat'].innerHTML;
  assert.match(text(h), /Showing the 2 strongest of 450 numbers/);
  assert.equal((h.match(/data-susv="5550100021"/g) || []).length, 1, 'one Decide for the caller');
  assert.match(text(h), /3 connected calls in the last 30 days across 2 different ZIPs \(30301, 60601\), 2 publishers \(A, B\)\. Over the last 30 days its calls brought in \$106 from advertisers and cost \$70 in publisher payouts: a margin of \$36 ?\./);
  assert.match(h, /<\/summary>/);
  const summary = h.slice(0, h.indexOf('</summary>'));
  assert.match(summary, /<span class="sus-margin" title="Last 30 days, every call from this number: \$106 from advertisers minus \$70 to publishers">\$36 margin \/ 30d<\/span>/, 'the margin shows before the row is opened');
  assert.match(h, /<span class="sus-margin neg" title="[^"]*">-\$5 margin \/ 30d<\/span>/, 'a negative margin is marked');
  assert.doesNotMatch(text(h), /became an appointment or sale/);
  assert.match(text(summary), /3 calls across 2 ZIPs ?, 1 vertical and 2 publishers/);
  assert.equal(p.els['sus-stat-repeat'].innerHTML, '450');
  assert.equal(p.calls.find(c => c[0].startsWith('rpc/suspicious_repeat_callers'))[1].cross_only, true);

  const box = { dataset: {}, innerHTML: '' };
  await p.susExpandGroup({ querySelector: () => box }, 0);
  assert.equal((box.innerHTML.match(/<details class="sus-row"/g) || []).length, 2, 'each call opens to Listen and Read');
  assert.doesNotMatch(box.innerHTML, /data-susv=/, 'no per-call Decide inside a repeat group');
  assert.match(p.calls.at(-1)[0], /canoe_calls\?id=in\.\(%22c3%22,%22c2%22,%22c1%22\)/, 'ids quoted');
});

test('each section fails on its own with the standard load error', async () => {
  const p = page({ fetch: path => { if (path.startsWith('rpc/suspicious_odd_timing')) throw new Error('Supabase 404'); return []; } });
  await Promise.all([p.susLoadRepeat(), p.susLoadOdd()]);
  assert.match(p.els['sus-conv-long'].innerHTML, /Couldn't load odd timing/);
  assert.match(text(p.els['sus-repeat'].innerHTML), /No cross-ZIP\/vertical\/publisher repeat callers in this window/);
  assert.equal(p.els['sus-stat-timing'].innerHTML, '<span class="null-mark">-</span>');
  assert.equal(p.els['sus-stat-repeat'].innerHTML, '0');
});

test('page wiring: nav tab, switchTab hook, two sub-tabs, no Same script, only the 069/070 RPCs and tables', () => {
  assert.match(html, /<button class="nav-tab" onclick="switchTab\('suspicious',this\)">Suspicious<\/button>/);
  assert.match(html, /if \(id === 'suspicious'\) suspiciousInit\(\);/);
  assert.match(html, /<div id="tab-suspicious" class="tab-pane">/);
  const tab = html.slice(html.indexOf('<div id="tab-suspicious"'), html.indexOf('<!-- Manual CSV-upload panel'));
  assert.deepEqual([...tab.matchAll(/class="comp-subtab[^"]*" onclick="susSub\('(\w+)'/g)].map(m => m[1]), ['repeat', 'timing']);
  assert.doesNotMatch(tab, /sus-pane-script|Same script|sus-sim|sus-len|sus-stat-script/);
  assert.match(tab, /<input type="range" id="sus-pct" min="0" max="300" step="10" value="50"/, 'the % over typical slider replaces the minutes one');
  assert.doesNotMatch(SRC, /script_matches|suspicious_similar|suspicious_conversions|became an appointment or sale|conversions/);
  const used = new Set([...SRC.matchAll(/sbFetch\(\s*[`'](rpc\/\w+|\w+)/g)].map(m => m[1]));
  assert.deepEqual([...used].sort(), ['canoe_calls', 'coached_verdicts', 'rpc/coached_verdict_clear', 'rpc/coached_verdict_set',
    'rpc/suspicious_odd_timing', 'rpc/suspicious_repeat_callers']);
});
