// Agent quality in the page (agent_call_evals, migration 056): Review rows, filters, KPI tallies,
// the expanded assessment, and the Agents-tab rollup. index.html has no build step, so the code is
// lifted out of the page and run with stubs. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// Source of a top-level `function name(` / `async function name(` declaration, by brace matching.
function lift(decl) {
  const start = html.indexOf(decl);
  assert.ok(start >= 0, `${decl} not found in index.html`);
  let i = html.indexOf('{', start + html.slice(start).search(/\)\s*\{/)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(start, i + 1);
}
// A top-level `const|let NAME = ...;` statement (single statement, may span lines).
function liftConst(name) {
  const m = html.match(new RegExp(`\\n(?:const|let) ${name} *=[\\s\\S]*?;\\n`));
  assert.ok(m, `${name} not found in index.html`);
  return m[0].replace(/^\n(let|const)/, 'var');
}
const AE_CONSTS = ['aeAvailable', 'AE_COLS', 'aeMissing', 'aeOf', 'AE_VERDICT', 'AE_STAGE', 'AE_DV', 'AE_ANS', 'AE_UNDERSTANDING', 'AE_SCRIPT', 'AE_FLAG', 'AE_FILTERS', 'aeDefectRate', 'aeQSeq'];
const AE_FUNCS = ['function aeDecisionLabel(', 'function aeFinding(', 'function aeRowParts(', 'function aeDetailHtml(', 'function aeMarkQuotes(',
  'function aeTallyBlank(', 'function aeTally(', 'function aeCallQuery(', 'function aeAdd(', 'function aeCardLine(', 'function aeDrawerHtml(',
  'function esc(', 'function nullMark(', 'function labelOf(', 'function fmtPct(', 'function fmtDate('];
function load(extra = {}, more = []) {
  const ctx = { console, activeRange: { label: 'Oct 14 – Nov 12' }, ...extra };
  vm.runInNewContext(AE_CONSTS.map(liftConst).join('\n') + '\n' + AE_FUNCS.concat(more).map(lift).join(';\n'), ctx);
  return ctx;
}
const unhtml = s => s.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const MAJOR = {
  verdict: 'major', decision: 'rejected', decision_verdict: 'over_reject', dropoff_stage: 'none', drop_reason: 'none',
  understanding: 'mishears', script: 'good', agent_flags: [], summary: 'Rejected a caller who said they got it off the TV.',
  top_issue: "Treat 'I got it off the TV' as the caller placing the call.",
  eval: { decision_reason: 'Caller placed the call.', caller_need: 'life insurance', intent_match: 'no_intent', disposition_matches_transcript: 'no',
    rules_registered: true, rules: [{ rule: 'Caller placed this call themselves', asked: true, answer: 'pass' }, { rule: 'Caller age', asked: false, answer: 'not_asked' }],
    evidence: [{ finding: 'over_reject', quote: 'Nope. I got it off the TV.' }] },
};

test('Review row: verdict + one finding chip and the agent-review summary; nothing for unscored or unavailable (S-40, S-41, S-42)', () => {
  const ctx = load();
  const p = ctx.aeRowParts({ id: 'c1', agent_call_evals: MAJOR });
  assert.equal(unhtml(p.chips).trim(), 'Major issue Over-rejected', 'the decision chip moved to the expanded panel');
  assert.equal((p.chips.match(/class="rv-chip/g) || []).length, 2, 'two chips at most');
  assert.match(p.chips, /rv-chip neg rv-ae-verdict/);
  assert.equal(p.summary, MAJOR.summary);
  assert.doesNotMatch(p.chips + p.summary, /AI agent review|Fix:/, 'no per-row "AI ..." label; the fix is in the expanded panel');
  assert.equal(ctx.aeRowParts({ id: 'c2', agent_call_evals: null }), null, 'unscored: no "not scored yet" chip');
  assert.equal(unhtml(ctx.aeRowParts({ id: 'c3', agent_call_evals: [{ ...MAJOR, verdict: 'good', decision: 'transferred', decision_verdict: 'correct' }] }).chips).trim(),
    'Handled well', 'array-shaped embed works too; a good call has no finding chip');
  assert.equal(unhtml(ctx.aeRowParts({ id: 'c4', agent_call_evals: { ...MAJOR, verdict: 'no_conversation', decision: 'caller_left', dropoff_stage: 'intro', decision_verdict: 'not_applicable', understanding: null } }).chips).trim(),
    'No conversation Stated reason wrong', 'verdict + the one finding (here the stated-reason check); "Caller left at intro" is in the panel');
  ctx.aeAvailable = false;
  assert.equal(ctx.aeRowParts({ id: 'c1', agent_call_evals: MAJOR }), null);
});

test('Review filters are server-side embeds: inner join for a filter, anti-join for "Not scored"', () => {
  const ctx = load();
  assert.deepEqual({ ...ctx.aeCallQuery('all') }, { sel: `,agent_call_evals(${ctx.AE_COLS})`, q: '' });
  assert.deepEqual({ ...ctx.aeCallQuery('needs') }, { sel: `,agent_call_evals!inner(${ctx.AE_COLS})`, q: '&agent_call_evals.verdict=in.(major,minor)' });
  assert.deepEqual({ ...ctx.aeCallQuery('over_reject') }, { sel: `,agent_call_evals!inner(${ctx.AE_COLS})`, q: '&agent_call_evals.decision_verdict=eq.over_reject' });
  assert.deepEqual({ ...ctx.aeCallQuery('unscored') }, { sel: `,agent_call_evals(${ctx.AE_COLS})`, q: '&agent_call_evals=is.null' });
  ctx.aeAvailable = false;
  assert.deepEqual({ ...ctx.aeCallQuery('needs') }, { sel: '', q: '' });
});

test('KPI tallies: defect / handled-well over conversations, no_conversation is an intro drop-off', () => {
  const ctx = load();
  const t = ctx.aeTallyBlank();
  for (const ev of [MAJOR, { ...MAJOR, verdict: 'good', decision_verdict: 'correct', understanding: 'smooth' },
    { verdict: 'no_conversation', decision_verdict: 'not_applicable', dropoff_stage: 'intro' },
    { verdict: 'minor', decision_verdict: 'correct', dropoff_stage: 'mid_qualification', understanding: 'pauses', script: 'too_long' }, null]) ctx.aeTally(t, ev);
  assert.deepEqual({ ...t }, { scored: 4, conv: 3, good: 1, minor: 1, major: 1, over_reject: 1, over_transfer: 0, drop_intro: 1, drop_mid: 1, drop_transfer: 0,
    mishears: 1, pauses: 1, stuck: 0, too_long: 1, late_dq: 0, missing: 0 });
  const counts = Object.fromEntries(ctx.AE_FILTERS.filter(f => f.n).map(f => [f.k, f.n(t, 10)]));
  assert.deepEqual(counts, { needs: 2, over_reject: 1, over_transfer: 0, dropoff: 2, unscored: 6 });
});

test('Expanded row: rule checklist, findings, evidence and the disagree toggle; rule-less agents are not judged on rules', () => {
  const ctx = load({ jsStr: s => s });
  const d = ctx.aeDetailHtml({ id: 'PH1', agent_call_evals: MAJOR }, 3, true);
  assert.match(d, /id="rv-ae-3"/);
  assert.match(unhtml(d), /Decision Rejected, over-rejected Caller placed the call\./);
  assert.match(unhtml(d), /Stated reason Not supported by the transcript/);
  assert.match(unhtml(d), /Understanding Mishears \/ repeats/);
  assert.match(unhtml(d), /Pass Caller placed this call themselves Not asked Caller age/);
  assert.match(unhtml(d), /Evidence "Nope\. I got it off the TV\."/);
  assert.match(unhtml(d), /^ Agent quality AI was wrong Suggested fix Treat 'I got it off the TV' as the caller placing the call\. Decision/, 'the fix moved here from the row');
  assert.match(d, /<button type="button" class="rv-check rv-ae-disagree on" aria-pressed="true" onclick="rvToggleDisagree\('PH1',this\)"[^>]*>AI was wrong<\/button>/, 'a real toggle button (S-46)');
  assert.doesNotMatch(d, /display:none|☐|☑|AI got this wrong/, 'the Details panel shows and hides it, no glyph toggle');
  const noRules = unhtml(ctx.aeDetailHtml({ id: 'PH2', agent_call_evals: { ...MAJOR, eval: { ...MAJOR.eval, rules_registered: false } } }, 4, false));
  assert.match(noRules, /No registered qualifying rules: this agent is not judged on rules until rules are added\. Questions it asked:/);
  assert.doesNotMatch(noRules, /Pass Caller placed/);
  assert.match(ctx.aeDetailHtml({ id: 'PH2', agent_call_evals: MAJOR }, 4, false), /<button type="button" class="rv-check rv-ae-disagree" aria-pressed="false"/);
  assert.equal(ctx.aeDetailHtml({ id: 'PH3', agent_call_evals: null }, 5, false), '');
});

test('Evidence quotes are highlighted in the escaped transcript, and stay escaped', () => {
  const ctx = load();
  const tx = 'bot:Did you place this call?\nhuman:Nope. I got it off the TV. <b>';
  const out = ctx.aeMarkQuotes(ctx.esc(tx), { agent_call_evals: { ...MAJOR, eval: { evidence: [{ quote: 'Nope. I got it off the TV.' }, { quote: '<script>' }, { quote: 'no' }] } } });
  assert.match(out, /human:<mark>Nope\. I got it off the TV\.<\/mark> &lt;b&gt;/);
  assert.doesNotMatch(out, /<script>|<b>/);
});

test('Agents tab: card line, drawer strip with the rule-less note, and the Defect rate sort', () => {
  const ctx = load({}, ['function getSorted(']);
  const q = ctx.aeAdd({}, { scored: '40', conversations: '30', good: '21', minor: '3', major: '6', over_transfer: '1', over_reject: '4', drop_intro: '12', drop_mid: '3', drop_transfer: '1', disagree: '2' });
  const a = { name: 'Medicare - Aragon', qualifying: [], q, _tiKey: 'Oct 14 – Nov 12', _topIssues: [{ top_issue: 'Ask one follow-up before rejecting.', call_at: '2026-11-05T22:06:05Z' }] };
  assert.match(unhtml(ctx.aeCardLine(a)), /Agent quality 70\.0% handled well 20\.0% defects/);
  assert.match(ctx.aeCardLine(a), /<b class="neg">20\.0%<\/b>/, '20%+ defects in coral');
  const d = unhtml(ctx.aeDrawerHtml(a));
  assert.match(d, /40 Calls scored 70\.0% Handled well 20\.0% Defect rate 3\.3% Over-transfer 13\.3% Over-reject 30\.0% Drop-off at intro \(mid 7\.5% · transfer 2\.5%\) 2 AI marked wrong/);
  assert.match(d, /No registered qualifying rules: calls are not judged on rules until rules are added\./);
  assert.match(d, /Recent fixes Ask one follow-up before rejecting\./);
  assert.match(d, /^ Agent quality 40 Calls scored/, 'heading is just "Agent quality"; the range is in the drawer meta line');
  assert.equal(ctx.aeCardLine({ q: null }), '');
  assert.match(unhtml(ctx.aeDrawerHtml({ qualifying: ['x'], q: null })), /No calls scored in this period yet\./);

  ctx.document = { getElementById: () => ({ value: 'defects' }) };
  const agents = [
    { name: 'Unscored', raw_calls: 900, q: null },
    { name: 'Clean', raw_calls: 10, q: { conversations: 10, major: 0 } },
    { name: 'Worst', raw_calls: 5, q: { conversations: 10, major: 4 } },
    { name: 'Some', raw_calls: 50, q: { conversations: 10, major: 1 } },
  ];
  assert.deepEqual([...ctx.getSorted(agents).map(a => a.name)], ['Worst', 'Some', 'Clean', 'Unscored']);
});

test('Review call list falls back to no AI columns when agent_call_evals is missing (056 rolled back)', async () => {
  const paths = [];
  const RV = { aiFilter: 'needs', ivrs: ['IVR'], windowStart: new Date('2026-10-14T00:00:00Z'), calls: [], offset: 0, done: false, loading: false, seq: 0 };
  const ctx = load({
    RV, ivrQuery: () => 'ivr_name=x', rvScopeQuery: () => '', renderReviewCalls() {}, renderAeFilters() {},
    document: { getElementById: () => null },
    sbFetch: async (p) => {
      paths.push(p);
      if (p.includes('agent_call_evals')) throw new Error('Supabase 400: {"code":"PGRST200","message":"Could not find a relationship between \'canoe_calls\' and \'agent_call_evals\'"}');
      return [{ id: 'c1' }];
    },
  }, ['async function loadReviewCalls(']);
  await ctx.loadReviewCalls(true);
  assert.equal(paths.length, 2);
  assert.match(paths[0], /agent_call_evals!inner\(.*\)&.*&agent_call_evals\.verdict=in\.\(major,minor\)&order=created_at\.desc$/);
  assert.doesNotMatch(paths[1], /agent_call_evals/);
  assert.equal(ctx.aeAvailable, false);
  assert.equal(RV.aiFilter, 'all');
  assert.deepEqual(JSON.parse(JSON.stringify(RV.calls)), [{ id: 'c1' }]);
});

test('Agents tab quality load: aliases summed into their agent, a newer range wins, a missing RPC hides it', async () => {
  const A = { ivrName: 'Canon IVR', qualifying: ['x'] }, B = { ivrName: 'Other IVR', qualifying: [] };
  let release;
  const calls = [];
  const ctx = load({
    AGENTS: [A, B], currentTab: 'agents', openAgent: null, redraws: 0,
    aliasesForAgent: n => (n === 'Canon IVR' ? ['Alias IVR'] : []), resolveIvrName: n => (n === 'Alias IVR' ? 'Canon IVR' : n),
    applyFilters() { ctx.redraws++; },
    sbFetch: (p, o) => { calls.push(JSON.parse(o.body)); return calls.length === 1 ? new Promise(r => { release = r; }) : Promise.resolve([
      { ivr_name: 'Canon IVR', scored: 5, conversations: 4, good: 3, major: 1 }, { ivr_name: 'Alias IVR', scored: 2, conversations: 2, good: 2, major: 0 }]); },
  }, ['async function loadAgentQuality(', 'async function loadAgentTopIssues(']);
  const first = ctx.loadAgentQuality('2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z');   // slow, superseded
  await ctx.loadAgentQuality('2026-10-14T00:00:00Z', '2026-11-13T00:00:00Z');
  release([{ ivr_name: 'Canon IVR', scored: 999, conversations: 999, good: 0, major: 999 }]);
  await first;
  assert.deepEqual(calls[1], { since_ts: '2026-10-14T00:00:00Z', until_ts: '2026-11-13T00:00:00Z' });
  assert.equal(A.q.scored, 7, 'alias rows add into the canonical agent; the stale range was dropped');
  assert.equal(A.q.good, 5);
  assert.equal(B.q, null, 'no rows, no quality');
  assert.equal(ctx.redraws, 1);

  ctx.sbFetch = async () => { throw new Error('Supabase 404: {"code":"PGRST202","message":"Could not find the function public.agent_eval_metrics"}'); };
  await ctx.loadAgentQuality('a', 'b');
  assert.equal(A.q, null);
  assert.equal(ctx.aeAvailable, false);
});
