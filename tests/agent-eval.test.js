// AI agent scorer (scripts/agent_eval.js, migration 056): verdicts are decided in code from the
// validated reply, calls with no caller speech never reach the model, and the scorer writes only
// agent_call_evals / agent_eval_jobs (never canoe_calls or the call scorer's gemini_batch_jobs).
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
process.env.GEMINI_API_KEY = 'gem-key';

// Fresh module per env (the scorer reads its env once, at load).
function load(env = {}) {
  for (const k of ['DRY_RUN', 'TEST_CALL_IDS', 'BATCH_SIZE', 'BACKFILL_DAYS', 'THINKING_LEVEL']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../scripts/agent_eval.js')];
  return require('../scripts/agent_eval.js');
}
const ae = load();

// Live shapes (2026-11-12): an aliased Pest Control IVR, a rule-less agent, one with {} as rules.
const AGENTS = [
  { ivr_name: 'ASCND AI Agent - Final Expense - Outgoing', name: 'Final Expense', vertical: 'Financial',
    qualifying: ['Calling about life insurance', 'Caller age', 'Caller placed this call themselves', 'Awareness of potential fee'], disqualify: null, objective: null },
  { ivr_name: 'ASCND  AI Agent - Pest Control - Outgoing', name: 'Pest Control', vertical: 'Home Services',
    qualifying: ['Type of pest or animal issue', 'Pest vs. animal classification confirmed'], disqualify: null, objective: null },
  { ivr_name: 'ASCND AI Agent - Medicare - Aragon_12133401267 - Outgoing', name: 'Medicare - Aragon', vertical: 'Insurance', qualifying: [], disqualify: null, objective: null },
  { ivr_name: 'ASCND AI Agent - water damage - outgoing', name: 'Water Damage', vertical: 'Home Services', qualifying: {}, disqualify: null, objective: null },
];
const ALIASES = [
  { ivr_name: 'ASCND AI Agent - Pest Control_13854693345 - Outgoing', canonical_ivr_name: 'ASCND  AI Agent - Pest Control - Outgoing' },
  { ivr_name: 'ASCND Ai Agent - water damage_12138451615 - outgoing', canonical_ivr_name: 'ASCND AI Agent - water damage - outgoing' },
];
const A1 = { id: 'PH11f1a6495b6ab7e0b11d51b6d0c002e7', ivr_name: 'ASCND AI Agent - Final Expense - Outgoing', created_at: '2026-09-01T21:09:02+00:00',
  result: 'abandoned', disposition: 'Rejected', disposition_description: 'Caller did not initiate the call', intent: null,
  vertical_name: 'Final Expense', ivr_duration: 33, ascnd_transcript: 'bot:Hey,  Are you calling in about a new life insurance or Final Expense quote?\nhuman:Yeah. \nbot:Great, did you place this call yourself, or did someone call you?\nhuman:Nope. I got it off the TV. ' };
const A5 = { id: 'PH11f1d87c4c0052f09ef6354e200243f9', ivr_name: 'ASCND AI Agent - Medicare - Aragon_12133401267 - Outgoing', created_at: '2026-11-04T18:19:39+00:00',
  result: 'abandoned', disposition: 'Rejected', disposition_description: 'caller did not initiate the call', intent: null,
  vertical_name: 'Medicare', ivr_duration: 24, ascnd_transcript: 'bot:Hey, you\'ve reached The Medicare Center! Are you calling in about a new medicare policy?\nhuman:No. Is this United? ' };
const SILENT = { id: 'PH11f1d6c9c9ad3ba092bd1506afc9d563', ivr_name: 'ASCND AI Agent - home service compliance_12136721980 - Outgoing', created_at: '2026-11-02T14:29:18+00:00',
  result: 'abandoned', disposition: 'Rejected', disposition_description: 'Caller hung up', intent: null, vertical_name: 'HVAC', ivr_duration: 11,
  ascnd_transcript: 'bot:Thanks for calling, do you know the name of the specific company you\'re trying to reach today?' };
const PEST = { id: 'PH11f1d23b1eccaeb0ba1759942e40a0fa', ivr_name: 'ASCND AI Agent - Pest Control_13854693345 - Outgoing', created_at: '2026-10-27T19:17:59+00:00',
  result: 'dropped', disposition: null, disposition_description: null, intent: 'wildlife removal', vertical_name: 'Wildlife Removal', ivr_duration: 47,
  ascnd_transcript: 'bot:Hey, thanks for calling. What pest or animal are you calling about today?\nhuman:I\'m calling about a groundhog. \nbot:Got it.' };

const reply = (o = {}) => ({
  caller_need: 'x', caller_type: 'person', transcript_quality: 'ok', decision: 'transferred', decision_verdict: 'correct',
  decision_reason: 'r', rules: [], intent_match: 'match', disposition_matches_transcript: 'n/a', dropoff_stage: 'none',
  drop_reason: 'none', understanding: 'smooth', script: 'good', agent_flags: [], summary: 's', top_issue: null, evidence: [], confidence: 'high', ...o,
});
const verdictOf = (o, rulesRegistered = true) => ae.buildAgentEvalRow(A1, reply(o), { rulesRegistered, model: 'm', usage: null }).verdict;

test('verdict is computed in code: major > minor > unclear > good', () => {
  assert.equal(verdictOf({}), 'good');
  assert.equal(verdictOf({ decision_verdict: 'over_reject' }), 'major');
  assert.equal(verdictOf({ decision_verdict: 'over_transfer' }), 'major');
  assert.equal(verdictOf({ agent_flags: ['rude_or_dismissive'] }), 'major');
  assert.equal(verdictOf({ understanding: 'stuck' }), 'major');
  assert.equal(verdictOf({ understanding: 'mishears' }), 'minor');
  assert.equal(verdictOf({ understanding: 'pauses' }), 'minor');
  assert.equal(verdictOf({ script: 'too_long' }), 'minor');
  assert.equal(verdictOf({ intent_match: 'mismatch' }), 'minor');
  assert.equal(verdictOf({ disposition_matches_transcript: 'no' }), 'minor');
  assert.equal(verdictOf({ decision_verdict: 'unclear' }), 'unclear');
  assert.equal(verdictOf({ decision_verdict: 'unclear', script: 'too_long' }), 'minor', 'a negative finding beats unclear (report call C3)');
});

test('replies are validated: unknown enums fall back, unknown flags drop, "None" top issue is null, evidence capped', () => {
  const row = ae.buildAgentEvalRow(A1, reply({
    decision: 'hung_up', decision_verdict: 'Wrong', understanding: 'great', intent_match: 42, dropoff_stage: 'INTRO',
    agent_flags: ['rude_or_dismissive', 'made_up_flag', 'RUDE_OR_DISMISSIVE'], top_issue: 'None.',
    rules: [{ rule: 'Caller age', asked: 'yes', answer: 'maybe' }, 'junk'],
    evidence: [1, 2, 3, 4].map(i => ({ finding: 'f' + i, quote: 'q' + i })),
  }), { rulesRegistered: true, model: 'gemini-test', usage: { input: 2300, output: 410 } });
  assert.equal(row.decision, null);
  assert.equal(row.decision_verdict, 'unclear');
  assert.equal(row.understanding, null);
  assert.equal(row.eval.intent_match, 'no_intent');
  assert.equal(row.dropoff_stage, 'intro', 'case-insensitive');
  assert.deepEqual(row.agent_flags, ['rude_or_dismissive']);
  assert.equal(row.top_issue, null);
  assert.deepEqual(row.eval.rules, [{ rule: 'Caller age', asked: false, answer: 'ambiguous' }]);
  assert.equal(row.eval.evidence.length, 3);
  assert.equal(row.verdict, 'major');
  assert.equal(row.prompt_version, 'agent-v1.1');
  assert.equal(row.call_at, A1.created_at);
  assert.deepEqual([row.input_tokens, row.output_tokens], [2300, 410]);
});

test('agents with no registered rules are not judged on rules', () => {
  const row = ae.buildAgentEvalRow(A5, reply({ script: 'missing_question' }), { rulesRegistered: false, model: 'm', usage: null });
  assert.equal(row.script, 'good');
  assert.equal(row.verdict, 'good');
  assert.equal(row.eval.rules_registered, false);
  assert.equal(verdictOf({ script: 'missing_question' }, true), 'minor', 'registered rules: still a finding');
});

test('no caller line = no_conversation, decided without the model', () => {
  assert.equal(ae.hasCallerSpeech(SILENT.ascnd_transcript), false);
  assert.equal(ae.hasCallerSpeech('bot:Hi\nhuman:  \nbot:Hello?'), false, 'an empty caller line is not speech');
  assert.equal(ae.hasCallerSpeech(A1.ascnd_transcript), true);
  const row = ae.noConversationRow(SILENT, false);
  assert.equal(row.verdict, 'no_conversation');
  assert.equal(row.decision, 'caller_left');
  assert.equal(row.dropoff_stage, 'intro');
  assert.equal(row.model, null);
});

test('user message matches the design (rules from the canonical agent row, aliases resolved)', () => {
  const agentFor = ae.agentIndex(AGENTS, ALIASES);
  const head = (m) => m.slice(0, m.indexOf('\nTranscript:\n'));
  assert.equal(head(ae.buildUserMessage(A1, agentFor(A1.ivr_name))), [
    'Agent: Final Expense (vertical: Financial)', 'Qualifying rules:', '- Calling about life insurance', '- Caller age',
    '- Caller placed this call themselves', '- Awareness of potential fee', 'Disqualify keywords: (none)', 'Objective: (none)', '',
    'Call facts (context only, do not grade by these):', '- Result: abandoned',
    '- Agent disposition: Rejected | stated reason: Caller did not initiate the call', '- Intent recorded by agent: (none)',
    '- Vertical routed to: Final Expense', '- IVR duration: 33s', ''].join('\n'));
  assert.match(ae.buildUserMessage(A5, agentFor(A5.ivr_name)), /^Agent: Medicare - Aragon \(vertical: Insurance\)\nQualifying rules: \(none registered\)\n/);
  assert.match(ae.buildUserMessage(PEST, agentFor(PEST.ivr_name)), /^Agent: Pest Control \(vertical: Home Services\)\nQualifying rules:\n- Type of pest/, 'aliased IVR finds its agent');
  assert.match(ae.buildUserMessage(PEST, agentFor(PEST.ivr_name)), /\nTranscript:\nbot:Hey, thanks for calling/);
  assert.match(ae.buildUserMessage({ ...A5, ivr_name: 'ASCND Ai Agent - water damage_12138451615 - outgoing' }, agentFor('ASCND Ai Agent - water damage_12138451615 - outgoing')),
    /Qualifying rules: \(none registered\)/, 'qualifying {} counts as no rules');
  assert.match(ae.buildUserMessage({ ...A5, ivr_name: 'ASCND Unknown IVR' }, agentFor('ASCND Unknown IVR')), /^Agent: ASCND Unknown IVR \(vertical: \(unknown\)\)/);
});

test('request body: JSON mode, low thinking budget, the approved prompt', () => {
  const body = ae.agentRequestBody('hello');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(body.systemInstruction.parts[0].text, ae.AGENT_PROMPT);
  assert.match(ae.AGENT_PROMPT, /^You are a QA analyst for a pay-per-call network\./);
  assert.doesNotMatch(ae.AGENT_PROMPT, /—/, 'no em dashes');
  assert.equal(load({ THINKING_LEVEL: '' }).agentRequestBody('x').generationConfig.thinkingConfig, undefined);
});

// Fake Supabase + Gemini. Records every request.
function stubFetch({ pending = [], inFlight = [], jobs = [], calls = [], batch = null, generate = null } = {}) {
  const log = [];
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    log.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
    const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => (data == null ? '' : JSON.stringify(data)) });
    if (url.includes('/rest/v1/agents?')) return ok(AGENTS);
    if (url.includes('/rest/v1/agent_ivr_aliases?')) return ok(ALIASES);
    if (url.endsWith('/rpc/agent_eval_pending')) return ok(pending);
    if (url.includes('/agent_eval_jobs?status=in.(submitted,processing)&select=call_ids')) return ok(inFlight.map(ids => ({ call_ids: ids })));
    if (url.includes('/agent_eval_jobs?status=in.(submitted,processing)&order=')) return ok(jobs);
    if (url.includes('/rest/v1/canoe_calls?id=in.')) return ok(calls);
    if (url.includes(':batchGenerateContent')) return ok({ name: 'batches/agent-1' });
    if (url.includes(':generateContent')) return ok(generate);
    if (url.includes('generativelanguage.googleapis.com/v1beta/batches/')) return ok(batch);
    return ok(null);
  };
  return log;
}
const writes = (log) => log.filter(r => r.method !== 'GET' && r.url.includes('/rest/v1/') && !r.url.includes('/rpc/'));

test('submit: silent calls are written as no_conversation, in-flight calls skipped, the rest batched', async () => {
  const m = load({ BATCH_SIZE: '50', BACKFILL_DAYS: '30' });
  const log = stubFetch({ pending: [PEST, A1, SILENT, A5], inFlight: [[A5.id]] });
  await m.runSubmit();

  const rpc = log.find(r => r.url.endsWith('/rpc/agent_eval_pending'));
  assert.equal(rpc.body.max_rows, 50);
  assert.ok(Math.abs(Date.parse(rpc.body.since_ts) - (Date.now() - 30 * 86400000)) < 60000, 'since = now - BACKFILL_DAYS');

  const evalWrites = log.filter(r => r.method === 'POST' && r.url.includes('/agent_call_evals?on_conflict=call_id'));
  assert.equal(evalWrites.length, 1);
  assert.deepEqual(evalWrites[0].body.map(r => [r.call_id, r.verdict]), [[SILENT.id, 'no_conversation']]);

  const submit = log.filter(r => r.url.includes(':batchGenerateContent'));
  assert.equal(submit.length, 1);
  assert.deepEqual(submit[0].body.batch.inputConfig.requests.requests.map(q => q.metadata.key), [PEST.id, A1.id], 'in-flight A5 skipped');

  const job = log.find(r => r.method === 'POST' && r.url.endsWith('/rest/v1/agent_eval_jobs'));
  assert.deepEqual(job.body.call_ids, [PEST.id, A1.id]);
  assert.equal(job.body.prompt_version, 'agent-v1.1');

  for (const w of writes(log)) assert.match(w.url, /\/rest\/v1\/(agent_call_evals|agent_eval_jobs)\b/, `unexpected write: ${w.method} ${w.url}`);
});

test('submit: the shared batch quota stops cleanly, any other rejection fails the run', async () => {
  const m = load();
  for (const [status, msg, fails] of [[429, 'RESOURCE_EXHAUSTED', false], [400, 'Invalid JSON payload: unknown field thinkingLevel', true]]) {
    const log = stubFetch({ pending: [A1] });
    const inner = global.fetch;
    global.fetch = async (url, opts) => url.includes(':batchGenerateContent')
      ? (log.push({ url, method: 'POST', body: null }), { ok: false, status, text: async () => msg, json: async () => ({}) })
      : inner(url, opts);
    const orig = console.error; console.error = () => {};
    try {
      if (fails) await assert.rejects(m.runSubmit(), /400/);
      else await m.runSubmit();
    } finally { console.error = orig; }
    assert.ok(!log.some(r => r.url.endsWith('/rest/v1/agent_eval_jobs') && r.method === 'POST'), 'no job row without a Gemini job');
  }
});

test('dry run: scores synchronously and writes nothing', async () => {
  const m = load({ DRY_RUN: 'true', TEST_CALL_IDS: `${A1.id},${SILENT.id}` });
  const generate = { candidates: [{ content: { parts: [{ text: JSON.stringify(reply({ decision: 'rejected', decision_verdict: 'over_reject' })) }] } }],
    usageMetadata: { promptTokenCount: 2300, candidatesTokenCount: 300, thoughtsTokenCount: 120 } };
  const log = stubFetch({ calls: [A1, SILENT], generate });
  const out = [];
  const orig = console.log; console.log = (...a) => out.push(a.join(' '));
  try { await m.runSubmit(); } finally { console.log = orig; }

  assert.deepEqual(writes(log), [], 'no writes in a dry run');
  assert.equal(log.filter(r => r.url.includes(':generateContent')).length, 1, 'one model call (the silent call is code-decided)');
  assert.ok(log.some(r => r.url.includes(`/canoe_calls?id=in.(${A1.id},${SILENT.id})`)), 'TEST_CALL_IDS pins the calls');
  assert.ok(out.some(l => l.includes(`${A1.id}`) && l.includes('major') && l.includes('2300/420')), 'prints verdict and tokens incl. thinking');
});

test('ingest: upserts evals, records token usage on the job, never writes canoe_calls', async () => {
  const m = load();
  const job = { id: 'j1', job_name: 'batches/agent-1', model: 'gemini-test', status: 'processing', call_ids: [A1.id, PEST.id, A5.id] };
  const item = (key, o, usage) => ({ metadata: { key }, response: { candidates: [{ content: { parts: [{ text: JSON.stringify(reply(o)) }] } }], usageMetadata: usage } });
  const batch = { metadata: { state: 'BATCH_STATE_SUCCEEDED' }, response: { inlinedResponses: { inlinedResponses: [
    item(A1.id, { decision: 'rejected', decision_verdict: 'over_reject' }, { promptTokenCount: 2000, candidatesTokenCount: 300, thoughtsTokenCount: 100 }),
    item(PEST.id, {}, { promptTokenCount: 1900, candidatesTokenCount: 250 }),
    { metadata: { key: A5.id }, error: { code: 500 } },
  ] } } };
  const log = stubFetch({ jobs: [job], calls: [A1, PEST, A5], batch });
  await m.runIngest();

  const up = log.find(r => r.method === 'POST' && r.url.includes('/agent_call_evals?on_conflict=call_id'));
  assert.deepEqual(up.body.map(r => [r.call_id, r.verdict, r.model]), [[A1.id, 'major', 'gemini-test'], [PEST.id, 'good', 'gemini-test']]);
  assert.equal(up.body[0].output_tokens, 400, 'thinking tokens count as output');

  const patch = log.find(r => r.method === 'PATCH' && r.url.includes('/agent_eval_jobs?id=eq.j1'));
  assert.equal(patch.body.status, 'completed');
  assert.equal(patch.body.input_tokens, 3900);
  assert.equal(patch.body.output_tokens, 650);
  assert.equal(patch.body.error, '1 item error(s)');

  for (const w of writes(log)) assert.match(w.url, /\/rest\/v1\/(agent_call_evals|agent_eval_jobs)\b/, `unexpected write: ${w.method} ${w.url}`);
});

test('ingest: a running job is marked processing; a failed job leaves its calls queued', async () => {
  const m = load();
  let log = stubFetch({ jobs: [{ id: 'j2', job_name: 'batches/a2', status: 'submitted', call_ids: [A1.id] }], batch: { metadata: { state: 'BATCH_STATE_RUNNING' } } });
  await m.runIngest();
  assert.deepEqual(writes(log).map(w => w.body), [{ status: 'processing' }]);

  log = stubFetch({ jobs: [{ id: 'j3', job_name: 'batches/a3', status: 'processing', call_ids: [A1.id] }], batch: { metadata: { state: 'BATCH_STATE_EXPIRED' } } });
  await m.runIngest();
  const w = writes(log);
  assert.equal(w.length, 1);
  assert.equal(w[0].body.status, 'expired');
  assert.ok(!log.some(r => r.url.includes('/agent_call_evals')), 'no eval rows for an expired job');
});
