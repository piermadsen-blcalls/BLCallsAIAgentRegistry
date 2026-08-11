/**
 * process.js
 * Reads unprocessed calls from canoe_calls, runs AI analysis,
 * writes outcome + compliance flags back to the same row.
 *
 * Required env vars:
 *   SUPABASE_URL          - e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  - service role key
 *   OPENROUTER_API_KEY    - OpenRouter key (used when AI_MODEL is namespaced, e.g. "anthropic/...")
 *   ANTHROPIC_API_KEY     - Anthropic key (only used for bare Claude ids like "claude-sonnet-4-6")
 *   GEMINI_API_KEY        - Google AI Studio key (used for bare Gemini ids, e.g. "gemini-3.6-flash")
 *   AI_MODEL              - default "anthropic/claude-sonnet-4-6" (routed via OpenRouter)
 *   AI_MODE               - "combined" (default) or "separate"
 *   BATCH_SIZE            - number of calls to process per run (default 100)
 *   BATCH_MODE            - "true" for Anthropic batch API (bare Claude ids only; ignored for OpenRouter)
 *
 * Gemini Batch API (async, ~50% cheaper) is split across two runs so a job can
 * outlive the 6h GitHub Actions cap. Bare Gemini id + one of:
 *   BATCH_ACTION=submit   - fan unprocessed calls into batch jobs, record them in
 *                           gemini_batch_jobs, exit. No polling.
 *   BATCH_ACTION=ingest   - poll open gemini_batch_jobs, write finished results to
 *                           canoe_calls. Idempotent no-op when nothing is pending.
 *   BACKFILL_DAYS         - (submit) only fetch unprocessed calls newer than N days.
 *   GEMINI_CHUNK          - (submit) max requests per batch job (default 500).
 *   DRY_RUN=true          - (submit) build + log the batch without submitting.
 */

// Local dev convenience: load scripts/.env if present (gitignored).
(function loadDotEnv() {
  const fs = require('fs'), path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const OPENROUTER_API_KEY   = process.env.OPENROUTER_API_KEY;
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY;
const AI_MODEL             = process.env.AI_MODEL       || 'anthropic/claude-sonnet-4-6';
const AI_MODE              = process.env.AI_MODE        || 'combined';
const BATCH_SIZE           = parseInt(process.env.BATCH_SIZE || '100', 10);
const MAX_TOKENS           = parseInt(process.env.MAX_TOKENS || '4096', 10);
const PROMPT_ID            = process.env.PROMPT_ID      || null;
const TEST_MODE            = process.env.TEST_MODE      === 'true';
const TEST_BATCH_ID        = process.env.TEST_BATCH_ID  || null;
// Fixed call-id list for test runs — ensures every model scores the SAME calls.
const TEST_CALL_IDS        = (process.env.TEST_CALL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const BATCH_MODE           = process.env.BATCH_MODE     === 'true';
// Gemini Batch API two-phase controls.
const BATCH_ACTION         = process.env.BATCH_ACTION  || '';   // '' | 'submit' | 'ingest'
const BACKFILL_DAYS        = parseInt(process.env.BACKFILL_DAYS || '0', 10);
const GEMINI_CHUNK         = parseInt(process.env.GEMINI_CHUNK  || '500', 10);
const DRY_RUN              = process.env.DRY_RUN        === 'true';

// ── Outcome scoring table (Taxonomy v3) ──────────────────────
// Fallback scores used when outcome_weights table is unavailable.
// Live weights are managed via the dashboard admin UI.
const OUTCOME_SCORES = {
  sale:                        { pub: 10,  adv: 10  },
  appointment:                 { pub: 10,  adv: 10  },
  quoted_interested:           { pub: 3,   adv: 3   },
  quoted_undecided:            { pub: 2,   adv: 2   },
  quoted_too_expensive:        { pub: 0,   adv: 0   },
  quoted_not_interested:       { pub: 0,   adv: 0   },
  quoted_abandoned:            { pub: -1,  adv: 0   },
  not_interested:              { pub: 0,   adv: 0   },
  undecided:                   { pub: 0,   adv: 0   },
  caller_callback:             { pub: 0,   adv: 0   },
  caller_hangup:               { pub: 0,   adv: 0   },
  audio_issue:                 { pub: 0,   adv: 0   },
  referral:                    { pub: 0,   adv: 0   },
  ivr_hangup:                  { pub: 0,   adv: 0   },
  publisher_wrong_category:    { pub: -3,  adv: 0   },
  misrouted:                   { pub: -3,  adv: 0   },
  caller_confused:             { pub: -3,  adv: 0   },
  customer_service:            { pub: -2,  adv: 0   },
  soliciting:                  { pub: -5,  adv: 0   },
  advertiser_service_mismatch: { pub: 0,   adv: -3  },
  outside_geo:                 { pub: 0,   adv: -3  },
  agent_not_available:         { pub: 0,   adv: -3  },
  voicemail:                   { pub: 0,   adv: -3  },
  outside_hours:               { pub: 0,   adv: -3  },
  agent_callback:              { pub: 0,   adv: -2  },
  agent_confused:              { pub: -3,  adv: -2  },
  other:                       { pub: 0,   adv: 0   },
  test:                        { pub: 0,   adv: 0   },
};

const VALID_OUTCOMES = Object.keys(OUTCOME_SCORES);

const VALID_FLAGS = [
  'outbound_dial',
  'facebook_marketplace',
  'angry_caller',
  'wrong_business',
  'duplicate_caller',
];
// geo_mismatch is NOT model-decided anymore — it's injected by code by comparing
// the caller's spoken zip (extracted by the model as stated_zip) to the Canoe zip.

// Normalize a zip to its first 5 digits for comparison ("10307-1234" -> "10307").
function first5Zip(z) {
  const d = String(z || '').replace(/\D/g, '');
  return d.length >= 5 ? d.slice(0, 5) : '';
}
// Decide geo_mismatch deterministically. Requires BOTH a Canoe zip and a spoken
// zip; fires only when they differ. No Canoe zip -> never fires.
function isGeoMismatch(canoeZip, statedZip) {
  const a = first5Zip(canoeZip), b = first5Zip(statedZip);
  return !!a && !!b && a !== b;
}

// ── Prompts (Taxonomy v3) ─────────────────────────────────────

const OUTCOME_SYSTEM = `You are a call quality analyst for a pay-per-call network. Classify the call outcome from the transcript.

Each call receives exactly one outcome. Follow the priority order below — stop at the first step that applies.

PRIORITY ORDER:
1. is_test flag or caller confirms test call → test
2. No agent connection (IVR only, caller dropped before live agent) → ivr_hangup
3. Was a specific price or quote stated or actively being gathered?
   YES →
     - Sale confirmed (payment taken, booking with payment, date+time+payment) → sale
     - Specific date AND time confirmed by both parties → appointment
     - Caller expressed clear interest but no booking → quoted_interested
     - Caller undecided, wants to think/compare → quoted_undecided
     - Caller explicitly cited price as too high → quoted_too_expensive
     - Caller explicitly declined for a non-price reason → quoted_not_interested
     - Call ended abruptly with no explanation after price → quoted_abandoned
   NO → continue
4. Did the call fail due to publisher routing?
   - Caller mentions a specific named business they tried to reach, OR carrier/recycled number → misrouted
   - Caller's vertical need belongs in a different vertical that exists in the network → publisher_wrong_category
   - Caller was confused by a misleading ad → caller_confused
   - Caller references an existing account/order/invoice with this advertiser → customer_service
   - Caller is a vendor trying to sell to the advertiser → soliciting
5. Did the call fail due to advertiser capability?
   - Correct vertical but this advertiser's service is too narrow → advertiser_service_mismatch
   - Agent/advertiser confirmed they don't service caller's location → outside_geo
   - No live agent answered (hold queue, system message) → agent_not_available
   - Voicemail greeting played → voicemail
   - Agent explicitly requested to call caller back → agent_callback
   - Message/agent confirmed business is closed at time of call → outside_hours
6. Did agent confusion cause the call to fail?
   - Agent (not caller) caused failure by not understanding caller's need or their own service → agent_confused
7. Genuine conversation but no outcome?
   - Caller engaged, inconclusive end, no price → undecided
   - Caller explicitly declined, no price → not_interested
   - Agent referred caller to a specific alternative provider → referral
   - Explicit callback commitment from either side → caller_callback
8. Call ended with no explanation?
   - Short call, no real conversation, unexplained disconnect → caller_hangup
   - Audio failure confirmed (static, couldn't hear) → audio_issue
9. Nothing above fits → other (you MUST include a one-line outcome_note)

VALID OUTCOMES:
${VALID_OUTCOMES.join(', ')}

KEY DEFINITIONS (apply literally from transcript evidence):
- sale: Transaction completed — purchase agreed AND payment taken or booking confirmed with payment details, OR specific date+time scheduled with payment confirmed.
- appointment: Specific date AND time confirmed by BOTH parties before call ends. Vague "next week" or "sometime" is NOT an appointment.
- quoted_interested: Price stated + caller said yes/interested/send details — but no booking completed.
- quoted_undecided: Price stated + caller said let me think/compare/discuss. Do NOT use if caller clearly declined.
- quoted_too_expensive: Price stated + caller explicitly cited cost as the reason (too expensive, too high, double what I pay, can't afford).
- quoted_not_interested: Price stated + caller explicitly declined for a reason OTHER than price.
- quoted_abandoned: Price stated or being gathered + call ended abruptly with no reason from caller. Fraud signal.
- not_interested: Caller declined with NO price given.
- undecided: Genuine conversation, NO price given, call ended inconclusively.
- caller_hangup: LAST RESORT for unexplained short disconnects only. No conversation, no price, no stated reason. Do NOT use as default.
- publisher_wrong_category: Caller's need belongs in a different vertical AND that vertical exists in the network. Test: would the same call succeed in the correct vertical?
- misrouted: Caller names a specific business they were trying to reach. OR call has no plausible connection to the vertical (carrier/recycled number).
- caller_confused: Caller's stated need substantially differs from the vertical reached, and the confusion appears to come from the ad. Not just a quick clarifying question.
- customer_service: Caller references an existing order, account, invoice, or prior service with THIS specific advertiser.
- soliciting: Caller is trying to sell something TO the advertiser. Requires clear evidence — if unclear, use caller_confused.
- advertiser_service_mismatch: Vertical is correct. This specific advertiser's offering is too narrow. A different advertiser in the same vertical could have helped.
- outside_geo: Agent or advertiser explicitly confirmed they do NOT service caller's location. Caller volunteering their location alone is not enough.
- agent_not_available: No live agent answered — hold queue message, "all agents busy," or system failed to connect. Do NOT use if voicemail played.
- voicemail: Voicemail greeting played and caller could leave a message.
- outside_hours: Automated message or agent confirmed business is closed or not taking calls at this time.
- agent_callback: Agent (not caller) explicitly stated they or a specialist will call the caller back.
- agent_confused: Agent caused the call to fail because they did not understand the caller's request OR their own company's services. Agent must be the source of confusion.
- ivr_hangup: Caller was in IVR menu and disconnected before any agent connection.
- other: Last resort only. Every use REQUIRES a one-line outcome_note.

Respond with valid JSON only:
{
  "outcome": "<outcome>",
  "summary": "<2-3 sentence summary of the call>",
  "outcome_note": "<required only if outcome is 'other', otherwise null>"
}`;

const COMPLIANCE_SYSTEM = `You are a compliance analyst for a pay-per-call network. Detect compliance issues in the call transcript.

FLAG DEFINITIONS:
- outbound_dial: Caller indicates they did not place this call — someone called them first (e.g. "you called me", "I got a call from this number", "someone from your company called me").
- facebook_marketplace: Any mention of Facebook, Facebook Marketplace, or a Facebook ad/listing as the reason for calling.
- angry_caller: Caller is hostile, aggressive, or explicitly upset. Often coincides with outbound_dial.
- wrong_business: Caller explicitly states they were trying to reach a different, specific named business (e.g. "I was trying to call Terminix, not you").
- duplicate_caller: Same caller number appears in a different vertical or from a different publisher within 48 hours (detected externally — do not flag from transcript alone).

Also evaluate: suspicious_call — true if the caller does not appear to be a genuine lead (testing the system, probing without intent to buy, or other ulterior motive).

ZIP EXTRACTION (not a flag): If the caller explicitly says their ZIP code aloud, return it normalized to 5 digits in stated_zip. Only a ZIP the caller actually speaks — do NOT infer one from a city, state, or area code. If no ZIP is spoken, stated_zip is null.

Respond with valid JSON only:
{
  "flags": ["flag1", "flag2"],
  "flag_notes": { "flag_name": "brief reason why this was flagged" },
  "suspicious_call": false,
  "suspicious_note": null,
  "stated_zip": "12345" or null
}

If no flags apply, return: { "flags": [], "flag_notes": {}, "suspicious_call": false, "suspicious_note": null, "stated_zip": null }`;

const COMBINED_SYSTEM = `You are a call quality and compliance analyst for a pay-per-call network. Analyze the transcript and return both an outcome classification and compliance flags.

${OUTCOME_SYSTEM.replace('Respond with valid JSON only:', '').replace(/\{[\s\S]*?\}$/, '').trim()}

${COMPLIANCE_SYSTEM.replace('Respond with valid JSON only:', '').replace(/\{[\s\S]*?\}[\s\S]*$/, '').trim()}

Respond with valid JSON only:
{
  "outcome": "<outcome>",
  "summary": "<2-3 sentence summary>",
  "outcome_note": "<required only if outcome is 'other', otherwise null>",
  "flags": ["flag1", "flag2"],
  "flag_notes": { "flag_name": "brief reason" },
  "suspicious_call": false,
  "suspicious_note": null,
  "stated_zip": "12345" or null
}`;

// ── Load prompt from Supabase ─────────────────────────────────
async function loadPrompt() {
  try {
    const filter = PROMPT_ID
      ? `id=eq.${PROMPT_ID}`
      : `is_active=eq.true`;
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_prompts?${filter}&limit=1`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) throw new Error(`Supabase error ${res.status}`);
    const rows = await res.json();
    if (!rows.length) throw new Error('No matching prompt found');
    const p = rows[0];
    console.log(`Using prompt: "${p.name}" (${p.id})`);
    return p;
  } catch (err) {
    console.warn(`Could not load prompt from Supabase (${err.message}), falling back to hardcoded prompts`);
    return null;
  }
}

// Parse a model's JSON reply defensively. Handles: pure JSON, ```json fenced
// blocks, and JSON followed by trailing prose (extracts the first balanced
// {...} object). Throws only if no valid object can be recovered.
function parseModelJson(text) {
  let t = (text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
      else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { break; } } }
    }
  }
  throw new Error(`Could not parse response: ${t.slice(0, 200)}`);
}

// ── LLM API call ──────────────────────────────────────────────
// Namespaced model ids ("anthropic/...", "openai/...", "google/...") route
// through OpenRouter. Bare "gemini-*" ids hit the native Gemini API; other bare
// ids ("claude-sonnet-4-6") hit the Anthropic API.
async function callLLM(system, userMessage) {
  if (AI_MODEL.includes('/')) return callOpenRouter(system, userMessage);
  if (/^gemini/i.test(AI_MODEL)) return callGemini(system, userMessage);
  return callClaude(system, userMessage);
}

// Shared Gemini request body — used by both the sync call and each batch item.
// systemInstruction carries the system prompt; responseMimeType forces clean JSON.
function geminiRequestBody(system, userMessage) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature:      0.1,
      maxOutputTokens:  MAX_TOKENS,
      responseMimeType: 'application/json',
    },
  };
}

async function callGemini(system, userMessage) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiRequestBody(system, userMessage)),
    }
  );
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  const usage = {
    input:  data.usageMetadata?.promptTokenCount     || 0,
    output: data.usageMetadata?.candidatesTokenCount || 0,
  };
  return { result: parseModelJson(text), usage };
}

async function callClaude(system, userMessage) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      AI_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content[0].text.trim();
  const usage = { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 };
  return { result: parseModelJson(text), usage };
}

async function callOpenRouter(system, userMessage) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  let res, lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type':  'application/json',
          'X-Title':       'BLCalls Compliance',
        },
        body: JSON.stringify({
          model:       AI_MODEL,
          max_tokens:  MAX_TOKENS,
          temperature: 0.1,
          // Force a clean JSON object — no markdown fences or preamble prose.
          // (Our prompt already instructs "valid JSON only", which json_object mode requires.)
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user',   content: userMessage },
          ],
        }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`transient ${res.status}`);
      break;  // got a usable (2xx/4xx) response
    } catch (e) {
      lastErr = e;
      if (attempt === 4) throw new Error(`OpenRouter fetch failed after 4 attempts: ${e.message}`);
      await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }

  if (!res.ok) throw new Error(`OpenRouter API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.choices || !data.choices.length) throw new Error(`OpenRouter returned no choices: ${JSON.stringify(data).slice(0, 300)}`);
  const text = (data.choices[0].message.content || '').trim();
  const usage = { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 };
  return { result: parseModelJson(text), usage };
}

// ── Duplicate caller detection ────────────────────────────────
async function flagDuplicateCallers(callIds) {
  // Find calls in our batch where the same called_from appears in a different
  // vertical or from a different publisher within 48 hours
  const idsParam = callIds.map(id => `"${id}"`).join(',');

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/find_duplicate_callers`,
      {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ call_ids: callIds }),
      }
    );
    if (!res.ok) return new Set();
    const rows = await res.json();
    return new Set((rows || []).map(r => r.id));
  } catch (e) {
    console.warn('Duplicate detection skipped (non-fatal):', e.message);
    return new Set();
  }
}

// ── Supabase helpers ──────────────────────────────────────────
async function fetchUnprocessed() {
  let filter = 'ai_processed_at=is.null&transcription=not.is.null&transcription=neq.';
  // Backfill: only calls newer than BACKFILL_DAYS (still unprocessed-only).
  if (BACKFILL_DAYS > 0) {
    const since = new Date(Date.now() - BACKFILL_DAYS * 86400000).toISOString();
    filter += `&created_at=gte.${since}`;
  }
  const select = 'select=id,transcription,zip,vertical_name,called_from,duration,created_at,canoe_outcome';
  // Page via offset so a large backfill isn't silently capped by the server's
  // per-request row limit. Caps at BATCH_SIZE total.
  const PAGE = 1000;
  const out = [];
  while (out.length < BATCH_SIZE) {
    const want = Math.min(PAGE, BATCH_SIZE - out.length);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/canoe_calls?${filter}&${select}&order=created_at.asc&offset=${out.length}&limit=${want}`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) throw new Error(`Supabase fetch error ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < want) break;  // exhausted
  }
  return out;
}

async function writeResult(id, result) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/canoe_calls?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(result),
    }
  );
  if (!res.ok) throw new Error(`Supabase write error ${res.status}: ${await res.text()}`);
}

// ── Test-mode helpers ─────────────────────────────────────────
async function fetchTestSample() {
  const select = 'select=id,transcription,zip,vertical_name,called_from,duration,created_at,canoe_outcome';
  // If a fixed id list is provided, score exactly those calls (same set for every model).
  const filter = TEST_CALL_IDS.length
    ? `id=in.(${TEST_CALL_IDS.join(',')})`
    : `transcription=not.is.null&transcription=neq.&order=created_at.desc&limit=${BATCH_SIZE}`;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/canoe_calls?${select}&${filter}`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  if (!res.ok) throw new Error(`Supabase fetch error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function updateTestStatus(testId, status) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/model_tests?id=eq.${testId}`,
    {
      method: 'PATCH',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({ status }),
    }
  );
}

async function writeTestResult(testId, callId, outcome, flags, rawResponse, inputTokens, outputTokens) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/model_test_results`,
    {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        test_id:       testId,
        call_id:       callId,
        model:         AI_MODEL,
        our_outcome:   outcome,
        flags:         flags,
        raw_response:  rawResponse,
        input_tokens:  inputTokens,
        output_tokens: outputTokens,
      }),
    }
  );
  if (!res.ok) throw new Error(`Supabase write error ${res.status}: ${await res.text()}`);
}

// Build the canoe_calls patch from a parsed model reply + call context.
// Centralizes outcome validation, flag filtering, the code-decided duplicate_caller
// and geo_mismatch flags, and score lookup — shared by the Anthropic-batch and
// Gemini-batch paths. (geo_mismatch is added after the VALID_FLAGS filter on purpose.)
function buildResultPatch(callId, parsed, callZip, duplicateIds, activePromptId, modelId = AI_MODEL) {
  let outcome = parsed.outcome;
  if (!VALID_OUTCOMES.includes(outcome)) outcome = 'other';

  let flags = (parsed.flags || []).filter(f => VALID_FLAGS.includes(f));
  if (duplicateIds.has(callId) && !flags.includes('duplicate_caller')) flags.push('duplicate_caller');
  if (isGeoMismatch(callZip, parsed.stated_zip) && !flags.includes('geo_mismatch')) flags.push('geo_mismatch');

  const scores = OUTCOME_SCORES[outcome] || { pub: 0, adv: 0 };
  return {
    our_outcome:      outcome,
    our_summary:      parsed.summary,
    publisher_score:  scores.pub,
    advertiser_score: scores.adv,
    flags,
    suspicious_call:  parsed.suspicious_call || false,
    ai_model:         modelId,
    ai_processed_at:  new Date().toISOString(),
    prompt_id:        activePromptId,
  };
}

// ── Anthropic batch API helpers ───────────────────────────────
async function submitBatch(requests) {
  const res = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Batch submit error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function pollBatch(batchId) {
  const deadline = Date.now() + 2 * 60 * 60 * 1000; // 2hr max (GitHub Actions limit)
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 60_000));
    const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) throw new Error(`Batch poll error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const counts = data.request_counts || {};
    console.log(`  Batch ${batchId}: ${data.processing_status} — succeeded:${counts.succeeded||0} errored:${counts.errored||0} processing:${counts.processing||0}`);
    if (data.processing_status === 'ended') return data;
  }
  throw new Error(`Batch timed out after 2 hours. Batch ID: ${batchId} — results still available via Anthropic console.`);
}

async function fetchBatchResults(batchId) {
  const res = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}/results`, {
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) throw new Error(`Batch results error ${res.status}: ${await res.text()}`);
  return (await res.text()).trim().split('\n').map(l => JSON.parse(l));
}

async function runBatch(calls, systemPrompt, duplicateIds, activePromptId) {
  const zipById = Object.fromEntries(calls.map(c => [c.id, c.zip]));
  const requests = calls.map(call => {
    const context = [
      `Vertical: ${call.vertical_name || 'Unknown'}`,
      `Duration: ${call.duration}s`,
      `Transaction zip: ${call.zip || 'Unknown'}`,
      `Canoe outcome: ${call.canoe_outcome || 'Unknown'}`,
    ].join('\n');
    return {
      custom_id: call.id,
      params: { model: AI_MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, messages: [{ role: 'user', content: `${context}\n\nTranscript:\n${call.transcription}` }] },
    };
  });

  const batch = await submitBatch(requests);
  console.log(`Batch submitted: ${batch.id} — polling every 60s (max 2hr)`);

  await pollBatch(batch.id);
  const results = await fetchBatchResults(batch.id);

  let processed = 0, errors = 0;
  for (const item of results) {
    if (item.result.type !== 'succeeded') { console.error(`  [${item.custom_id}] Batch error: ${item.result.error?.message}`); errors++; continue; }
    try {
      const data    = item.result.message;
      const text    = data.content[0].text.trim();
      let parsed;
      try { parsed = parseModelJson(text); } catch { parsed = null; }
      if (!parsed) { console.error(`  [${item.custom_id}] Could not parse response`); errors++; continue; }

      await writeResult(item.custom_id, buildResultPatch(item.custom_id, parsed, zipById[item.custom_id], duplicateIds, activePromptId));
      processed++;
    } catch(e) { console.error(`  [${item.custom_id}] ${e.message}`); errors++; }
  }
  console.log(`Batch done. Processed: ${processed}, Errors: ${errors}`);
}

// ── Gemini Batch API ──────────────────────────────────────────
// Two-phase: submit() records jobs and exits; ingest() (a later run) polls those
// jobs and writes finished results. Glued by the gemini_batch_jobs table so a job
// can outlive the 6h GitHub Actions cap (Gemini batch SLO is up to 24h).
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function submitGeminiBatch(requests, displayName) {
  const res = await fetch(`${GEMINI_BASE}/models/${AI_MODEL}:batchGenerateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch: { displayName, inputConfig: { requests: { requests } } } }),
  });
  if (!res.ok) throw new Error(`Gemini batch submit error ${res.status}: ${await res.text()}`);
  return res.json();  // { name: "batches/…", metadata: { state, … } }
}

async function getGeminiBatch(jobName) {
  const res = await fetch(`${GEMINI_BASE}/${jobName}`, {
    headers: { 'x-goog-api-key': GEMINI_API_KEY },
  });
  if (!res.ok) throw new Error(`Gemini batch get error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── gemini_batch_jobs tracking table ──────────────────────────
async function insertBatchJob(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/gemini_batch_jobs`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Batch job insert error ${res.status}: ${await res.text()}`);
}

async function fetchPendingBatchJobs() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/gemini_batch_jobs?status=in.(submitted,processing)&order=submitted_at.asc`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Batch job fetch error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Calls already in an open (submitted/processing) job. Submit stamps nothing on
// canoe_calls, so we dedupe here to avoid re-submitting the same calls (double
// cost) on overlapping nightly runs or a re-dispatched backfill.
async function fetchInFlightCallIds() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/gemini_batch_jobs?status=in.(submitted,processing)&select=call_ids`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) throw new Error(`In-flight fetch error ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  const set = new Set();
  for (const r of rows) for (const id of (r.call_ids || [])) set.add(id);
  return set;
}

async function updateBatchJob(id, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/gemini_batch_jobs?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Batch job update error ${res.status}: ${await res.text()}`);
}

// Re-fetch the Canoe zip per call at ingest time — needed for the code-decided
// geo_mismatch flag, since submit and ingest run in separate processes.
async function fetchCallZips(ids) {
  if (!ids.length) return {};
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/canoe_calls?id=in.(${ids.join(',')})&select=id,zip`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Zip fetch error ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return Object.fromEntries(rows.map(r => [r.id, r.zip]));
}

// ── Gemini submit / ingest ────────────────────────────────────
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runGeminiSubmit(calls, systemPrompt, activePromptId) {
  if (!/^gemini/i.test(AI_MODEL)) throw new Error(`BATCH_ACTION=submit requires a Gemini model; got "${AI_MODEL}"`);
  if (!GEMINI_API_KEY && !DRY_RUN) throw new Error('GEMINI_API_KEY not set');

  // Drop calls already in an open job so we never submit (and pay for) them twice.
  const inFlight = await fetchInFlightCallIds();
  const fresh    = calls.filter(c => !inFlight.has(c.id));
  if (fresh.length < calls.length) console.log(`Skipping ${calls.length - fresh.length} call(s) already in open batch jobs`);
  if (fresh.length === 0) { console.log('All candidate calls already in flight. Nothing to submit.'); return; }

  const day    = new Date().toISOString().slice(0, 10);
  const chunks = chunk(fresh, GEMINI_CHUNK);
  console.log(`Submitting ${fresh.length} calls in ${chunks.length} job(s) of up to ${GEMINI_CHUNK}`);

  let submitted = 0;
  for (let idx = 0; idx < chunks.length; idx++) {
    const group = chunks[idx];
    const requests = group.map(call => {
      const context = [
        `Vertical: ${call.vertical_name || 'Unknown'}`,
        `Duration: ${call.duration}s`,
        `Transaction zip: ${call.zip || 'Unknown'}`,
        `Canoe outcome: ${call.canoe_outcome || 'Unknown'}`,
      ].join('\n');
      return {
        request:  geminiRequestBody(systemPrompt, `${context}\n\nTranscript:\n${call.transcription}`),
        metadata: { key: call.id },
      };
    });

    if (DRY_RUN) {
      console.log(`  [dry-run] job ${idx + 1}/${chunks.length}: ${group.length} requests (not submitting)`);
      continue;
    }

    const job = await submitGeminiBatch(requests, `blcalls-${day}-${idx + 1}`);
    await insertBatchJob({
      job_name:   job.name,
      model:      AI_MODEL,
      prompt_id:  activePromptId,
      status:     'submitted',
      call_ids:   group.map(c => c.id),
      call_count: group.length,
    });
    console.log(`  Submitted ${job.name} (${group.length} calls)`);
    submitted++;
  }
  console.log(`Submit done. ${submitted} job(s) recorded${DRY_RUN ? ' (dry-run: 0 real)' : ''}.`);
}

async function runGeminiIngest() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const jobs = await fetchPendingBatchJobs();
  console.log(`Found ${jobs.length} open batch job(s)`);

  for (const job of jobs) {
    try {
      const data  = await getGeminiBatch(job.job_name);
      const state = data.metadata?.state || data.state || 'UNKNOWN';
      console.log(`  ${job.job_name}: ${state}`);

      if (/PENDING|RUNNING/.test(state)) {
        if (job.status !== 'processing') await updateBatchJob(job.id, { status: 'processing' });
        continue;  // still working — try again next ingest run
      }

      if (/SUCCEEDED/.test(state)) {
        await ingestSucceededJob(job, data);
        continue;
      }

      // Terminal failure — leave the calls unprocessed so a future submit retries them.
      const status = /EXPIRED/.test(state) ? 'expired' : /CANCELLED/.test(state) ? 'cancelled' : 'failed';
      await updateBatchJob(job.id, { status, error: state, completed_at: new Date().toISOString() });
      console.error(`  Job ${job.job_name} ended ${state} — its calls stay unprocessed for a future submit.`);
    } catch (e) {
      console.error(`  [${job.job_name}] ingest error: ${e.message}`);
    }
  }
}

async function ingestSucceededJob(job, data) {
  const callIds = job.call_ids || [];
  // Inline results come back in submit order; some shapes double-nest the array.
  const inline    = data.response?.inlinedResponses;
  const responses = Array.isArray(inline) ? inline : (inline?.inlinedResponses || []);

  const zipById      = await fetchCallZips(callIds);
  const duplicateIds = await flagDuplicateCallers(callIds);

  let processed = 0, errors = 0;
  for (let i = 0; i < responses.length; i++) {
    const item   = responses[i];
    const callId = item.metadata?.key || callIds[i];   // prefer echoed key, else submit order
    if (!callId) { errors++; continue; }
    try {
      if (item.error) { console.error(`  [${callId}] item error: ${JSON.stringify(item.error).slice(0, 200)}`); errors++; continue; }
      const text = (item.response?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      let parsed;
      try { parsed = parseModelJson(text); } catch { parsed = null; }
      if (!parsed) { console.error(`  [${callId}] could not parse response`); errors++; continue; }

      await writeResult(callId, buildResultPatch(callId, parsed, zipById[callId], duplicateIds, job.prompt_id, job.model));
      processed++;
    } catch (e) { console.error(`  [${callId}] ${e.message}`); errors++; }
  }

  await updateBatchJob(job.id, {
    status:       'completed',
    completed_at: new Date().toISOString(),
    error:        errors ? `${errors} item error(s)` : null,
  });
  console.log(`  Ingested ${job.job_name}: processed ${processed}, errors ${errors}`);
}

// ── Main ──────────────────────────────────────────────────────
async function run() {
  console.log(`Starting AI processing — model: ${AI_MODEL}, mode: ${AI_MODE}, action: ${BATCH_ACTION || 'sync'}, test: ${TEST_MODE}`);

  // Gemini batch INGEST needs no prompt or call fetch — it drains prior jobs.
  if (BATCH_ACTION === 'ingest') {
    await runGeminiIngest();
    return;
  }

  // Load prompt from Supabase (falls back to hardcoded if unavailable)
  const promptRow = await loadPrompt();
  const activePromptId = promptRow?.id || null;
  const outcomePrompt    = promptRow?.outcome_prompt    || OUTCOME_SYSTEM;
  const compliancePrompt = promptRow?.compliance_prompt || COMPLIANCE_SYSTEM;
  const combinedPrompt   = promptRow
    ? `You are a call quality and compliance analyst for a pay-per-call network. Analyze the transcript and return both an outcome classification and compliance flags.\n\n${outcomePrompt.replace('Respond with valid JSON only:', '').trim()}\n\n${compliancePrompt.replace('Respond with valid JSON only:', '').trim()}\n\nRespond with valid JSON only:\n{\n  "outcome": "<outcome>",\n  "summary": "<2-3 sentence summary>",\n  "outcome_note": "<required only if outcome is 'other', otherwise null>",\n  "flags": ["flag1", "flag2"],\n  "flag_notes": { "flag_name": "brief reason" },\n  "suspicious_call": false,\n  "suspicious_note": null,\n  "stated_zip": "12345" or null\n}`
    : COMBINED_SYSTEM;

  if (TEST_MODE && !TEST_BATCH_ID) {
    console.error('TEST_MODE=true requires TEST_BATCH_ID to be set');
    process.exit(1);
  }

  if (TEST_MODE) await updateTestStatus(TEST_BATCH_ID, 'running');

  const calls = TEST_MODE ? await fetchTestSample() : await fetchUnprocessed();
  console.log(`Found ${calls.length} calls to process`);

  if (calls.length === 0) {
    console.log('Nothing to process.');
    return;
  }

  // Gemini batch SUBMIT: fan calls into async jobs, record them, and exit.
  // Duplicate + geo flags are applied later at ingest time.
  if (BATCH_ACTION === 'submit') {
    await runGeminiSubmit(calls, combinedPrompt, activePromptId);
    return;
  }

  const duplicateIds = await flagDuplicateCallers(calls.map(c => c.id));
  console.log(`Duplicate caller IDs found: ${duplicateIds.size}`);

  // Batch mode: Anthropic batch API only (bare Claude ids). OpenRouter models
  // (namespaced ids) don't support it — fall through to sequential processing.
  if (BATCH_MODE && !AI_MODEL.includes('/') && !TEST_MODE) {
    await runBatch(calls, combinedPrompt, duplicateIds, activePromptId);
    return;
  }

  let processed = 0;
  let errors = 0;

  for (const call of calls) {
    try {
      const context = [
        `Vertical: ${call.vertical_name || 'Unknown'}`,
        `Duration: ${call.duration}s`,
        `Transaction zip: ${call.zip || 'Unknown'}`,
        `Canoe outcome: ${call.canoe_outcome || 'Unknown'}`,
      ].join('\n');

      const userMessage = `${context}\n\nTranscript:\n${call.transcription}`;

      let outcome, summary, outcome_note, flags, flag_notes, suspicious_call, suspicious_note, stated_zip;
      let totalInputTokens = 0, totalOutputTokens = 0;

      if (AI_MODE === 'combined') {
        const { result, usage } = await callLLM(combinedPrompt, userMessage);
        outcome       = result.outcome;
        summary       = result.summary;
        outcome_note  = result.outcome_note;
        flags         = result.flags || [];
        flag_notes    = result.flag_notes || {};
        suspicious_call = result.suspicious_call || false;
        suspicious_note = result.suspicious_note || null;
        stated_zip    = result.stated_zip || null;
        totalInputTokens  = usage.input;
        totalOutputTokens = usage.output;
      } else {
        const [{ result: outcomeResult, usage: u1 }, { result: complianceResult, usage: u2 }] = await Promise.all([
          callLLM(outcomePrompt, userMessage),
          callLLM(compliancePrompt, userMessage),
        ]);
        outcome       = outcomeResult.outcome;
        summary       = outcomeResult.summary;
        outcome_note  = outcomeResult.outcome_note;
        flags         = complianceResult.flags || [];
        flag_notes    = complianceResult.flag_notes || {};
        suspicious_call = complianceResult.suspicious_call || false;
        suspicious_note = complianceResult.suspicious_note || null;
        stated_zip    = complianceResult.stated_zip || null;
        totalInputTokens  = u1.input + u2.input;
        totalOutputTokens = u1.output + u2.output;
      }

      if (!VALID_OUTCOMES.includes(outcome)) {
        console.warn(`  [${call.id}] Invalid outcome "${outcome}", falling back to "other"`);
        outcome = 'other';
      }

      if (duplicateIds.has(call.id) && !flags.includes('duplicate_caller')) {
        flags.push('duplicate_caller');
      }

      flags = flags.filter(f => VALID_FLAGS.includes(f));

      // geo_mismatch is code-decided: caller's spoken zip vs the Canoe zip.
      if (isGeoMismatch(call.zip, stated_zip) && !flags.includes('geo_mismatch')) {
        flags.push('geo_mismatch');
      }

      const scores = OUTCOME_SCORES[outcome] || { pub: 0, adv: 0 };

      if (TEST_MODE) {
        await writeTestResult(TEST_BATCH_ID, call.id, outcome, flags, { outcome, summary, flags, suspicious_call, stated_zip }, totalInputTokens, totalOutputTokens);
      } else {
        await writeResult(call.id, {
          our_outcome:      outcome,
          our_summary:      summary,
          publisher_score:  scores.pub,
          advertiser_score: scores.adv,
          flags,
          suspicious_call,
          ai_model:         AI_MODEL,
          ai_processed_at:  new Date().toISOString(),
          prompt_id:        activePromptId,
        });
      }

      processed++;
      if (processed % 10 === 0) console.log(`  Processed ${processed}/${calls.length}`);

    } catch (err) {
      console.error(`  [${call.id}] Error: ${err.message}`);
      errors++;
    }
  }

  console.log(`Done. Processed: ${processed}, Errors: ${errors}`);
  if (TEST_MODE) await updateTestStatus(TEST_BATCH_ID, errors === 0 ? 'completed' : 'failed');
}

run().catch(err => {
  console.error('Processing failed:', err.message);
  process.exit(1);
});
