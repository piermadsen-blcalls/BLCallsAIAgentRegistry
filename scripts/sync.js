/**
 * sync.js
 * Two-pass sync:
 *   Pass 1 — phone-lead-transactions: upserts all calls for the window
 *   Pass 2 — recordings: patches transcription/duration/outcome onto rows
 *             where recording_id is set but transcription is still null
 *             (looks back TRANSCRIPTION_LOOKBACK_DAYS to catch delayed transcriptions)
 *
 * Required env vars:
 *   CANOE_API_URL        - https://exchange-gateway.ringpartner.com
 *   CANOE_API_KEY        - your Canoe API key
 *   SUPABASE_URL         - https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY - service role key (bypasses RLS)
 *
 * Optional env vars:
 *   SYNC_FROM            - ISO string override for window start
 *   SYNC_TO              - ISO string override for window end
 */

const CANOE_API_URL        = process.env.CANOE_API_URL;
const CANOE_API_KEY        = process.env.CANOE_API_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const PAGE_SIZE               = 100;
const UPSERT_BATCH            = 100;
const TRANSCRIPTION_LOOKBACK_DAYS = 3;

// ── Windows ───────────────────────────────────────────────────────────────────

function getSyncWindow() {
  if (process.env.SYNC_FROM && process.env.SYNC_TO) {
    return { from: process.env.SYNC_FROM, to: process.env.SYNC_TO };
  }
  const now = new Date();
  const twoDaysAgo = new Date(now);
  twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
  twoDaysAgo.setUTCHours(0, 0, 0, 0);
  return { from: twoDaysAgo.toISOString(), to: now.toISOString() };
}

function getTranscriptionWindow() {
  const now = new Date();
  const lookback = new Date(now);
  lookback.setUTCDate(lookback.getUTCDate() - TRANSCRIPTION_LOOKBACK_DAYS);
  lookback.setUTCHours(0, 0, 0, 0);
  return { from: lookback.toISOString(), to: now.toISOString() };
}

// ── Canoe API ─────────────────────────────────────────────────────────────────

async function canoePost(path, body) {
  console.log(`  → POST ${CANOE_API_URL}/${path}`, JSON.stringify(body));
  let res;
  try {
    res = await fetch(`${CANOE_API_URL}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-apikey': CANOE_API_KEY },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Canoe fetch failed: ${e.message}`);
  }
  console.log(`  ← status ${res.status}`);
  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw new Error(`Canoe response read failed (status ${res.status}): ${e.message}`);
  }
  if (!res.ok) throw new Error(`Canoe ${path} error ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Canoe ${path} JSON parse failed — body length ${text.length}, first 300: ${text.slice(0, 300)}`);
  }
}

const PLT_SELECT = [
  'id','lead_id','publisher_id','publisher_name','promo_number_id','promo_number_name',
  'ivr_id','ivr_name','api_campaign_id','api_campaign_name','vertical_id','vertical_name',
  'advertiser_id','advertiser_name','campaign_id','campaign_name',
  'called_from','called_to','zip','city','state','line_type','keypresses',
  'ivr_duration','connect_duration','result',
  'advertiser_payin','advertiser_bid','publisher_payout','publisher_bid',
  'recording_id','is_test','created_at'
].join(',');

async function fetchPLTPage(page, from, to) {
  return canoePost('phone-lead-transactions/phone-lead-transactions/get', {
    select: PLT_SELECT,
    order_by: '-created_at',
    created_at: ['BETWEEN', [from, to]],
    page,
    limit: PAGE_SIZE,
  });
}

async function fetchRecordingsByIds(ids) {
  return canoePost('recordings/get', {
    id: ['IN', ids],
    limit: ids.length,
  });
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function mapPLT(r) {
  return {
    id:                        r.id,
    lead_id:                   r.lead_id,
    publisher_id:              r.publisher_id,
    publisher_name:            r.publisher_name,
    advertiser_id:             r.advertiser_id,
    advertiser_name:           r.advertiser_name,
    vertical_id:               r.vertical_id,
    vertical_name:             r.vertical_name,
    campaign_id:               r.campaign_id,
    campaign_name:             r.campaign_name,
    api_campaign_id:           r.api_campaign_id,
    api_campaign_name:         r.api_campaign_name,
    promo_number_id:           r.promo_number_id,
    promo_number_name:         r.promo_number_name,
    ivr_id:                    r.ivr_id,
    ivr_name:                  r.ivr_name,
    called_from:               r.called_from,
    called_to:                 r.called_to,
    zip:                       r.zip,
    city:                      r.city,
    state:                     r.state,
    line_type:                 r.line_type,
    keypresses:                r.keypresses,
    ivr_duration:              r.ivr_duration,
    connect_duration:          r.connect_duration,
    result:                    r.result,
    advertiser_payin:          r.advertiser_payin,
    advertiser_bid:            r.advertiser_bid,
    publisher_payout:          r.publisher_payout,
    publisher_bid:             r.publisher_bid,
    recording_id:              r.recording_id || null,
    recording_type:            null,
    is_test:                   !!r.is_test,
    created_at:                r.created_at,
    synced_at:                 new Date().toISOString(),
  };
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      ...(opts.prefer ? { 'Prefer': opts.prefer } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body,
  });
  if (!res.ok) throw new Error(`Supabase ${path} error ${res.status}: ${await res.text()}`);
  if (opts.method === 'PATCH' || opts.prefer === 'return=minimal') return null;
  return res.json();
}

async function upsertBatch(rows) {
  await sbFetch('canoe_calls', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify(rows),
  });
}

// ── Pass 1: phone-lead-transactions ──────────────────────────────────────────

async function syncCalls() {
  const { from, to } = getSyncWindow();
  console.log(`\nPass 1: phone-lead-transactions — ${from} → ${to}`);

  let page = 1, total = 0;

  while (true) {
    const { data, pagination } = await fetchPLTPage(page, from, to);
    if (!data || !data.length) break;

    for (let i = 0; i < data.length; i += UPSERT_BATCH) {
      const batch = data.slice(i, i + UPSERT_BATCH).map(mapPLT);
      await upsertBatch(batch);
      total += batch.length;
    }

    console.log(`  Page ${page}/${pagination.pageCount} — ${data.length} rows, ${total} total`);
    if (page >= pagination.pageCount) break;
    page++;
  }

  console.log(`Pass 1 complete. ${total} calls upserted.`);
  return total;
}

// ── Pass 2: patch transcriptions ─────────────────────────────────────────────

async function patchTranscriptions() {
  const { from } = getTranscriptionWindow();
  console.log(`\nPass 2: transcription patch — looking back ${TRANSCRIPTION_LOOKBACK_DAYS} days`);

  // Find rows that have a recording_id but no transcription yet
  const pending = await sbFetch(
    `canoe_calls?select=id,recording_id&recording_id=not.is.null&transcription=is.null&created_at=gte.${from}&limit=1000`
  );

  if (!pending || !pending.length) {
    console.log('  No pending transcriptions.');
    return;
  }

  console.log(`  ${pending.length} rows need transcription patch.`);

  const recordingIds = pending.map(r => r.recording_id);

  // Fetch recordings in batches of 100
  let patched = 0;
  for (let i = 0; i < recordingIds.length; i += 100) {
    const ids = recordingIds.slice(i, i + 100);
    const { data: recordings } = await fetchRecordingsByIds(ids);
    if (!recordings || !recordings.length) continue;

    // Build a map from recording_id → recording data
    const recMap = {};
    for (const rec of recordings) recMap[rec.id] = rec;

    // Patch each canoe_calls row that now has transcription data
    for (const row of pending.slice(i, i + 100)) {
      const rec = recMap[row.recording_id];
      if (!rec) continue;
      // Only patch if transcription arrived or recording metadata is useful
      if (!rec.transcription && !rec.outcome && !rec.summary && !rec.duration) continue;

      await sbFetch(`canoe_calls?id=eq.${row.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({
          transcription:  rec.transcription  || null,
          canoe_outcome:  rec.outcome        || null,
          canoe_summary:  rec.summary        || null,
          duration:       rec.duration       || null,
          recording_type: rec.recording_type || null,
        }),
      });
      patched++;
    }
  }

  console.log(`Pass 2 complete. ${patched} rows patched with transcription data.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  await syncCalls();
  await patchTranscriptions();
  console.log('\nSync complete.');
}

run().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
