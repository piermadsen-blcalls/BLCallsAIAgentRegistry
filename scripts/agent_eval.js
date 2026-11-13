/**
 * agent_eval.js
 * AI agent performance scoring (migration 056). Grades the AI agent's own side of every ASCND
 * call with an agent transcript (canoe_calls.ascnd_transcript), whether or not it reached a
 * buyer, and writes one agent_call_evals row per call. Separate from process.js scoring: it never
 * writes canoe_calls, so our_outcome, scores, flags and the digest do not move.
 *
 * Gemini Batch API, two-phase like process.js, tracked in agent_eval_jobs (not gemini_batch_jobs,
 * so the call scorer's ingest can never write an agent reply into canoe_calls):
 *   BATCH_ACTION=submit  - queue = agent_eval_pending(now - BACKFILL_DAYS), newest first, up to
 *                          BATCH_SIZE. Calls with no caller speech are written as no_conversation
 *                          without a model call; the rest go out in jobs of up to GEMINI_CHUNK.
 *   BATCH_ACTION=ingest  - poll open agent_eval_jobs, upsert finished results, log token usage.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY, AI_MODEL (bare gemini-* id),
 *   BACKFILL_DAYS (default 30; 0 = all history), BATCH_SIZE (default 500), GEMINI_CHUNK (500),
 *   THINKING_LEVEL (default 'low'; '' sends no thinkingConfig),
 *   TEST_CALL_IDS (comma list: score exactly these calls, already scored or not),
 *   DRY_RUN=true (submit: score each call synchronously and print the reply + verdict; writes nothing).
 */

// Loads scripts/.env (via process.js) and the shared JSON parser; process.js does not run on require.
const { parseModelJson, chunk } = require('./process.js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY;
const AI_MODEL             = process.env.AI_MODEL       || 'gemini-3.6-flash';
const BATCH_ACTION         = process.env.BATCH_ACTION   || '';
const BACKFILL_DAYS        = parseInt(process.env.BACKFILL_DAYS || '30', 10);
const BATCH_SIZE           = parseInt(process.env.BATCH_SIZE    || '500', 10);
const GEMINI_CHUNK         = parseInt(process.env.GEMINI_CHUNK  || '500', 10);
const MAX_TOKENS           = parseInt(process.env.MAX_TOKENS    || '4096', 10);
const THINKING_LEVEL       = process.env.THINKING_LEVEL ?? 'low';
const DRY_RUN              = process.env.DRY_RUN        === 'true';
const TEST_CALL_IDS        = (process.env.TEST_CALL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Assumed batch price for the cost line in the logs (half the 3.5 Flash list price; the repo has
// no 3.6 Flash price). USD per million tokens.
const PRICE_IN = 0.75, PRICE_OUT = 4.50;

// ── Prompt (design report Appendix A, agent-v1.1) ─────────────
const AGENT_PROMPT_VERSION = 'agent-v1.1';
const AGENT_PROMPT = `You are a QA analyst for a pay-per-call network. You review the AI phone agent's side of ONE call and grade how the AGENT performed. You are not grading the caller, the publisher or the buyer, and you do not grade the agent by whether the call was later sold or connected.

HOW THESE AGENTS WORK
- A caller dials in and reaches an AI voice agent ("bot:" lines). The agent asks a few screening questions, then either:
  - transfers: it says it "pinged our system" or is transferring. The call is then offered to buyers. What happens after that (connected, dropped, no buyer bid) is not the agent's doing and is not in this transcript. The transcript often stops mid-sentence at the transfer; that is normal.
  - rejects: it tells the caller it can't help and ends the call.
- The caller can also hang up or go silent before the agent decides.
- The transcript is machine speech-to-text. Caller lines are often cut off or misheard ("Spires" for "spiders", "card" for "call"). Judge the agent on what it could reasonably have understood. Say when the transcript is too broken to judge. Transcripts may be in Spanish; always answer in English.

WHAT YOU ARE GIVEN
- Agent: name, vertical, registered qualifying rules, disqualify keywords, objective. Any of these may be empty.
- Call facts from the phone platform: result, the agent's disposition and stated reason, the intent the agent recorded, the vertical the call was routed to, IVR duration. These are context, not the answer. Grade from the transcript.
- Transcript: "bot:" = the AI agent, "human:" = the caller.

JUDGE THESE

1. caller_need: what the caller actually wanted, in a few words ("roach treatment", "wanted United Healthcare", "unclear").

2. caller_type: person | bot_or_recording | unclear.

3. transcript_quality: ok | fragmentary (caller lines too cut off or garbled to judge some answers) | no_caller_speech.

4. decision: what the agent did.
   - transferred: said it pinged the system or is transferring.
   - rejected: told the caller it can't help, or ended the call as not a fit.
   - caller_left: caller hung up or stopped responding before the agent decided.
   - stalled: the agent stopped moving the call forward (waited, looped, kept asking "are you still there" after the caller had answered) and no decision was made.

5. decision_verdict: was that decision right, given the agent's rules and what the caller said?
   - correct: transferred a caller who met the rules, or rejected one who clearly failed a rule.
   - over_transfer: transferred a caller who failed a rule or is clearly off-target: wrong service for this agent, asked for a specific other company, said someone else called them, or named a disqualified lead source.
   - over_reject: rejected a caller who met the rules, OR rejected on an answer that was ambiguous, cut off or likely misheard and deserved one clarifying question first. Examples: "Nope, I got it off the TV" to "did you place this call yourself?" means they did place it; "I'm just looking for more benefits" to a Medicare agent deserves a follow-up; "Speak with owner" is a request, not a refusal.
   - not_applicable: caller_left or stalled with nothing to judge.
   - unclear: you cannot tell (transcript too broken, or the rules do not cover this case). Do not guess.
   If the agent has no registered rules, treat the screening questions the agent itself asked, plus its name and vertical, as its rules. Do not invent business policy beyond the rules, the objective and the agent's own questions.
   Routing is not over-transferring: when the agent sorts callers into categories (pest vs animal, auto vs home), a transfer whose recorded intent or "vertical routed to" matches the caller's need is correct, even if that category differs from the agent's own name or vertical.
   Check the agent's restatements against the caller's actual words. If the agent says "got it, you placed the call yourself" but the caller said "no", or described filling out a form or application and then getting a call, the caller failed that rule and the transfer is an over_transfer with flag transferred_non_initiator.

6. decision_reason: one short line explaining decision_verdict.

7. rules: one entry per registered qualifying rule (or per screening question the agent asked, if none are registered).
   { "rule": "<rule text>", "asked": true|false, "answer": "pass" | "fail" | "ambiguous" | "no_answer" | "not_asked" }
   A rule the caller's own words already settled counts as asked and answered (e.g. "opossums" settles pest vs animal; "roof repair" settles calling about roofing). Do not require a separate question.

8. intent_match: does the intent the agent recorded fit what the caller said? match | mismatch | no_intent. Use no_intent when no intent was recorded or it is a status word rather than a need (e.g. "Approved", "Transfer").

9. disposition_matches_transcript: if the agent's stated rejection reason is given, does the transcript support it? yes | no | n/a.

10. dropoff_stage: where the caller left, if they did.
    - none: the agent transferred or rejected and nothing shows the caller leaving first.
    - intro: the caller left before answering the first question.
    - mid_qualification: after answering at least one question, before a decision.
    - at_transfer: after the agent announced the transfer (for example it asked "anything else?" and the call ended).

11. drop_reason: why the caller left, if they did, else none.
    none | caller_silent | wanted_human | frustrated_with_agent | wrong_company | agent_misheard | agent_too_long | agent_stalled | unknown.
    Use agent_stalled when the caller had answered and the agent failed to move on; use caller_silent only when the caller never answered.

12. understanding: smooth | mishears | pauses | stuck.
    - smooth: understood the caller; the call flowed.
    - mishears: misheard or misread the caller, re-asked something already answered, or acted on a wrong reading.
    - pauses: talked over or cut off the caller, or asked "are you still there?" right after the caller spoke.
    - stuck: looped or could not move the call forward.

13. script: good | too_long | late_dq | missing_question.
    - too_long: redundant confirmations, re-asking, long monologues (long advice when rejecting, "anything else I can help with?" after a decision).
    - late_dq: the question the caller failed came after other questions when it could have come first.
    - missing_question: skipped a registered qualifying rule that the caller's words had not already settled, before transferring.

14. agent_flags: zero or more agent-side compliance problems.
    - transferred_non_initiator: transferred after the caller said someone else called them or they did not place the call.
    - transferred_disqualified_source: transferred after the caller named a disqualify keyword source listed for this agent.
    - claimed_to_be_requested_company: implied it was the specific company the caller asked for.
    - rude_or_dismissive: rude or dismissive to the caller (e.g. "we're not interested").
    - off_script_advice: gave long advice or instructions outside its role instead of ending politely.
    - promised_outcome: promised a price, coverage, appointment time or result.

15. summary: one or two plain sentences on what happened, from the agent's side.

16. top_issue: the single most useful fix this call suggests for the agent's script or logic, in one short line. JSON null (not the string "None") if the agent handled the call well.

17. evidence: for each negative finding (over_transfer, over_reject, mishears, pauses, stuck, any agent_flag, disposition mismatch), a short exact quote from the transcript. At most 3. Empty if none.

18. confidence: high | medium | low.

Respond with valid JSON only:
{
  "caller_need": "<few words>",
  "caller_type": "person",
  "transcript_quality": "ok",
  "decision": "transferred",
  "decision_verdict": "correct",
  "decision_reason": "<one line>",
  "rules": [ { "rule": "<rule>", "asked": true, "answer": "pass" } ],
  "intent_match": "match",
  "disposition_matches_transcript": "n/a",
  "dropoff_stage": "none",
  "drop_reason": "none",
  "understanding": "smooth",
  "script": "good",
  "agent_flags": [],
  "summary": "<1-2 sentences>",
  "top_issue": null,
  "evidence": [ { "finding": "<finding>", "quote": "<exact quote>" } ],
  "confidence": "high"
}`;

// ── Output validation ─────────────────────────────────────────
const ENUMS = {
  caller_type:                    ['person', 'bot_or_recording', 'unclear'],
  transcript_quality:             ['ok', 'fragmentary', 'no_caller_speech'],
  decision:                       ['transferred', 'rejected', 'caller_left', 'stalled'],
  decision_verdict:               ['correct', 'over_transfer', 'over_reject', 'not_applicable', 'unclear'],
  intent_match:                   ['match', 'mismatch', 'no_intent'],
  disposition_matches_transcript: ['yes', 'no', 'n/a'],
  dropoff_stage:                  ['none', 'intro', 'mid_qualification', 'at_transfer'],
  drop_reason:                    ['none', 'caller_silent', 'wanted_human', 'frustrated_with_agent', 'wrong_company',
                                   'agent_misheard', 'agent_too_long', 'agent_stalled', 'unknown'],
  understanding:                  ['smooth', 'mishears', 'pauses', 'stuck'],
  script:                         ['good', 'too_long', 'late_dq', 'missing_question'],
  confidence:                     ['high', 'medium', 'low'],
};
// Unknown values fall back to the field's "can't tell" value; null where the field has none.
const FALLBACK = {
  caller_type: 'unclear', transcript_quality: null, decision: null, decision_verdict: 'unclear',
  intent_match: 'no_intent', disposition_matches_transcript: 'n/a', dropoff_stage: 'none',
  drop_reason: 'unknown', understanding: null, script: null, confidence: 'low',
};
const RULE_ANSWERS = ['pass', 'fail', 'ambiguous', 'no_answer', 'not_asked'];
const AGENT_FLAGS = ['transferred_non_initiator', 'transferred_disqualified_source', 'claimed_to_be_requested_company',
                     'rude_or_dismissive', 'off_script_advice', 'promised_outcome'];

const norm = (v) => String(v ?? '').trim().toLowerCase();
const pick = (v, allowed, fallback) => { const n = norm(v); return allowed.includes(n) ? n : fallback; };
const text = (v, max) => { if (typeof v !== 'string') return null; const t = v.replace(/\s+/g, ' ').trim(); return t ? t.slice(0, max) : null; };
// "None", "n/a", "" etc. mean the agent handled the call well: store null.
const topIssue = (v) => { const t = text(v, 400); return !t || /^(none|null|n\/?a|-|no issues?)\.?$/i.test(t) ? null : t; };

// A caller line with any content. Transcripts are "bot:" / "human:" lines ([ \t], not \s, so an
// empty caller line can't borrow the next line's text).
const hasCallerSpeech = (tx) => /^[ \t]*human[ \t]*:[ \t]*\S/im.test(tx || '');

// Code-decided verdict (design section 2), like geo_mismatch in process.js.
function computeVerdict(e) {
  if (e.decision_verdict === 'over_transfer' || e.decision_verdict === 'over_reject' || e.agent_flags.length || e.understanding === 'stuck') return 'major';
  if (e.understanding === 'mishears' || e.understanding === 'pauses' || (e.script && e.script !== 'good')
      || e.intent_match === 'mismatch' || e.disposition_matches_transcript === 'no') return 'minor';
  if (e.decision_verdict === 'unclear') return 'unclear';
  return 'good';
}

function evalRow(call, e, verdict, model, usage) {
  return {
    call_id:          call.id,
    ivr_name:         call.ivr_name,
    call_at:          call.created_at,
    verdict,
    decision:         e.decision,
    decision_verdict: e.decision_verdict,
    dropoff_stage:    e.dropoff_stage,
    drop_reason:      e.drop_reason,
    understanding:    e.understanding,
    script:           e.script,
    agent_flags:      e.agent_flags,
    summary:          e.summary,
    top_issue:        e.top_issue,
    eval:             e,
    model,
    prompt_version:   AGENT_PROMPT_VERSION,
    input_tokens:     usage ? usage.input  : null,
    output_tokens:    usage ? usage.output : null,
  };
}

// Validated agent_call_evals row from a parsed model reply. rulesRegistered=false (agent has no
// qualifying rules in `agents`): the call is still graded, but not on rules (captain, 2026-11-12),
// so a missing_question finding, which by definition needs a registered rule, is dropped.
function buildAgentEvalRow(call, parsed, { rulesRegistered, model, usage }) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const e = {};
  for (const [k, allowed] of Object.entries(ENUMS)) e[k] = pick(p[k], allowed, FALLBACK[k]);
  e.agent_flags     = [...new Set((Array.isArray(p.agent_flags) ? p.agent_flags : []).map(norm).filter(f => AGENT_FLAGS.includes(f)))];
  e.rules           = (Array.isArray(p.rules) ? p.rules : []).filter(r => r && typeof r === 'object').slice(0, 12)
                        .map(r => ({ rule: text(r.rule, 200) || '(unnamed)', asked: r.asked === true, answer: pick(r.answer, RULE_ANSWERS, 'ambiguous') }));
  e.caller_need     = text(p.caller_need, 160);
  e.decision_reason = text(p.decision_reason, 400);
  e.summary         = text(p.summary, 600);
  e.top_issue       = topIssue(p.top_issue);
  e.evidence        = (Array.isArray(p.evidence) ? p.evidence : []).filter(x => x && typeof x.quote === 'string' && x.quote.trim()).slice(0, 3)
                        .map(x => ({ finding: text(x.finding, 200), quote: text(x.quote, 300) }));
  e.rules_registered = rulesRegistered;
  if (!rulesRegistered && e.script === 'missing_question') { e.script = 'good'; e.coerced = ['script: missing_question without registered rules']; }
  return evalRow(call, e, computeVerdict(e), model, usage);
}

// The transcript has no caller line: decided in code, no model call (13% of calls).
function noConversationRow(call, rulesRegistered) {
  const e = {
    code_decided: true, caller_need: null, caller_type: 'unclear', transcript_quality: 'no_caller_speech',
    decision: 'caller_left', decision_verdict: 'not_applicable', decision_reason: 'The caller never spoke.',
    rules: [], intent_match: 'no_intent', disposition_matches_transcript: 'n/a',
    dropoff_stage: 'intro', drop_reason: 'caller_silent', understanding: null, script: null, agent_flags: [],
    summary: 'The caller never spoke, so there was no agent decision to grade.', top_issue: null, evidence: [],
    confidence: 'high', rules_registered: rulesRegistered,
  };
  return evalRow(call, e, 'no_conversation', null, null);
}

// ── Agents (rules come from the `agents` row of the call's canonical IVR) ──
const rulesOf = (agent) => (Array.isArray(agent?.qualifying) ? agent.qualifying : []).filter(r => typeof r === 'string' && r.trim());

function agentIndex(agents, aliases) {
  const aliasMap = Object.fromEntries((aliases || []).map(r => [r.ivr_name, r.canonical_ivr_name]));
  const resolve = (name) => aliasMap[name] || name;
  const byCanon = new Map();
  for (const a of agents || []) {
    const k = resolve(a.ivr_name);
    // A row registered under the canonical name wins over one registered under an alias.
    if (!byCanon.has(k) || a.ivr_name === k) byCanon.set(k, a);
  }
  return (ivrName) => byCanon.get(resolve(ivrName)) || null;
}

function buildUserMessage(call, agent) {
  const rules = rulesOf(agent);
  return [
    `Agent: ${agent?.name || call.ivr_name} (vertical: ${agent?.vertical || '(unknown)'})`,
    rules.length ? `Qualifying rules:\n${rules.map(r => `- ${r}`).join('\n')}` : 'Qualifying rules: (none registered)',
    `Disqualify keywords: ${agent?.disqualify || '(none)'}`,
    `Objective: ${agent?.objective || '(none)'}`,
    '',
    'Call facts (context only, do not grade by these):',
    `- Result: ${call.result || '(none)'}`,
    `- Agent disposition: ${call.disposition || '(none)'} | stated reason: ${call.disposition_description || '(none)'}`,
    `- Intent recorded by agent: ${call.intent || '(none)'}`,
    `- Vertical routed to: ${call.vertical_name || '(none)'}`,
    `- IVR duration: ${call.ivr_duration ?? '?'}s`,
    '',
    'Transcript:',
    call.ascnd_transcript,
  ].join('\n');
}

// ── Gemini ────────────────────────────────────────────────────
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function agentRequestBody(userMessage) {
  const generationConfig = { temperature: 0.1, maxOutputTokens: MAX_TOKENS, responseMimeType: 'application/json' };
  // Thinking tokens bill as output; keep them low and count them (usageOf).
  if (THINKING_LEVEL) generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL };
  return {
    systemInstruction: { parts: [{ text: AGENT_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig,
  };
}

// Token usage of one reply. Output includes thinking tokens, which bill as output.
const usageOf = (m) => ({
  input:  m?.promptTokenCount || 0,
  output: (m?.candidatesTokenCount || 0) + (m?.thoughtsTokenCount || 0),
});
const costOf = (u) => (u.input * PRICE_IN + u.output * PRICE_OUT) / 1e6;

async function gemini(path, body) {
  const res = await fetch(`${GEMINI_BASE}/${path}`, {
    method:  body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body:    body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Gemini ${path.split(':').pop()} error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Supabase (service role) ───────────────────────────────────
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const headers = { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} error ${res.status}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

const CALL_COLS = 'id,ivr_name,created_at,result,disposition,disposition_description,intent,vertical_name,ivr_duration,ascnd_transcript';

async function loadAgentLookup() {
  const [agents, aliases] = await Promise.all([
    sb('agents?select=ivr_name,name,vertical,qualifying,disqualify,objective'),
    sb('agent_ivr_aliases?select=ivr_name,canonical_ivr_name'),
  ]);
  return agentIndex(agents, aliases);
}

async function fetchCandidates() {
  if (TEST_CALL_IDS.length) {
    const out = [];
    for (const slice of chunk(TEST_CALL_IDS, 100)) out.push(...(await sb(`canoe_calls?id=in.(${slice.join(',')})&select=${CALL_COLS}`) || []));
    return out.filter(c => (c.ascnd_transcript || '').trim());
  }
  const since = BACKFILL_DAYS > 0 ? new Date(Date.now() - BACKFILL_DAYS * 86400000).toISOString() : '1970-01-01T00:00:00Z';
  return await sb('rpc/agent_eval_pending', { method: 'POST', body: { since_ts: since, max_rows: BATCH_SIZE } }) || [];
}

// Calls already in an open job: submit stamps nothing on the call, so dedupe here (no double pay).
async function fetchInFlightIds() {
  const rows = await sb('agent_eval_jobs?status=in.(submitted,processing)&select=call_ids') || [];
  return new Set(rows.flatMap(r => r.call_ids || []));
}

async function upsertEvals(rows) {
  for (const slice of chunk(rows, 200)) {
    await sb('agent_call_evals?on_conflict=call_id', { method: 'POST', body: slice, prefer: 'resolution=merge-duplicates,return=minimal' });
  }
}

// ── Submit ────────────────────────────────────────────────────
async function runSubmit() {
  const agentFor = await loadAgentLookup();
  let calls = await fetchCandidates();
  if (!TEST_CALL_IDS.length) {
    const inFlight = await fetchInFlightIds();
    const fresh = calls.filter(c => !inFlight.has(c.id));
    if (fresh.length < calls.length) console.log(`Skipping ${calls.length - fresh.length} call(s) already in open agent jobs`);
    calls = fresh;
  }
  console.log(`Found ${calls.length} agent call(s) to score`);
  if (!calls.length) return;

  const registered = (c) => rulesOf(agentFor(c.ivr_name)).length > 0;
  const silent = calls.filter(c => !hasCallerSpeech(c.ascnd_transcript));
  const talk   = calls.filter(c => hasCallerSpeech(c.ascnd_transcript));
  const noConv = silent.map(c => noConversationRow(c, registered(c)));
  console.log(`  ${noConv.length} with no caller speech (no_conversation, no model call), ${talk.length} for the model`);

  if (DRY_RUN) {
    for (const r of noConv) console.log(`  [dry-run] ${r.call_id} ${r.ivr_name}: no_conversation`);
    await runDryRun(talk, agentFor, registered);
    return;
  }
  if (noConv.length) { await upsertEvals(noConv); console.log(`  Wrote ${noConv.length} no_conversation row(s)`); }
  if (!talk.length) return;
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const day = new Date().toISOString().slice(0, 10);
  const jobs = chunk(talk, GEMINI_CHUNK);
  let submitted = 0;
  for (let idx = 0; idx < jobs.length; idx++) {
    const group = jobs[idx];
    const requests = group.map(c => ({ request: agentRequestBody(buildUserMessage(c, agentFor(c.ivr_name))), metadata: { key: c.id } }));
    let job;
    try {
      job = await gemini(`models/${AI_MODEL}:batchGenerateContent`,
        { batch: { displayName: `blcalls-agent-${day}-${idx + 1}`, inputConfig: { requests: { requests } } } });
    } catch (e) {
      // Batch quota (429) is shared with the call scorer: stop cleanly; the next run resumes.
      console.error(`  Stopping at job ${idx + 1}/${jobs.length}: ${e.message.slice(0, 200)}`);
      if (/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(e.message)) console.error('  Gemini batch quota reached; the next submit resumes.');
      break;
    }
    await sb('agent_eval_jobs', { method: 'POST', prefer: 'return=minimal', body: {
      job_name: job.name, model: AI_MODEL, prompt_version: AGENT_PROMPT_VERSION, status: 'submitted',
      call_ids: group.map(c => c.id), call_count: group.length,
    } });
    console.log(`  Submitted ${job.name} (${group.length} calls)`);
    submitted++;
    if (idx < jobs.length - 1) await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`Submit done. ${submitted} agent job(s) recorded.`);
}

// Pre-go-live check: score synchronously and print each validated reply; nothing is written.
async function runDryRun(calls, agentFor, registered) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const total = { input: 0, output: 0 }, verdicts = {};
  let errors = 0, next = 0;
  async function worker() {
    while (next < calls.length) {
      const c = calls[next++];
      try {
        const data = await gemini(`models/${AI_MODEL}:generateContent`, agentRequestBody(buildUserMessage(c, agentFor(c.ivr_name))));
        const usage = usageOf(data.usageMetadata);
        total.input += usage.input; total.output += usage.output;
        const parsed = parseModelJson((data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
        const row = buildAgentEvalRow(c, parsed, { rulesRegistered: registered(c), model: AI_MODEL, usage });
        verdicts[row.verdict] = (verdicts[row.verdict] || 0) + 1;
        console.log(`  [dry-run] ${c.id} ${c.ivr_name}: ${row.verdict} (${row.decision} -> ${row.decision_verdict}) tokens ${usage.input}/${usage.output}`);
        console.log(`    ${JSON.stringify(row.eval)}`);
      } catch (e) { errors++; console.error(`  [dry-run] ${c.id}: ${e.message.slice(0, 300)}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, calls.length) }, worker));
  console.log(`Dry run done. Verdicts ${JSON.stringify(verdicts)}, errors ${errors}, tokens in ${total.input} / out ${total.output} (~$${(costOf(total) * 2).toFixed(4)} at sync price)`);
}

// ── Ingest ────────────────────────────────────────────────────
async function runIngest() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const jobs = await sb('agent_eval_jobs?status=in.(submitted,processing)&order=submitted_at.asc') || [];
  console.log(`Found ${jobs.length} open agent job(s)`);
  if (!jobs.length) return;
  const agentFor = await loadAgentLookup();
  for (const job of jobs) {
    try {
      const data  = await gemini(job.job_name);
      const state = data.metadata?.state || data.state || 'UNKNOWN';
      console.log(`  ${job.job_name}: ${state}`);
      if (/PENDING|RUNNING/.test(state)) {
        if (job.status !== 'processing') await sb(`agent_eval_jobs?id=eq.${job.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'processing' } });
        continue;
      }
      if (/SUCCEEDED/.test(state)) { await ingestAgentJob(job, data, agentFor); continue; }
      // Terminal failure: no eval rows were written, so the calls stay in the queue for a future submit.
      const status = /EXPIRED/.test(state) ? 'expired' : /CANCELLED/.test(state) ? 'cancelled' : 'failed';
      await sb(`agent_eval_jobs?id=eq.${job.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { status, error: state, completed_at: new Date().toISOString() } });
      console.error(`  Job ${job.job_name} ended ${state}; its calls stay queued.`);
    } catch (e) {
      console.error(`  [${job.job_name}] ingest error: ${e.message}`);
    }
  }
}

async function ingestAgentJob(job, data, agentFor) {
  const callIds = job.call_ids || [];
  const inline    = data.response?.inlinedResponses;
  const responses = Array.isArray(inline) ? inline : (inline?.inlinedResponses || []);
  // Context the row needs (ivr, time) is re-read here: submit and ingest run in separate processes.
  const callById = {};
  for (const slice of chunk(callIds, 100)) {
    for (const c of await sb(`canoe_calls?id=in.(${slice.join(',')})&select=id,ivr_name,created_at`) || []) callById[c.id] = c;
  }

  const rows = [], total = { input: 0, output: 0 };
  let errors = 0;
  for (let i = 0; i < responses.length; i++) {
    const item   = responses[i];
    const callId = item.metadata?.key || callIds[i];   // prefer the echoed key, else submit order
    const call   = callById[callId];
    if (!call) { errors++; continue; }
    if (item.error) { console.error(`  [${callId}] item error: ${JSON.stringify(item.error).slice(0, 200)}`); errors++; continue; }
    const usage = usageOf(item.response?.usageMetadata);
    total.input += usage.input; total.output += usage.output;
    let parsed;
    try { parsed = parseModelJson((item.response?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')); }
    catch { console.error(`  [${callId}] could not parse response`); errors++; continue; }
    rows.push(buildAgentEvalRow(call, parsed, { rulesRegistered: rulesOf(agentFor(call.ivr_name)).length > 0, model: job.model, usage }));
  }
  await upsertEvals(rows);
  await sb(`agent_eval_jobs?id=eq.${job.id}`, { method: 'PATCH', prefer: 'return=minimal', body: {
    status: 'completed', completed_at: new Date().toISOString(), error: errors ? `${errors} item error(s)` : null,
    input_tokens: total.input, output_tokens: total.output,
  } });
  console.log(`  Ingested ${job.job_name}: ${rows.length} eval(s), errors ${errors}, tokens in ${total.input} / out ${total.output} (~$${costOf(total).toFixed(4)})`);
}

// ── Main ──────────────────────────────────────────────────────
async function run() {
  console.log(`Starting agent scoring: model ${AI_MODEL}, action ${BATCH_ACTION || '(none)'}, prompt ${AGENT_PROMPT_VERSION}${DRY_RUN ? ', dry run' : ''}`);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  if (!/^gemini/i.test(AI_MODEL)) throw new Error(`agent scoring needs a bare Gemini model id; got "${AI_MODEL}"`);
  if (BATCH_ACTION === 'submit') return runSubmit();
  if (BATCH_ACTION === 'ingest') return runIngest();
  throw new Error('BATCH_ACTION must be submit or ingest');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Agent scoring failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  AGENT_PROMPT, AGENT_PROMPT_VERSION, hasCallerSpeech, computeVerdict, buildAgentEvalRow, noConversationRow,
  agentIndex, buildUserMessage, agentRequestBody, runSubmit, runIngest, ingestAgentJob,
};
