/**
 * process.js
 * Reads unprocessed calls from canoe_calls, runs AI analysis,
 * writes outcome + compliance flags back to the same row.
 *
 * Required env vars:
 *   SUPABASE_URL          - e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  - service role key
 *   ANTHROPIC_API_KEY     - Claude API key
 *   AI_MODEL              - e.g. claude-sonnet-4-6 (default)
 *   AI_MODE               - "combined" (default) or "separate"
 *   BATCH_SIZE            - number of calls to process per run (default 100)
 */

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const AI_MODEL             = process.env.AI_MODEL || 'claude-sonnet-4-6';
const AI_MODE              = process.env.AI_MODE  || 'combined';
const BATCH_SIZE           = parseInt(process.env.BATCH_SIZE || '100', 10);

// ── Outcome scoring table ─────────────────────────────────────
const OUTCOME_SCORES = {
  sale:                  { pub: 10, adv: 10 },
  appointment:           { pub: 10, adv: 10 },
  quoted_interested:     { pub: 3,  adv: 3  },
  quoted_undecided:      { pub: 2,  adv: 2  },
  quoted_too_expensive:  { pub: 0,  adv: 0  },
  quoted_not_interested: { pub: -1, adv: 0  },
  undecided:             { pub: 0,  adv: 0  },
  not_interested:        { pub: 0,  adv: 0  },
  caller_callback:       { pub: 0,  adv: 0  },
  agent_callback:        { pub: 0,  adv: -2 },
  caller_hangup:         { pub: 0,  adv: 0  },
  ivr_hangup:            { pub: 0,  adv: 0  },
  voicemail:             { pub: 0,  adv: -3 },
  agent_not_available:   { pub: 0,  adv: -3 },
  audio_issue:           { pub: 0,  adv: 0  },
  outside_geo:           { pub: -1, adv: -3 },
  wrong_category:        { pub: -3, adv: 0  },
  misrouted:             { pub: -3, adv: 0  },
  caller_confused:       { pub: -3, adv: 0  },
  agent_confused:        { pub: -3, adv: -2 },
  customer_service:      { pub: -2, adv: 0  },
  soliciting:            { pub: -5, adv: 0  },
  referral:              { pub: 0,  adv: 0  },
  outside_hours:         { pub: 0,  adv: -3 },
  test:                  { pub: 0,  adv: 0  },
  other:                 { pub: 0,  adv: 0  },
};

const VALID_OUTCOMES = Object.keys(OUTCOME_SCORES);

const VALID_FLAGS = [
  'outbound_dial',
  'facebook_marketplace',
  'angry_caller',
  'wrong_business',
  'incentivized_caller',
  'geo_mismatch',
  'duplicate_caller',
];

// ── Prompts ───────────────────────────────────────────────────

const OUTCOME_SYSTEM = `You are a call quality analyst for a pay-per-call network. Your job is to classify call outcomes from transcripts.

CLASSIFICATION RULES (follow in order):
1. audio_issue, ivr_hangup, voicemail, agent_not_available take priority over caller_hangup.
2. Within the quoted_/undecided/not_interested family: check if a specific price was stated. If yes, use the quoted_ version. If no price, use the plain version.
3. caller_hangup is the fallback for unexplained disconnect only — not a default for short or unclear calls.
4. other is last resort. Always include a one-line note if you use it.

VALID OUTCOMES:
${VALID_OUTCOMES.join(', ')}

OUTCOME DEFINITIONS:
- sale: Caller completed a purchase, OR financial/payment information was actually exchanged, OR a specific pickup/delivery date and time was scheduled.
- appointment: Caller and agent agreed on a specific date and time for a service technician or representative to meet the caller.
- quoted_interested: Agent provided a specific price, caller expressed clear intent to move forward, but call ended before payment or confirmed schedule.
- quoted_undecided: Agent provided a specific price, caller stated they need time to think or consult someone. Only use if price was given.
- quoted_too_expensive: Agent provided a specific price, caller explicitly cited price as reason for not proceeding.
- quoted_not_interested: Agent provided a specific price, caller declined for a reason other than price. Only use if price was given.
- undecided: Caller needs time to think. Only use if NO specific price was given.
- not_interested: Caller declined for a reason unrelated to cost. Only use if NO price was given.
- caller_callback: Caller stated they would call back later.
- agent_callback: Agent told caller someone would call them back.
- caller_hangup: FALLBACK only — caller disconnected before any other outcome applies.
- ivr_hangup: Caller stuck in automated menu, no input registered, disconnected without reaching live agent.
- voicemail: Call answered by recorded greeting prompting caller to leave a message. Must have explicit transcript evidence.
- agent_not_available: Caller on hold or in queue, call ends before live agent ever speaks, no voicemail heard.
- audio_issue: Call could not proceed due to poor connection quality or language barrier.
- outside_geo: Caller states their location AND agent explicitly states the business does not service that area. Both must be present.
- wrong_category: Caller states what service they want AND agent explicitly states business does not offer it.
- misrouted: Caller or agent explicitly states caller reached the wrong business.
- caller_confused: Caller explicitly expresses confusion about why they were connected — asks "who is this?" or states they don't know why they're talking to this agent.
- agent_confused: Agent explicitly states they don't understand why the caller is calling, cannot find caller's record, or asks caller to explain why they reached this business.
- customer_service: Caller explicitly identifies as an existing customer contacting the business about an existing relationship.
- soliciting: Caller is attempting to sell something to the business, not seeking to purchase.
- referral: Agent, unable to help directly, referred caller to a different business or number.
- outside_hours: Agent explicitly states the business is closed or outside business hours.
- test: Call originated from internal QA or test infrastructure (determined from system metadata, not transcript).
- other: Call doesn't fit any outcome above. Include a one-line note.

Respond with valid JSON only:
{
  "outcome": "<outcome>",
  "summary": "<2-3 sentence summary of the call>",
  "outcome_note": "<required only if outcome is 'other', otherwise null>"
}`;

const COMPLIANCE_SYSTEM = `You are a compliance analyst for a pay-per-call network. Your job is to detect compliance issues in call transcripts.

FLAG DEFINITIONS:
- outbound_dial: Evidence that the caller was reached via an outbound dial rather than calling in voluntarily (e.g. caller says "you called me", "I got a call from this number").
- facebook_marketplace: Any mention of Facebook, Facebook Marketplace, or a Facebook ad/listing as the reason for calling.
- angry_caller: Caller is hostile, aggressive, or explicitly upset. Often coincides with outbound_dial.
- wrong_business: Caller explicitly states they were trying to reach a different, specific business (e.g. "I was trying to call Terminix, not you").
- incentivized_caller: Caller mentions being promised money, a gift card, a reward, or any other incentive for making the call.
- geo_mismatch: The zip code or location stated by the caller during the call does not match the zip code passed in the transaction data (provided as context). Only flag if the caller explicitly states a zip code or city/state AND it clearly differs from the transaction zip.

Respond with valid JSON only:
{
  "flags": ["flag1", "flag2"],
  "flag_notes": {
    "flag_name": "brief reason why this was flagged"
  }
}

If no flags apply, return: { "flags": [], "flag_notes": {} }`;

const COMBINED_SYSTEM = `You are a call quality and compliance analyst for a pay-per-call network. Analyze the transcript and return both an outcome classification and compliance flags.

${OUTCOME_SYSTEM.replace('Respond with valid JSON only:', '').trim()}

${COMPLIANCE_SYSTEM.replace('Respond with valid JSON only:', '').trim()}

Respond with valid JSON only:
{
  "outcome": "<outcome>",
  "summary": "<2-3 sentence summary>",
  "outcome_note": "<required only if outcome is 'other', otherwise null>",
  "flags": ["flag1", "flag2"],
  "flag_notes": { "flag_name": "brief reason" }
}`;

// ── Claude API call ───────────────────────────────────────────
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
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content[0].text.trim();

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Could not parse Claude response: ${text}`);
  }
}

// ── Duplicate caller detection ────────────────────────────────
async function flagDuplicateCallers(callIds) {
  // Find calls in our batch where the same called_from appears in a different
  // vertical or from a different publisher within 48 hours
  const idsParam = callIds.map(id => `"${id}"`).join(',');

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
}

// ── Supabase helpers ──────────────────────────────────────────
async function fetchUnprocessed() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/canoe_calls?ai_processed_at=is.null&transcription=not.is.null&transcription=neq.&select=id,transcription,zip,vertical_name,called_from,duration,created_at,canoe_outcome&order=created_at.asc&limit=${BATCH_SIZE}`,
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

// ── Main ──────────────────────────────────────────────────────
async function run() {
  console.log(`Starting AI processing — model: ${AI_MODEL}, mode: ${AI_MODE}`);

  const calls = await fetchUnprocessed();
  console.log(`Found ${calls.length} unprocessed calls`);

  if (calls.length === 0) {
    console.log('Nothing to process.');
    return;
  }

  // Check for duplicate callers across this batch
  const duplicateIds = await flagDuplicateCallers(calls.map(c => c.id));
  console.log(`Duplicate caller IDs found: ${duplicateIds.size}`);

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

      let outcome, summary, outcome_note, flags, flag_notes;

      if (AI_MODE === 'combined') {
        const result = await callClaude(COMBINED_SYSTEM, userMessage);
        outcome      = result.outcome;
        summary      = result.summary;
        outcome_note = result.outcome_note;
        flags        = result.flags || [];
        flag_notes   = result.flag_notes || {};
      } else {
        // Separate passes
        const [outcomeResult, complianceResult] = await Promise.all([
          callClaude(OUTCOME_SYSTEM, userMessage),
          callClaude(COMPLIANCE_SYSTEM, userMessage),
        ]);
        outcome      = outcomeResult.outcome;
        summary      = outcomeResult.summary;
        outcome_note = outcomeResult.outcome_note;
        flags        = complianceResult.flags || [];
        flag_notes   = complianceResult.flag_notes || {};
      }

      // Validate outcome
      if (!VALID_OUTCOMES.includes(outcome)) {
        console.warn(`  [${call.id}] Invalid outcome "${outcome}", falling back to "other"`);
        outcome = 'other';
      }

      // Add duplicate_caller flag if detected
      if (duplicateIds.has(call.id) && !flags.includes('duplicate_caller')) {
        flags.push('duplicate_caller');
      }

      // Filter to valid flags only
      flags = flags.filter(f => VALID_FLAGS.includes(f));

      const scores = OUTCOME_SCORES[outcome] || { pub: 0, adv: 0 };

      await writeResult(call.id, {
        our_outcome:      outcome,
        our_summary:      summary,
        publisher_score:  scores.pub,
        advertiser_score: scores.adv,
        flags,
        ai_model:         AI_MODEL,
        ai_processed_at:  new Date().toISOString(),
      });

      processed++;
      if (processed % 10 === 0) console.log(`  Processed ${processed}/${calls.length}`);

    } catch (err) {
      console.error(`  [${call.id}] Error: ${err.message}`);
      errors++;
    }
  }

  console.log(`Done. Processed: ${processed}, Errors: ${errors}`);
}

run().catch(err => {
  console.error('Processing failed:', err.message);
  process.exit(1);
});
