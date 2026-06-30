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

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');

// Local dev convenience: load scripts/.env if present (gitignored).
// In GitHub Actions this file doesn't exist and real secrets are used.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const CANOE_API_URL        = process.env.CANOE_API_URL;
const CANOE_API_KEY        = process.env.CANOE_API_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const PAGE_SIZE               = 100;
const UPSERT_BATCH            = 100;
const TRANSCRIPTION_LOOKBACK_DAYS = 3;
// Cap transcription scans per run (bounded, resumes next run). Override for backfill via PATCH_MAX.
const PATCH_MAX_PER_RUN       = parseInt(process.env.PATCH_MAX || '6000', 10);

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
  // During a backfill (SYNC_FROM set), patch transcriptions across the whole
  // synced window — not just the default 3-day lookback.
  if (process.env.SYNC_FROM) {
    return { from: process.env.SYNC_FROM, to: process.env.SYNC_TO || new Date().toISOString() };
  }
  const now = new Date();
  const lookback = new Date(now);
  lookback.setUTCDate(lookback.getUTCDate() - TRANSCRIPTION_LOOKBACK_DAYS);
  lookback.setUTCHours(0, 0, 0, 0);
  return { from: lookback.toISOString(), to: now.toISOString() };
}

// ── Canoe API ─────────────────────────────────────────────────────────────────

// Raw https POST that buffers the full response before parsing.
// Avoids undici/fetch's flaky handling of this gateway's chunked responses
// (which surfaced as "Unexpected end of JSON input" / HTTP/2 framing errors).
function httpsPostRaw(urlStr, bodyStr, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        port:     url.port || 443,
        path:     url.pathname + url.search,
        method:   'POST',
        headers: {
          ...headers,
          'Content-Length':  Buffer.byteLength(bodyStr),
          'Accept':          'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        // HTTP/1.1 only (https module never negotiates HTTP/2)
        timeout: 120000,
      },
      (res) => {
        const chunks = [];
        let stream = res;
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        if (enc === 'gzip')        stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, text });
        });
        stream.on('error', reject);
        res.on('aborted', () => reject(new Error('response aborted by server')));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.write(bodyStr);
    req.end();
  });
}

async function canoePost(path, body, retries = 4) {
  const url     = `${CANOE_API_URL}/${path}`;
  const bodyStr = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json', 'x-apikey': CANOE_API_KEY };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { status, text } = await httpsPostRaw(url, bodyStr, headers);
      if (status < 200 || status >= 300) {
        throw new Error(`Canoe ${path} HTTP ${status}: ${text.slice(0, 300)}`);
      }
      if (!text) throw new Error(`Canoe ${path} returned empty body (HTTP ${status})`);
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`Canoe ${path} bad JSON (len ${text.length}): ${text.slice(0, 200)}`);
      }
    } catch (e) {
      if (attempt === retries) throw e;
      const wait = attempt * 2000;
      console.warn(`  Attempt ${attempt}/${retries} failed: ${e.message} — retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
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
    stream: 0,
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
  // No body to parse for minimal responses (upserts/patches) or 204s.
  if (res.status === 204) return null;
  if (opts.prefer && opts.prefer.includes('return=minimal')) return null;
  if (opts.method === 'PATCH') return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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

    const pageCount = pagination?.pageCount;
    console.log(`  Page ${page}${pageCount ? '/' + pageCount : ''} — ${data.length} rows, ${total} total`);

    // This endpoint may omit pagination; fall back to "short page = last page".
    if (pageCount ? page >= pageCount : data.length < PAGE_SIZE) break;
    page++;
  }

  console.log(`Pass 1 complete. ${total} calls upserted.`);
  return total;
}

// ── Pass 2: patch transcriptions ─────────────────────────────────────────────

async function patchTranscriptions() {
  const { from } = getTranscriptionWindow();
  console.log(`\nPass 2: transcription patch — from ${from}`);

  const FETCH = 1000;                 // rows pulled from Supabase per page
  const MAX_PER_RUN = PATCH_MAX_PER_RUN;
  let offset = 0, scanned = 0, patched = 0, failedBatches = 0;

  while (scanned < MAX_PER_RUN) {
    // Rows with a recording but no transcription yet (newest first).
    const pending = await sbFetch(
      `canoe_calls?select=id,recording_id&recording_id=not.is.null&transcription=is.null` +
      `&created_at=gte.${from}&order=created_at.desc&offset=${offset}&limit=${FETCH}`
    );
    if (!pending || !pending.length) break;
    scanned += pending.length;

    // Fetch the matching recordings in batches of 100
    for (let i = 0; i < pending.length; i += 100) {
      const slice = pending.slice(i, i + 100);
      let recordings;
      try {
        ({ data: recordings } = await fetchRecordingsByIds(slice.map(r => r.recording_id)));
      } catch (e) {
        // Persistent failure on this batch — log, skip, leave rows pending for next run.
        failedBatches++;
        console.warn(`  Skipping batch (offset ${offset}+${i}): ${e.message}`);
        continue;
      }
      if (!recordings || !recordings.length) continue;

      const recMap = {};
      for (const rec of recordings) recMap[rec.id] = rec;

      for (const row of slice) {
        const rec = recMap[row.recording_id];
        if (!rec) continue;
        // Nothing useful to write yet — leave row pending, recheck next run.
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

    if (pending.length < FETCH) break;
    offset += FETCH;
  }

  if (!scanned) {
    console.log('  No pending transcriptions.');
    return;
  }
  console.log(`  Scanned ${scanned} pending rows.`);
  if (failedBatches) console.warn(`  ${failedBatches} batch(es) failed and were skipped — will retry next run.`);

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
