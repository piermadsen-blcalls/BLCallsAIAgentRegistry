// The Suspicious tab (MK-195, MK-196, MK-199): verdict chips and buttons per caller, one Decide per
// repeat caller with its 30-day margin, Hide decided, the Transcript keywords search (AND, agent pick,
// highlighting), the Blocked in Canoe tick, the Decided lists behind the Coached call / Unknown
// buttons, the Coached caller stats, and the CSV export built in the browser. Odd timing is gone
// (MK-199). The SQL side has its own tests (supabase/tests/069_*, 070_*, 071_*). Run: node --test tests/
// Every number here is made up (555-010-xxxx).
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
const details = h => (h.match(/<details class="sus-row"/g) || []).length;

function el(id, init = {}) {
  const classes = new Set(init.classes || []);
  return {
    id, innerHTML: '', textContent: '', value: init.value || '', style: { display: init.display ?? '' }, attrs: {}, dataset: {},
    classList: { contains: c => classes.has(c), toggle: (c, on) => { if (on === undefined) on = !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; } },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector: () => null,
    insertAdjacentHTML(_, h) { this.innerHTML += h; },
  };
}
function page({ me = 'me@example.com', fetch } = {}) {
  const els = {
    'sus-days': el('sus-days', { value: '30' }),
    'sus-hidedec': el('sus-hidedec', { classes: ['active'] }), 'sus-cross': el('sus-cross', { classes: ['active'] }),
    'sus-pane-repeat': el('sus-pane-repeat'), 'sus-pane-keywords': el('sus-pane-keywords', { display: 'none' }), 'sus-pane-stats': el('sus-pane-stats', { display: 'none' }),
    'sus-view-queue': el('sus-view-queue'), 'sus-view-decided': el('sus-view-decided', { display: 'none' }),
    'sus-export': el('sus-export', { display: 'none' }),
  };
  const calls = [], alerts = [];
  const ctx = {
    document: { getElementById: id => els[id] || (els[id] = el(id)), querySelectorAll: () => [], querySelector: () => null },
    esc: s => s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    jsStr: s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
    nullMark: () => '<span class="null-mark">-</span>',
    labelOf: v => String(v ?? '').replace(/_/g, ' '),
    outcomeBadge: o => `<span class="outcome-badge">${o}</span>`,
    httpUrl: u => /^https?:\/\//i.test(String(u || '')) ? String(u) : '',
    pgQuote: v => '"' + String(v) + '"',
    loadErrorHtml: (thing) => `<div class="load-error">Couldn't load ${thing}.</div>`,
    getAuthUser: () => me,
    AGENTS: [{ ivrName: 'Pest IVR', name: 'Pest Pro' }, { ivrName: 'Roof IVR', name: 'Roof IVR' }],
    resolveIvrName: n => ({ 'Pest IVR old': 'Pest IVR' })[n] || n,
    alert: m => alerts.push(m),
    console: { warn() {} },
    sbFetch: async (p, o) => { calls.push([p, o && o.body ? JSON.parse(o.body) : null]); return fetch ? fetch(p, o) : []; },
    Promise, Date, JSON, Math, Set, Map, Number, parseInt, encodeURIComponent, String, Array, Object, RegExp,
  };
  vm.runInNewContext(SRC + `\nthis.api = { susVerdicts, susBlocks, susDecCounts, susCallLists, susVStateHtml, susChipsHtml, susVerdictHtml, susVote, susSetBlocked,
    susLoadRepeat, susRenderRepeat, susToggleHide, susStats, susLoadCalls, susMoney, currentSusSource, susFetchVerdicts, susLoadDecidedCounts,
    susRunSearch, susRenderKeywords, susRenderKwBar, susRemoveKw, susClearKw, susMark, susOpenCallRow, susKeywords,
    susLoadCoached, susRenderStats, susTally, susShowDecided, susLoadDecided, susRenderDecided, susDecidedSub,
    susCsv, susCsvCell, susCsvName, susStamp, susWhyText, suspiciousInit, susReload,
    kw: v => { susKw = v; }, getKw: () => susKw, searched: () => susSearched, view: () => susDecidedView,
    set: (k, v) => { if (k === "repeat") susRepeatRows = v; if (k === "coached") susCoachedCalls = v; if (k === "decided") susDecidedRows = v; if (k === "kw") susKwRows = v; } };`, ctx);
  return { ...ctx.api, els, calls, alerts };
}
const rpc = (p, name) => p.calls.filter(c => c[0] === 'rpc/' + name);

test('chips: Needs verdict, You: <verdict>, Decided · n, 1/2 decided, All decided; a ticked caller carries the Blocked in Canoe marker', () => {
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
  assert.equal(text(p.susChipsHtml(['5550100001'])), 'You: Agree · 2', 'no tick: no marker');
  p.susBlocks['5550100001'] = { blocked_by: 'luke@example.com', blocked_at: '2026-11-20T10:00:00Z' };
  assert.match(p.susChipsHtml(['5550100001']), /sus-vstate done">You: Agree · 2<\/span><span class="sus-bchip yes" title="Ticked as blocked in Canoe by luke@example.com">✓ Blocked in Canoe<\/span>/);
  assert.equal(text(p.susChipsHtml(['5550100001', '5550100002'])), 'All decided', 'a many-caller row has no marker');
});

test('buttons: counts per verdict, yours pressed, the team listed, the Blocked in Canoe? box (unticked, then who and when); no number = no verdict', () => {
  const p = page();
  p.susVerdicts['5550100001'] = [{ decided_by: 'me@example.com', verdict: 'coached' }, { decided_by: 'luke@example.com', verdict: 'coached' }];
  const h = p.susVerdictHtml('5550100001', 'call-1');
  assert.match(h, /class="sus-vbtn active" aria-pressed="true" title="Your verdict. Click again to remove it."[^>]*>Agree<span class="ct">2<\/span>/);
  assert.match(text(h), /Disagree Unknown 2 verdicts on this caller Blocked in Canoe\?$/);
  assert.match(unhtml(h), /title="me@example.com: Agree, luke@example.com: Agree"/);
  assert.match(h, /<label class="sus-block" [^>]*><input type="checkbox" onchange="susSetBlocked\('5550100001',this.checked\)"> Blocked in Canoe\?<\/label>$/, 'starts unticked');
  p.susBlocks['5550100001'] = { blocked_by: 'luke@example.com', blocked_at: '2026-11-20T10:00:00Z' };
  const t = p.susVerdictHtml('5550100001', 'call-1');
  assert.match(t, /<label class="sus-block on" [^>]*><input type="checkbox" checked onchange=/);
  assert.match(text(t), /Blocked in Canoe\? ticked by luke@example.com · Nov 20/);
  assert.match(text(p.susVerdictHtml(null, 'call-2')), /cannot get a verdict/);
  assert.doesNotMatch(p.susVerdictHtml(null, 'call-2'), /sus-vbtn|sus-block/);
});

test('voting saves per caller through the RPC with the open sub-tab or the Decided list as its source; your verdict again removes it; the counts and stats reload; a failure changes nothing', async () => {
  let fail = false;
  const p = page({ fetch: p => { if (fail) throw new Error('Supabase 401'); return p.startsWith('coached_verdicts?verdict') ? [{ caller: '5550100001', verdict: 'coached' }] : null; } });
  assert.equal(p.currentSusSource(), 'repeat');
  p.els['sus-pane-keywords'].style.display = '';
  p.els['sus-pane-repeat'].style.display = 'none';
  assert.equal(p.currentSusSource(), 'keywords');
  await p.susVote('5550100001', 'coached', 'call-1');
  assert.deepEqual(p.calls[0], ['rpc/coached_verdict_set', { p_caller: '5550100001', p_verdict: 'coached', p_source: 'keywords', p_call_id: 'call-1' }]);
  assert.deepEqual(plain(p.susVerdicts['5550100001'].map(r => r.verdict)), ['coached']);
  await new Promise(r => setTimeout(r, 0));
  assert.ok(p.calls.some(c => c[0].startsWith('coached_verdicts?verdict=in.(coached,unknown)')), 'the Decided counts reload');
  assert.ok(rpc(p, 'suspicious_coached_calls').length, 'the coached calls (stats, export) reload');
  assert.equal(p.els['sus-dec-ct-coached'].textContent, '1');
  p.susShowDecided('coached');
  assert.equal(p.currentSusSource(), 'decided');
  await p.susVote('5550100001', 'unknown', 'call-1');
  assert.equal(rpc(p, 'coached_verdict_set').at(-1)[1].p_source, 'decided');
  assert.deepEqual(plain(p.susVerdicts['5550100001'].map(r => r.verdict)), ['unknown'], 'one verdict per person: changed, not added');
  await p.susVote('5550100001', 'unknown', 'call-1');
  assert.deepEqual(rpc(p, 'coached_verdict_clear').at(-1), ['rpc/coached_verdict_clear', { p_caller: '5550100001' }]);
  assert.deepEqual(plain(p.susVerdicts['5550100001']), []);
  fail = true;
  await p.susVote('5550100001', 'coached', 'call-1');
  assert.deepEqual(plain(p.susVerdicts['5550100001']), [], 'unchanged after a failed save');
  assert.equal(p.alerts.length, 1);
  const out = page({ me: null });
  await out.susVote('5550100001', 'coached', 'call-1');
  assert.equal(out.calls.length, 0, 'signed out: nothing sent');
});

test('Blocked in Canoe: tick and untick through the RPCs, recorded as you, now; a failure leaves it as it was; signed out: nothing sent', async () => {
  let fail = false;
  const p = page({ fetch: () => { if (fail) throw new Error('Supabase 401'); return null; } });
  await p.susSetBlocked('5550100001', true);
  assert.deepEqual(p.calls.at(-1), ['rpc/canoe_block_set', { p_caller: '5550100001' }]);
  assert.equal(p.susBlocks['5550100001'].blocked_by, 'me@example.com');
  assert.ok(Date.now() - new Date(p.susBlocks['5550100001'].blocked_at) < 5000);
  await p.susSetBlocked('5550100001', false);
  assert.deepEqual(p.calls.at(-1), ['rpc/canoe_block_clear', { p_caller: '5550100001' }]);
  assert.equal(p.susBlocks['5550100001'], null);
  fail = true;
  await p.susSetBlocked('5550100001', true);
  assert.equal(p.susBlocks['5550100001'], null, 'unchanged after a failed save');
  assert.equal(p.alerts.length, 1);
  const out = page({ me: null });
  await out.susSetBlocked('5550100001', true);
  assert.equal(out.calls.length, 0);
  assert.equal(out.alerts.length, 1);
});

test('verdicts and ticks load together, 100 callers a request', async () => {
  const p = page({ fetch: path => path.startsWith('canoe_blocks') ? [{ caller: '5550100002', blocked_by: 'luke@example.com', blocked_at: '2026-11-20T10:00:00Z' }] : [{ caller: '5550100001', decided_by: 'luke@example.com', verdict: 'coached' }] });
  await p.susFetchVerdicts(['5550100001', '5550100002', '5550100001', null]);
  assert.deepEqual(p.calls.map(c => c[0]), ['coached_verdicts?caller=in.(5550100001,5550100002)&select=caller,decided_by,verdict', 'canoe_blocks?caller=in.(5550100001,5550100002)&select=caller,blocked_by,blocked_at']);
  assert.equal(p.susVerdicts['5550100001'].length, 1); assert.deepEqual(plain(p.susVerdicts['5550100002']), []);
  assert.equal(p.susBlocks['5550100001'], null); assert.equal(p.susBlocks['5550100002'].blocked_by, 'luke@example.com');
  await p.susFetchVerdicts(['5550100001']);
  assert.equal(p.calls.length, 2, 'fetched once');
});

test('money: whole dollars with a sign', () => {
  const p = page();
  assert.equal(p.susMoney(1234.56), '$1,235');
  assert.equal(p.susMoney(-12.4), '-$12');
  assert.equal(p.susMoney('45'), '$45');
  assert.equal(p.susMoney(null), '$0');
});

const group = { caller: '5550100021', called_from: '+15550100021', calls: 3, distinct_zips: 2, distinct_verticals: 1, distinct_publishers: 2,
  zips: ['30301', '60601'], verticals: ['Pest'], publishers: ['A', 'B'], flagged: 0, last_call: '2026-11-19T15:00:00Z',
  call_ids: ['c3', 'c2', 'c1'], payin_30d: '105.50', payout_30d: '70', margin_30d: '35.50', total: 450 };

test('repeat callers: one Decide per caller, the 30-day margin on the row and in the why; capped lists say so; awaiting a verdict counts repeat callers only; calls load 25 at a time with a button for more', async () => {
  const loser = { ...group, caller: '5550100022', called_from: '+15550100022', payin_30d: '0', payout_30d: '5', margin_30d: '-5', total: 450,
    call_ids: Array.from({ length: 50 }, (_, i) => 'l' + i), calls: 80 };
  const p = page({ fetch: path => {
    if (path.startsWith('rpc/suspicious_repeat_callers')) return [group, loser];
    if (path.startsWith('coached_verdicts') || path.startsWith('canoe_blocks')) return [];
    if (path.startsWith('canoe_calls?id=in.')) return decodeURIComponent(path).match(/"[^"]+"/g).map(q => ({ id: q.slice(1, -1), called_from: '+15550100021', created_at: '2026-11-19T15:00:00Z', result: 'connected' }));
    return [];
  } });
  await p.susLoadRepeat();
  const h = p.els['sus-repeat'].innerHTML;
  assert.match(text(h), /Showing the 2 strongest of 450 numbers/);
  assert.equal((h.match(/data-susv="5550100021"/g) || []).length, 1, 'one Decide for the caller');
  assert.match(text(h), /3 connected calls in the last 30 days across 2 different ZIPs \(30301, 60601\), 2 publishers \(A, B\)\. Over the last 30 days its calls brought in \$106 from advertisers and cost \$70 in publisher payouts: a margin of \$36 ?\./);
  const summary = h.slice(0, h.indexOf('</summary>'));
  assert.match(summary, /<span class="sus-margin" title="Last 30 days, every call from this number: \$106 from advertisers minus \$70 to publishers">\$36 margin \/ 30d<\/span>/, 'the margin shows before the row is opened');
  assert.match(h, /<span class="sus-margin neg" title="[^"]*">-\$5 margin \/ 30d<\/span>/, 'a negative margin is marked');
  assert.match(text(summary), /3 calls across 2 ZIPs ?, 1 vertical and 2 publishers/);
  assert.equal(p.els['sus-stat-repeat'].innerHTML, '450');
  assert.equal(p.els['sus-stat-await'].innerHTML, '2');
  assert.equal(rpc(p, 'suspicious_repeat_callers')[0][1].cross_only, true);
  p.susVerdicts['5550100021'] = [{ decided_by: 'luke@example.com', verdict: 'not_coached' }]; p.susRenderRepeat();
  assert.equal(details(p.els['sus-repeat'].innerHTML), 1, 'decided caller hidden'); assert.equal(p.els['sus-stat-await'].innerHTML, '1');
  assert.match(text(p.els['sus-repeat'].innerHTML), /1 decided row is hidden/);
  p.susToggleHide(p.els['sus-hidedec']);
  assert.equal(details(p.els['sus-repeat'].innerHTML), 2, 'toggle restores it');

  // the first group's calls: all three, no per-call Decide
  const box = { dataset: { suscalls: '0' }, innerHTML: '', querySelector: () => null };
  const n = parseInt(p.els['sus-repeat'].innerHTML.match(/data-suscalls="(\d+)"/)[1], 10);
  await p.susLoadCalls(box, n);
  assert.equal(details(box.innerHTML), 3, 'each call opens to Listen and Read');
  assert.doesNotMatch(box.innerHTML, /data-susv=/, 'no per-call Decide inside a repeat group');
  assert.match(p.calls.at(-1)[0], /canoe_calls\?id=in\.\(%22c3%22,%22c2%22,%22c1%22\)/, 'ids quoted');
  assert.match(text(box.innerHTML), /call 3 of 3/);
  assert.doesNotMatch(box.innerHTML, /data-susmore/, 'nothing more to show');
  // the second group's: 25 of the newest 50, then 25 more, then the note that 30 older ones are not synced to the page
  const box2 = { dataset: {}, innerHTML: '', insertAdjacentHTML(_, h) { box2.innerHTML += h; },
    querySelector: sel => sel === '[data-susmore]' && /data-susmore/.test(box2.innerHTML) ? { remove: () => { box2.innerHTML = box2.innerHTML.replace(/<div class="[^"]*" data-susmore>.*$/, ''); } } : null };
  await p.susLoadCalls(box2, n + 1);
  assert.equal(details(box2.innerHTML), 25);
  assert.match(box2.innerHTML, /<button[^>]*onclick="susMoreCalls\(this,\d+\)">Show the next 25 of 25 more calls<\/button>/);
  assert.match(text(box2.innerHTML), /call 25 of 80/);
  box2.dataset.done = '';
  await p.susLoadCalls(box2, n + 1);
  assert.equal(details(box2.innerHTML), 50);
  assert.match(text(box2.innerHTML), /call 50 of 80/);
  assert.match(text(box2.innerHTML), /The newest 50 of 80 calls\./);
  assert.doesNotMatch(box2.innerHTML, /susMoreCalls/);
});

test('transcript keywords: trimmed, lower case, no blanks or repeats; AND through the RPC with the agent; highlighted in the snippet and the transcript; Hide decided; the agent pick re-runs a search', async () => {
  const row = (id, caller, extra) => ({ id, caller, called_from: '+1' + caller, created_at: '2026-11-25T10:00:00Z', ivr_name: 'Pest IVR old', agent_key: 'Pest IVR', vertical_name: 'Pest', publisher_name: 'A',
    zip: '30301', duration: 250, our_outcome: 'appointment', our_summary: 'Spiders.', snippet: 'Caller: I have SPIDERS in the house, and cockroaches in the kitchen.', total: 2, ...extra });
  const rows = [row('k1', '5550100031'), row('k2', '5550100032', { snippet: '…spiders (small) and cockroaches…' })];
  const p = page({ fetch: path => path.startsWith('rpc/suspicious_transcript_search') ? rows : path.startsWith('canoe_calls?id=eq.') ? [{ transcription: 'A: hi\nC: Spiders & cockroaches. <b>Spider</b>', our_summary: 'S.' }] : [] });
  p.suspiciousInit();
  assert.equal(p.els['sus-kw-agent'].innerHTML, '<option value="">All agents</option><option value="Pest IVR">Pest Pro</option><option value="Roof IVR">Roof IVR</option>', 'the agents, by display name');
  assert.match(p.els['sus-kw-inputs'].innerHTML, /^<span class="sus-kw"><input type="text" class="settings-input" placeholder="e.g. spiders" aria-label="Keyword 1" value="" oninput="susKw\[0\]=this.value"><\/span>$/, 'one box, no AND, no remove');
  assert.match(text(p.els['sus-keywords'].innerHTML), /Type a keyword and press Search/);
  p.kw(['', '  ']); await p.susRunSearch();
  assert.equal(rpc(p, 'suspicious_transcript_search').length, 0, 'blank keywords: no request');
  assert.match(text(p.els['sus-keywords'].innerHTML), /Type at least one keyword, then press Search/);
  p.kw([' Spiders ', '', 'cockroaches', 'SPIDERS']); p.susRenderKwBar();
  assert.deepEqual(plain(p.susKeywords()), ['spiders', 'cockroaches']);
  assert.equal((p.els['sus-kw-inputs'].innerHTML.match(/class="sus-and">AND</g) || []).length, 3);
  assert.equal((p.els['sus-kw-inputs'].innerHTML.match(/susRemoveKw\(\d\)/g) || []).length, 3, 'every box but the first can go');
  await p.susRunSearch();
  const req = rpc(p, 'suspicious_transcript_search').at(-1)[1];
  assert.deepEqual(req.keywords, ['spiders', 'cockroaches']); assert.equal(req.agent_key, null);
  assert.match(req.from_ts, /^\d{4}-\d{2}-\d{2}T/);
  let h = p.els['sus-keywords'].innerHTML;
  assert.equal(details(h), 2);
  assert.equal(p.els['sus-ct-keywords'].textContent, '(2)');
  assert.match(text(h), /2 connected calls mention "spiders" and "cockroaches" in the last 30 days\./);
  assert.match(h, /<div class="sus-line2">Caller: I have <mark>SPIDERS<\/mark> in the house, and <mark>cockroaches<\/mark> in the kitchen\.<\/div>/, 'the snippet, marked');
  assert.match(h, /<mark>spiders<\/mark> \(small\) and <mark>cockroaches<\/mark>/);
  assert.match(h, /data-suskw="\[&quot;spiders&quot;,&quot;cockroaches&quot;\]"/, 'the row remembers what to highlight');
  assert.match(text(h), /Pest Pro · Pest · A · ZIP 30301/);
  assert.match(text(h), /The transcript mentions "spiders" and "cockroaches" ?\. The words are highlighted in step 2\./);
  assert.equal((h.match(/data-susv="5550100031"/g) || []).length, 1, 'each result has its own Decide');
  // the transcript, once a row opens: escaped first, then marked in one pass (no mark inside a mark)
  const tx = { dataset: {}, innerHTML: '' };
  await p.susOpenCallRow({ dataset: { suskw: '["spiders","cockroaches","b"]' }, querySelector: () => tx }, 'k1');
  assert.equal(tx.innerHTML, '<b>AI summary: S.</b>A: hi\nC: <mark>Spiders</mark> &amp; <mark>cockroaches</mark>. &lt;<mark>b</mark>&gt;Spider&lt;/<mark>b</mark>&gt;', '"spiders" does not match "Spider"; tags stay escaped');
  assert.equal(p.susMark('a.b (c) a.b', ['a.b', '(c']), '<mark>a.b</mark> <mark>(c</mark>) <mark>a.b</mark>', 'regex characters in a keyword are literal');
  // Hide decided applies
  p.susVerdicts['5550100031'] = [{ decided_by: 'luke@example.com', verdict: 'coached' }]; p.susRenderKeywords();
  assert.equal(details(p.els['sus-keywords'].innerHTML), 1); assert.match(text(p.els['sus-keywords'].innerHTML), /1 decided row is hidden/);
  assert.equal(p.els['sus-ct-keywords'].textContent, '(2)', 'the count is before Hide decided');
  // the agent pick re-runs the search with the agent; a capped list says so
  rows[0].total = rows[1].total = 900;
  p.els['sus-kw-agent'].value = 'Pest IVR';
  await p.susRunSearch();
  assert.equal(rpc(p, 'suspicious_transcript_search').at(-1)[1].agent_key, 'Pest IVR');
  assert.match(text(p.els['sus-keywords'].innerHTML), /900 connected calls mention "spiders" and "cockroaches" for Pest Pro in the last 30 days\. Showing the newest 2\./);
  // removing a box re-runs; Clear empties everything
  const before = rpc(p, 'suspicious_transcript_search').length;
  p.susRemoveKw(2);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(plain(p.getKw()), [' Spiders ', '', 'SPIDERS']); assert.equal(rpc(p, 'suspicious_transcript_search').length, before + 1);
  p.susClearKw();
  assert.deepEqual(plain(p.getKw()), ['']); assert.equal(p.searched(), false); assert.equal(p.els['sus-kw-agent'].value, '');
  assert.match(text(p.els['sus-keywords'].innerHTML), /Type a keyword and press Search/);
  assert.equal(p.els['sus-ct-keywords'].textContent, '');
});

const coachedCalls = [
  { caller: '5550100041', id: 'a1', created_at: '2026-11-25T10:00:00Z', called_from: '+15550100041', ivr_name: 'Pest IVR old', agent_key: 'Pest IVR', vertical_name: 'Pest', publisher_name: 'A', advertiser_name: 'Adv 1', zip: '30301', duration: 250, result: 'connected', our_outcome: 'appointment', our_summary: 'Spiders, "big" ones.' },
  { caller: '5550100041', id: 'a2', created_at: '2026-11-24T10:00:00Z', called_from: '+15550100041', ivr_name: 'Roof IVR', agent_key: 'Roof IVR', vertical_name: 'Roofing', publisher_name: 'B', advertiser_name: 'Adv 2', zip: '60601', duration: 240, result: 'connected', our_outcome: 'quoted', our_summary: '=leak' },
  { caller: '5550100041', id: 'a3', created_at: '2026-11-24T11:00:00Z', called_from: '+15550100041', ivr_name: 'Pest IVR', agent_key: 'Pest IVR', vertical_name: 'Pest', publisher_name: 'A', advertiser_name: 'Adv 1', zip: '30301', duration: 0, result: 'abandoned', our_outcome: null, our_summary: null },
  { caller: '5550100042', id: 'b1', created_at: '2026-11-20T10:00:00Z', called_from: '+15550100042', ivr_name: 'Pest IVR', agent_key: 'Pest IVR', vertical_name: 'Pest', publisher_name: 'B', advertiser_name: 'Adv 1', zip: '77001', duration: 900, result: 'connected', our_outcome: 'appointment', our_summary: 'Termites.' },
  { caller: '5550100043', id: 'c1', created_at: '2026-09-01T10:00:00Z', called_from: '+15550100043', ivr_name: null, agent_key: null, vertical_name: null, publisher_name: 'C', advertiser_name: null, zip: null, duration: 100, result: 'connected', our_outcome: null, our_summary: null },
];

test('coached caller stats: connected calls in the window by vertical and by publisher, distinct callers then calls, most callers first; empty state', async () => {
  const p = page({ fetch: path => path.startsWith('rpc/suspicious_coached_calls') ? coachedCalls : [] });
  const now = Date.now;
  Date.now = () => new Date('2026-11-28T12:00:00Z').getTime();
  try {
    await p.susLoadCoached();
    const h = p.els['sus-stats'].innerHTML;
    assert.match(text(h), /3 coached callers so far; 2 of them made 3 connected calls in the last 30 days\./, 'the abandoned call and the September caller are out');
    assert.match(h, /<h4>By vertical<\/h4><div class="sus-statrow"><span class="sus-statname" title="Pest">Pest<\/span><span class="sus-bar"><i style="width:100%"><\/i><\/span><span class="sus-statnum"><b>2<\/b> callers · 2 calls<\/span><\/div><div class="sus-statrow"><span class="sus-statname" title="Roofing">Roofing<\/span><span class="sus-bar"><i style="width:50%"><\/i><\/span><span class="sus-statnum"><b>1<\/b> caller · 1 call<\/span><\/div><\/div>/);
    assert.match(h, /<h4>By publisher<\/h4><div class="sus-statrow"><span class="sus-statname" title="B">B<\/span>.*<b>2<\/b> callers · 2 calls<\/span><\/div><div class="sus-statrow"><span class="sus-statname" title="A">A<\/span>.*<b>1<\/b> caller · 1 call/s, 'most callers first: B (two callers) before A (one)');
    p.els['sus-days'].value = '7'; p.susRenderStats();
    assert.match(text(p.els['sus-stats'].innerHTML), /3 coached callers so far; 1 of them made 2 connected calls in the last 7 days\./);
    assert.deepEqual(plain(p.susTally([{ caller: 'x', vertical_name: null }, { caller: 'y', vertical_name: 'V' }, { caller: 'y', vertical_name: 'V' }], c => c.vertical_name)),
      [{ name: 'V', callers: 1, calls: 2 }, { name: '(none)', callers: 1, calls: 1 }]);
  } finally { Date.now = now; }
  const empty = page({ fetch: () => [] });
  await empty.susLoadCoached();
  assert.match(text(empty.els['sus-stats'].innerHTML), /No callers are marked Agree \(coached caller\) yet\./);
});

const decidedCoached = [
  { caller: '5550100041', called_from: '+15550100041', calls: 3, verticals: ['Pest', 'Roofing'], first_call: '2026-11-24T10:00:00Z', last_call: '2026-11-25T10:00:00Z', call_ids: ['a1', 'a3', 'a2'],
    verdicts: [{ by: 'luke@example.com', verdict: 'coached', at: '2026-11-25T12:00:00Z' }, { by: 'me@example.com', verdict: 'not_coached', at: '2026-11-25T13:30:00Z' }],
    blocked_by: 'luke@example.com', blocked_at: '2026-11-25T14:00:00Z',
    calls_30d: 2, zips_30d: ['30301', '60601'], verticals_30d: ['Pest', 'Roofing'], publishers_30d: ['A', 'B'], payin_30d: '90', payout_30d: '55', margin_30d: '35', total: 3 },
  { caller: '5550100042', called_from: '+15550100042', calls: 1, verticals: ['Pest'], first_call: '2026-11-20T10:00:00Z', last_call: '2026-11-20T10:00:00Z', call_ids: ['b1'],
    verdicts: [{ by: 'luke@example.com', verdict: 'coached', at: '2026-11-21T12:00:00Z' }], blocked_by: null, blocked_at: null,
    calls_30d: 1, zips_30d: ['77001'], verticals_30d: ['Pest'], publishers_30d: ['B'], payin_30d: '20', payout_30d: '10', margin_30d: '10', total: 3 },
  { caller: '5550100043', called_from: '+15550100043', calls: 1, verticals: [], first_call: '2026-09-01T10:00:00Z', last_call: '2026-09-01T10:00:00Z', call_ids: ['c1'],
    verdicts: [{ by: 'luke@example.com', verdict: 'coached', at: '2026-11-21T12:00:00Z' }], blocked_by: null, blocked_at: null,
    calls_30d: 0, zips_30d: [], verticals_30d: [], publishers_30d: [], payin_30d: '0', payout_30d: '0', margin_30d: '0', total: 3 },
];

test('Decided lists: the button opens the list in place of the queue, every caller with that verdict, the Canoe tick on each, the why, one Decide; the export only on Coached call; the button again or Back returns', async () => {
  const p = page({ fetch: path => path.startsWith('rpc/suspicious_decided_callers') ? plain(decidedCoached) : [] });
  p.susShowDecided('coached');
  assert.equal(p.view(), 'coached');
  assert.equal(p.els['sus-view-queue'].style.display, 'none'); assert.equal(p.els['sus-view-decided'].style.display, '');
  assert.equal(p.els['sus-dec-coached'].attrs['aria-pressed'], 'true'); assert.ok(p.els['sus-dec-coached'].classList.contains('active'));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(rpc(p, 'suspicious_decided_callers')[0][1], { p_verdict: 'coached' });
  assert.equal(p.els['sus-dec-title'].textContent, 'Decided: coached call (3)');
  assert.equal(p.els['sus-dec-sub'].textContent, '1 of 3 blocked in Canoe. Open a caller to change the verdict or tick the box.');
  assert.equal(p.els['sus-export'].style.display, '', 'the export strip shows');
  assert.equal(p.els['sus-dec-ct-coached'].textContent, '3');
  const h = p.els['sus-decided'].innerHTML;
  assert.equal(details(h), 3);
  assert.match(h, /sus-sev-hot">coached</);
  assert.match(text(h), /\+15550100041 Pest, Roofing 3 calls · luke@example.com: Agree \(Nov 25\), me@example.com: Disagree \(Nov 25\) last Nov 25,.*✓ Blocked in Canoe/);
  assert.match(h, /<span data-susblock="5550100041"><span class="sus-bchip yes"/);
  assert.match(h, /<span data-susblock="5550100042"><span class="sus-bchip no">Not blocked in Canoe<\/span><\/span>/);
  assert.match(text(h), /This number had 2 connected calls in the last 30 days across 2 different ZIPs \(30301, 60601\), 2 verticals \(Pest, Roofing\), 2 publishers \(A, B\)\. Over the last 30 days its calls brought in \$90 from advertisers and cost \$55 in publisher payouts: a margin of \$35 ?\./);
  assert.match(text(h), /This number had 0 connected calls in the last 30 days\. Over the last 30 days its calls brought in \$0 from advertisers and cost \$0 in publisher payouts: a margin of \$0 ?\./, 'an old caller still gets the sentence');
  assert.equal((h.match(/data-susv="5550100041"/g) || []).length, 1);
  assert.match(h, /data-susv="5550100041" data-suscall="a1"/, 'the newest call is the one a verdict cites');
  assert.match(h, /<label class="sus-block on" [^>]*><input type="checkbox" checked onchange="susSetBlocked\('5550100041',this.checked\)">/, 'the caches are filled from the list');
  assert.deepEqual(plain(p.susVerdicts['5550100041'].map(r => r.decided_by + ':' + r.verdict)), ['luke@example.com:coached', 'me@example.com:not_coached']);
  assert.match(h, /aria-pressed="true"[^>]*>Disagree<span class="ct">1<\/span>/, 'your own verdict is pressed');
  // the tick from inside the list updates the sub line
  await p.susSetBlocked('5550100042', true);
  assert.equal(p.els['sus-dec-sub'].textContent, '2 of 3 blocked in Canoe. Open a caller to change the verdict or tick the box.');
  // the Unknown list: no export
  p.susShowDecided('unknown');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(rpc(p, 'suspicious_decided_callers').at(-1)[1], { p_verdict: 'unknown' });
  assert.equal(p.els['sus-export'].style.display, 'none');
  assert.equal(p.els['sus-dec-coached'].attrs['aria-pressed'], 'false'); assert.equal(p.els['sus-dec-unknown'].attrs['aria-pressed'], 'true');
  assert.match(p.els['sus-decided'].innerHTML, /sus-sev-warm">unknown</);
  assert.doesNotMatch(p.els['sus-decided'].innerHTML, /Why it's here/);
  // the same button again: back to the queue
  p.susShowDecided('unknown');
  assert.equal(p.view(), null);
  assert.equal(p.els['sus-view-queue'].style.display, ''); assert.equal(p.els['sus-view-decided'].style.display, 'none');
  assert.equal(p.els['sus-dec-unknown'].attrs['aria-pressed'], 'false');
  const empty = page({ fetch: () => [] });
  empty.susShowDecided('coached');
  await new Promise(r => setTimeout(r, 0));
  assert.match(text(empty.els['sus-decided'].innerHTML), /No callers marked as a coached call yet\./);
  assert.equal(empty.els['sus-export'].style.display, 'none');
  assert.equal(empty.els['sus-dec-title'].textContent, 'Decided: coached call (0)');
});

test('CSV: one row per call of every coached caller, newest first, the columns in order, every cell quoted, formulas neutralised, the caller as digits, local date and time; the file name has the date and no number', () => {
  const p = page();
  const out = p.susCsv(decidedCoached, coachedCalls);
  assert.equal(out.calls, 5);
  const lines = out.text.split('\r\n');
  assert.equal(lines[0], '﻿"caller_number","why_its_here","verdicts","blocked_in_canoe","blocked_by","blocked_on","caller_payin_30d","caller_payout_30d","caller_margin_30d","call_id","call_date_time","agent","vertical","publisher","advertiser","zip","duration_seconds","outcome","ai_summary"');
  const cells = l => l.match(/"(?:[^"]|"")*"/g).map(c => c.slice(1, -1).replace(/""/g, '"'));
  const r1 = cells(lines[1]), r2 = cells(lines[2]), r3 = cells(lines[3]), r4 = cells(lines[4]), r5 = cells(lines[5]);
  assert.equal(r1[0], '5550100041', 'the caller is its digits key: no + sign, so nothing to neutralise');
  assert.equal(r1[1], 'This number had 2 connected calls in the last 30 days across 2 different ZIPs (30301, 60601), 2 verticals (Pest, Roofing), 2 publishers (A, B). Over the last 30 days its calls brought in $90 from advertisers and cost $55 in publisher payouts: a margin of $35.');
  assert.equal(r1[2], `luke@example.com: Agree (${p.susStamp('2026-11-25T12:00:00Z')}); me@example.com: Disagree (${p.susStamp('2026-11-25T13:30:00Z')})`);
  assert.deepEqual(r1.slice(3, 9), ['yes', 'luke@example.com', p.susStamp('2026-11-25T14:00:00Z'), '90', '55', '35']);
  assert.deepEqual(r1.slice(9), ['a1', p.susStamp('2026-11-25T10:00:00Z'), 'Pest Pro', 'Pest', 'A', 'Adv 1', '30301', '250', 'appointment', 'Spiders, "big" ones.'], 'the agent by display name, aliases resolved; a quote is doubled');
  assert.ok(lines[1].endsWith(',"Spiders, ""big"" ones."'));
  assert.deepEqual([r1[9], r2[9], r3[9]], ['a1', 'a3', 'a2'], 'newest first within a caller, every result');
  assert.equal(r3[18], "'=leak", 'a cell starting with = gets an apostrophe');
  assert.deepEqual(r3.slice(12, 14), ['Roofing', 'B']);
  assert.deepEqual([r4[0], r4[3], r4[4], r4[5], r4[11]], ['5550100042', 'no', '', '', 'Pest Pro']);
  assert.deepEqual([r5[0], r5[11], r5[12], r5[15], r5[18]], ['5550100043', '', '', '', ''], 'empty fields stay empty');
  assert.equal(lines.length, 6);
  assert.match(p.susStamp('2026-11-25T10:05:00Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(p.susCsvCell('+15550100041'), '"\'+15550100041"'); assert.equal(p.susCsvCell('-5'), '"\'-5"'); assert.equal(p.susCsvCell('@x'), '"\'@x"'); assert.equal(p.susCsvCell('\tx'), '"\'\tx"');
  assert.equal(p.susCsvCell(null), '""'); assert.equal(p.susCsvCell('a "b"'), '"a ""b"""');
  assert.match(p.susCsvName(), /^coached-callers-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(p.susCsv(null, coachedCalls), null);
  assert.doesNotMatch(SRC.slice(SRC.indexOf('Export CSV (MK-199)')), /transcription|recording_url/, 'no transcript or recording link in the export');
});

test('each section fails on its own with the standard load error', async () => {
  const p = page({ fetch: path => { if (path.startsWith('rpc/suspicious_coached_calls') || path.startsWith('rpc/suspicious_transcript_search') || path.startsWith('rpc/suspicious_decided_callers')) throw new Error('Supabase 404'); return []; } });
  p.kw(['spiders']);
  await Promise.all([p.susLoadRepeat(), p.susLoadCoached(), p.susRunSearch(), p.susLoadDecidedCounts()]);
  assert.match(p.els['sus-stats'].innerHTML, /Couldn't load the coached caller stats/);
  assert.match(p.els['sus-keywords'].innerHTML, /Couldn't load the transcript search/);
  assert.match(text(p.els['sus-repeat'].innerHTML), /No cross-ZIP\/vertical\/publisher repeat callers in this window/);
  assert.equal(p.els['sus-stat-repeat'].innerHTML, '0');
  assert.equal(p.els['sus-dec-ct-coached'].textContent, '0');
  p.susShowDecided('coached');
  await new Promise(r => setTimeout(r, 0));
  assert.match(p.els['sus-decided'].innerHTML, /Couldn't load the decided callers/);
  const counts = page({ fetch: path => { if (path.startsWith('coached_verdicts?verdict')) throw new Error('Supabase 500'); return []; } });
  await counts.susLoadDecidedCounts();
  assert.equal(counts.els['sus-dec-ct-coached'].textContent, '', 'no count rather than a wrong one');
});

test('a reload refreshes the repeat callers, the stats and the counts, and the search only once one was run', async () => {
  const p = page({ fetch: () => [] });
  await p.susReload();
  assert.deepEqual(p.calls.map(c => c[0]).sort(), ['coached_verdicts?verdict=in.(coached,unknown)&select=caller,verdict', 'rpc/suspicious_coached_calls', 'rpc/suspicious_repeat_callers']);
  p.kw(['spiders']); await p.susRunSearch();
  p.calls.length = 0;
  await p.susReload();
  assert.ok(rpc(p, 'suspicious_transcript_search').length === 1);
});

test('page wiring: nav tab, switchTab hook, three sub-tabs, the Decided buttons, no Odd timing, only the 069/070/071 RPCs and tables', () => {
  assert.match(html, /<button class="nav-tab" onclick="switchTab\('suspicious',this\)">Suspicious<\/button>/);
  assert.match(html, /if \(id === 'suspicious'\) suspiciousInit\(\);/);
  assert.match(html, /<div id="tab-suspicious" class="tab-pane">/);
  const tab = html.slice(html.indexOf('<div id="tab-suspicious"'), html.indexOf('<!-- Manual CSV-upload panel'));
  assert.deepEqual([...tab.matchAll(/class="comp-subtab[^"]*" onclick="susSub\('(\w+)'/g)].map(m => m[1]), ['repeat', 'keywords', 'stats']);
  assert.doesNotMatch(tab, /sus-pane-timing|Odd timing|sus-pct|sus-timing-agent|calls over typical|sus-stat-timing|sus-pane-script|Same script/);
  assert.match(tab, /<span class="sus-label">Decided:<\/span>\s*<button type="button" id="sus-dec-coached" class="sus-decbtn coached" aria-pressed="false" onclick="susShowDecided\('coached'\)"/);
  assert.match(tab, /<button type="button" id="sus-dec-unknown" class="sus-decbtn unknown" aria-pressed="false" onclick="susShowDecided\('unknown'\)"/);
  assert.match(tab, /id="sus-export" style="display:none">\s*<button type="button" class="sus-exportbtn" onclick="susExportCsv\(\)">Export CSV<\/button>/);
  assert.match(text(tab), /The file contains caller phone numbers\. Keep it on your work computer and don't email or upload it\./);
  assert.match(tab, /<form class="sus-kwbar" onsubmit="event.preventDefault\(\);susRunSearch\(\)">/);
  assert.doesNotMatch(SRC, /suspicious_odd_timing|susLoadOdd|pct_above|script_matches|suspicious_conversions|became an appointment or sale/);
  const used = new Set([...SRC.matchAll(/sbFetch\(\s*[`'](rpc\/\w+|\w+)/g)].map(m => m[1]));
  assert.deepEqual([...used].sort(), ['canoe_blocks', 'canoe_calls', 'coached_verdicts', 'rpc/canoe_block_clear', 'rpc/canoe_block_set', 'rpc/coached_verdict_clear',
    'rpc/coached_verdict_set', 'rpc/suspicious_coached_calls', 'rpc/suspicious_decided_callers', 'rpc/suspicious_repeat_callers', 'rpc/suspicious_transcript_search']);
  const css = html.slice(0, html.indexOf('</style>'));
  for (const c of ['.sus-decbtn.coached', '.sus-decbtn.unknown', '.sus-block.on', '.sus-bchip.yes', '.sus-kwbar', '.sus-statgrid', '.sus-export', '.sus-tx mark']) assert.ok(css.includes(c), c);
  assert.ok(!css.includes('.sus-pct'));
});
