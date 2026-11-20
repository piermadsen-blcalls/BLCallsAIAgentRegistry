// The Suspicious tab (MK-195): verdict chips and buttons per caller, one Decide per repeat caller,
// Hide decided, the script-pair and timing filters, and saving/removing a verdict. The SQL side
// has its own test (supabase/tests/069_suspicious_callers_test.sql). Run: node --test tests/
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
    'sus-days': el('sus-days', { value: '30' }), 'sus-fast': el('sus-fast', { value: '300' }), 'sus-long': el('sus-long', { value: '50' }),
    'sus-hidedec': el('sus-hidedec', { classes: ['active'] }), 'sus-cross': el('sus-cross', { classes: ['active'] }),
    'sus-diff': el('sus-diff', { classes: ['active'] }),
    'sus-pane-repeat': el('sus-pane-repeat'), 'sus-pane-script': el('sus-pane-script', { display: 'none' }), 'sus-pane-timing': el('sus-pane-timing', { display: 'none' }),
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
    alert: m => alerts.push(m),
    console: { warn() {} },
    sbFetch: async (p, o) => { calls.push([p, o && o.body ? JSON.parse(o.body) : null]); return fetch ? fetch(p, o) : []; },
    Promise, Date, JSON, Math, Set, parseInt, encodeURIComponent, String, Array, Object,
  };
  vm.runInNewContext(SRC + '\nthis.api = { susVerdicts, susVStateHtml, susVerdictHtml, susVote, susLoadRepeat, susLoadSimilar, susLoadConv, susRenderSimilar, susRenderLong, susRenderFast, susRenderRepeat, susToggleHide, susToggleDiff, susStats, susExpandGroup, set: (k, v) => { if (k === "repeat") susRepeatRows = v; if (k === "similar") susSimilarRows = v; if (k === "conv") susConvRows = v; } };', ctx);
  return { ...ctx.api, els, calls, alerts };
}

const PAIR = (a, b, extra = {}) => ({ call_id_a: 'ca' + a, call_id_b: 'cb' + b, similarity: 0.72, same_caller: a === b, vertical: 'Pest', computed_at: '2026-11-20T07:46:00Z',
  a_caller: a, b_caller: b, a_called_from: '+1' + a, b_called_from: '+1' + b, a_created_at: '2026-11-19T15:00:00Z', b_created_at: '2026-11-19T16:00:00Z', ...extra });

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

test('voting saves per caller through the RPC; your verdict again removes it; a failure changes nothing', async () => {
  let fail = false;
  const p = page({ fetch: () => { if (fail) throw new Error('Supabase 401'); return null; } });
  p.els['sus-pane-script'].style.display = '';
  p.els['sus-pane-repeat'].style.display = 'none';
  await p.susVote('5550100001', 'coached', 'call-1');
  assert.deepEqual(p.calls.at(-1), ['rpc/coached_verdict_set', { p_caller: '5550100001', p_verdict: 'coached', p_source: 'script', p_call_id: 'call-1' }]);
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

test('same script: different callers only, Hide decided hides a pair once both callers are decided', () => {
  const p = page();
  p.set('similar', [PAIR('5550100001', '5550100002'), PAIR('5550100003', '5550100003'), PAIR('5550100004', '5550100005')]);
  ['5550100001', '5550100002', '5550100003', '5550100004', '5550100005'].forEach(k => { p.susVerdicts[k] = []; });
  p.susRenderSimilar();
  assert.equal((p.els['sus-similar'].innerHTML.match(/<details class="sus-row">/g) || []).length, 2, 'the same-number pair is filtered');
  assert.equal(p.els['sus-ct-script'].textContent, '(2)');
  p.susToggleDiff(p.els['sus-diff']);
  assert.equal((p.els['sus-similar'].innerHTML.match(/<details class="sus-row">/g) || []).length, 3, 'shown again when the filter is off');
  p.susToggleDiff(p.els['sus-diff']);

  p.susVerdicts['5550100001'] = [{ decided_by: 'luke@example.com', verdict: 'coached' }];
  p.susRenderSimilar();
  assert.equal((p.els['sus-similar'].innerHTML.match(/<details class="sus-row">/g) || []).length, 2, 'one caller decided: still in the queue');
  assert.match(text(p.els['sus-similar'].innerHTML), /1\/2 decided/);
  p.susVerdicts['5550100002'] = [{ decided_by: 'me@example.com', verdict: 'coached' }];
  p.susRenderSimilar();
  assert.equal((p.els['sus-similar'].innerHTML.match(/<details class="sus-row">/g) || []).length, 1, 'both decided: hidden');
  assert.match(text(p.els['sus-similar'].innerHTML), /1 decided row is hidden/);
  p.susToggleHide(p.els['sus-hidedec']);
  assert.equal((p.els['sus-similar'].innerHTML.match(/<details class="sus-row">/g) || []).length, 2, 'toggle restores it');
  // Each side of a pair plays its own recording and has its own Decide.
  assert.equal((p.els['sus-similar'].innerHTML.match(/data-susv="5550100001"/g) || []).length, 1);
  assert.equal((p.els['sus-similar'].innerHTML.match(/data-susv="5550100002"/g) || []).length, 1);
});

test('odd timing: fast rows shortest first; the slider filters long rows live; decided callers hide', () => {
  const p = page();
  const row = (id, caller, extra) => ({ id, caller, called_from: '+1' + caller, vertical_name: 'Roofing', our_outcome: 'appointment', typical_secs: 400, vertical_n: 20, ...extra });
  p.set('conv', [
    row('f1', '5550100011', { is_fast: true, is_long: false, duration: 200, pct_above: -50 }),
    row('f2', '5550100012', { is_fast: true, is_long: false, duration: 90, pct_above: -77 }),
    row('l1', '5550100013', { is_fast: false, is_long: true, duration: 600, pct_above: 50 }),
    row('l2', '5550100014', { is_fast: false, is_long: true, duration: 1600, pct_above: 300 }),
  ]);
  ['5550100011', '5550100012', '5550100013', '5550100014'].forEach(k => { p.susVerdicts[k] = []; });
  p.susRenderFast(); p.susRenderLong();
  const fast = p.els['sus-conv-fast'].innerHTML;
  assert.ok(fast.indexOf('+15550100012') < fast.indexOf('+15550100011'), '90 s before 200 s');
  assert.equal((p.els['sus-conv-long'].innerHTML.match(/<details/g) || []).length, 2, 'default 50%: both long rows');
  assert.equal(p.els['sus-ct-timing'].textContent, '(4)');
  p.els['sus-long'].value = '100';
  p.susRenderLong();
  assert.equal(p.els['sus-long-label'].textContent, '100%');
  assert.equal((p.els['sus-conv-long'].innerHTML.match(/<details/g) || []).length, 1, '100%: only +300%');
  assert.equal(p.els['sus-ct-timing'].textContent, '(3)');
  assert.equal(p.els['sus-stat-timing'].innerHTML, '3');
  p.susVerdicts['5550100012'] = [{ decided_by: 'luke@example.com', verdict: 'not_coached' }];
  p.susRenderFast();
  assert.equal((p.els['sus-conv-fast'].innerHTML.match(/<details/g) || []).length, 1, 'decided caller hidden');
  assert.equal(p.els['sus-stat-await'].innerHTML, '2', 'callers with no verdict: 11 and 14');
});

test('repeat callers: one Decide per caller in the group, none on its calls; capped lists say so', async () => {
  const group = { caller: '5550100021', called_from: '+15550100021', calls: 3, distinct_zips: 2, distinct_verticals: 1, distinct_publishers: 2,
    zips: ['30301', '60601'], verticals: ['Pest'], publishers: ['A', 'B'], conversions: 1, flagged: 0, last_call: '2026-11-19T15:00:00Z',
    call_ids: ['c3', 'c2', 'c1'], total: 450 };
  const p = page({ fetch: path => {
    if (path.startsWith('rpc/suspicious_repeat_callers')) return [group];
    if (path.startsWith('coached_verdicts')) return [];
    if (path.startsWith('canoe_calls?id=in.')) return [{ id: 'c3', called_from: '+15550100021', created_at: '2026-11-19T15:00:00Z' }, { id: 'c2', called_from: '+15550100021' }];
    return [];
  } });
  await p.susLoadRepeat();
  const h = p.els['sus-repeat'].innerHTML;
  assert.match(text(h), /Showing the 1 strongest of 450 numbers/);
  assert.equal((h.match(/data-susv="5550100021"/g) || []).length, 1, 'one Decide for the caller');
  assert.match(text(h), /3 connected calls in the last 30 days across 2 different ZIPs \(30301, 60601\), 2 publishers \(A, B\)/);
  assert.equal(p.els['sus-stat-repeat'].innerHTML, '450');
  assert.equal(p.calls.find(c => c[0].startsWith('rpc/suspicious_repeat_callers'))[1].cross_only, true);

  const box = { dataset: {}, innerHTML: '' };
  await p.susExpandGroup({ querySelector: () => box }, 0);
  assert.equal((box.innerHTML.match(/<details class="sus-row"/g) || []).length, 2, 'each call opens to Listen and Read');
  assert.doesNotMatch(box.innerHTML, /data-susv=/, 'no per-call Decide inside a repeat group');
  assert.match(p.calls.at(-1)[0], /canoe_calls\?id=in\.\(%22c3%22,%22c2%22,%22c1%22\)/, 'ids quoted');
});

test('each section fails on its own with the standard load error', async () => {
  const p = page({ fetch: path => { if (path.startsWith('rpc/suspicious_similar')) throw new Error('Supabase 404'); return []; } });
  await Promise.all([p.susLoadRepeat(), p.susLoadSimilar(), p.susLoadConv()]);
  assert.match(p.els['sus-similar'].innerHTML, /Couldn't load transcript matches/);
  assert.match(text(p.els['sus-repeat'].innerHTML), /No cross-ZIP\/vertical\/publisher repeat callers in this window/);
  assert.match(text(p.els['sus-conv-fast'].innerHTML), /No conversions booked this fast/);
  assert.equal(p.els['sus-stat-script'].innerHTML, '<span class="null-mark">-</span>');
});

test('page wiring: nav tab, switchTab hook, and only the 069 RPCs and tables', () => {
  assert.match(html, /<button class="nav-tab" onclick="switchTab\('suspicious',this\)">Suspicious<\/button>/);
  assert.match(html, /if \(id === 'suspicious'\) suspiciousInit\(\);/);
  assert.match(html, /<div id="tab-suspicious" class="tab-pane">/);
  const used = new Set([...SRC.matchAll(/sbFetch\(\s*[`'](rpc\/\w+|\w+)/g)].map(m => m[1]));
  assert.deepEqual([...used].sort(), ['canoe_calls', 'coached_verdicts', 'rpc/coached_verdict_clear', 'rpc/coached_verdict_set',
    'rpc/suspicious_conversions', 'rpc/suspicious_repeat_callers', 'rpc/suspicious_similar_transcripts']);
});
