/**
 * sync.js
 * Two-pass sync:
 *   Pass 1 — phone-lead-transactions: upserts all calls for the window
 *   Pass 2 — recordings: patches transcription/duration/outcome onto rows
 *             where recording_id is set but transcription is still null
 *             (looks back TRANSCRIPTION_LOOKBACK_DAYS to catch delayed transcriptions)
 *   Pass 3 — pairs ASCND data (hl_call_data) onto canoe_calls
 *
 * Catch-up: a fully successful Pass 1 records how far it synced in sync_state (migration 052).
 * The next run starts at whichever is earlier, the usual 2-day window or that mark, so a failed
 * or skipped run leaves no gap. A failing pass does not stop the others; the run still exits 1.
 * At the end it asks pg_cron to refresh the rollups for the synced days, then heals renamed IVRs
 * and registers brand-new AI IVRs for setup (check_new_ivrs, migration 060).
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
// Catch-up: resume this far before the last fully synced point, but never reach back further
// than CATCHUP_MAX_DAYS (an older gap needs a deliberate SYNC_FROM backfill).
const SYNC_STATE_NAME         = 'canoe_pass1';
const RESUME_MARGIN_MS        = 3600000;
const CATCHUP_MAX_DAYS        = 30;
const DAY_MS                  = 86400000;

// Canoe transport + sleep, swappable in tests.
const io = {
  post:  (...args) => httpsPostRaw(...args),
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
};

// ── Windows ───────────────────────────────────────────────────────────────────

// syncedThrough: end of the last fully successful Pass 1 (ms), or null if unknown.
function getSyncWindow(syncedThrough, now = new Date()) {
  if (process.env.SYNC_FROM) {
    return { from: process.env.SYNC_FROM, to: process.env.SYNC_TO || now.toISOString() };
  }
  const twoDaysAgo = new Date(now);
  twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
  twoDaysAgo.setUTCHours(0, 0, 0, 0);
  let from = twoDaysAgo.getTime();
  if (syncedThrough != null && syncedThrough - RESUME_MARGIN_MS < from) {
    const floor = now.getTime() - CATCHUP_MAX_DAYS * DAY_MS;
    from = Math.max(syncedThrough - RESUME_MARGIN_MS, floor);
    console.log(`Catching up: last full sync reached ${new Date(syncedThrough).toISOString()}.`);
    if (syncedThrough - RESUME_MARGIN_MS < floor) {
      console.warn(`  Gap is older than ${CATCHUP_MAX_DAYS} days; only the last ${CATCHUP_MAX_DAYS} are synced. Backfill the rest with SYNC_FROM.`);
    }
  }
  return { from: new Date(from).toISOString(), to: now.toISOString() };
}

// Pass 2 start. During a backfill (SYNC_FROM set), patch transcriptions across the whole synced
// window; otherwise the 3-day lookback, or earlier when Pass 1 is catching up (syncFrom).
function getTranscriptionFrom(syncFrom) {
  if (process.env.SYNC_FROM) return process.env.SYNC_FROM;
  const lookback = new Date();
  lookback.setUTCDate(lookback.getUTCDate() - TRANSCRIPTION_LOOKBACK_DAYS);
  lookback.setUTCHours(0, 0, 0, 0);
  return syncFrom && Date.parse(syncFrom) < lookback.getTime() ? syncFrom : lookback.toISOString();
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

// Retries with exponential backoff (5s, 10s, 20s, 40s, 60s): the gateway's 504 "upstream request
// timeout" comes in bursts, and the old 2/4/6s retries gave up inside one (Oct 25 and 26).
async function canoePost(path, body, retries = 6) {
  const url     = `${CANOE_API_URL}/${path}`;
  const bodyStr = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json', 'x-apikey': CANOE_API_KEY };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { status, text } = await io.post(url, bodyStr, headers);
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
      const wait = Math.min(5000 * 2 ** (attempt - 1), 60000);
      console.warn(`  Attempt ${attempt}/${retries} failed: ${e.message} — retrying in ${wait}ms`);
      await io.sleep(wait);
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

// Only fields phone-lead-transactions actually returns. recording_type comes from Pass 2 and
// recording_url is not a PLT field: listing either here made every re-sync upsert null over them.
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

// Catch-up mark (sync_state, migration 052). Until 052 is applied the table is missing: warn and
// run the plain 2-day window, as before.
async function readSyncedThrough() {
  try {
    const rows = await sbFetch(`sync_state?name=eq.${SYNC_STATE_NAME}&select=synced_through`);
    return rows && rows.length ? Date.parse(rows[0].synced_through) : null;
  } catch (e) {
    console.warn(`Could not read the sync high-water mark, using the default window: ${e.message.slice(0, 200)}`);
    return null;
  }
}

async function writeSyncedThrough(iso) {
  try {
    await sbFetch('sync_state', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify({ name: SYNC_STATE_NAME, synced_through: iso, updated_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.warn(`Could not record the sync high-water mark: ${e.message.slice(0, 200)}`);
  }
}

// Ask pg_cron to rebuild rollups from the day of from_ts (migration 052). Only queues the work:
// a refresh takes 20-90s, past the 8s statement timeout every PostgREST call runs under.
// Non-fatal: the nightly pg_cron refresh still catches up if this fails.
async function requestRollupRefresh(fromTs, rollups) {
  try {
    await sbFetch('rpc/request_rollup_refresh', { method: 'POST', body: JSON.stringify({ from_ts: fromTs, rollups }) });
    console.log(`\nRequested ${rollups.join(', ')} rollup refresh from ${fromTs}.`);
  } catch (e) {
    console.warn(`\nRollup refresh request failed (nightly refresh will catch up): ${e.message.slice(0, 200)}`);
  }
}

// Heal renamed IVRs and register brand-new AI IVRs as needs_setup agents (migration 060), now
// that this run's calls are in. A few hundred ms, well inside the API's 8s. Non-fatal: the
// 07:15 UTC pg_cron run of the same check catches up if this fails.
async function checkNewIvrs() {
  try {
    const r = await sbFetch('rpc/check_new_ivrs', { method: 'POST', body: '{}' });
    const names = (r && r.registered) || [];
    console.log(`\nIVR check: ${r ? r.aliases_added : 0} rename(s) healed, ${names.length} new IVR(s) registered for setup.`);
    names.forEach(n => console.log(`  new: ${n}`));
  } catch (e) {
    console.warn(`\nIVR check failed (the 07:15 UTC pg_cron run will catch up): ${e.message.slice(0, 200)}`);
  }
}

// ── Pass 1: phone-lead-transactions ──────────────────────────────────────────

async function syncCalls({ from, to }) {
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

async function patchTranscriptions(syncFrom) {
  const from = getTranscriptionFrom(syncFrom);
  console.log(`\nPass 2: transcription patch — from ${from}`);

  const FETCH = 1000;                 // rows pulled from Supabase per page
  const MAX_PER_RUN = PATCH_MAX_PER_RUN;
  // Keyset (cursor) pagination on created_at — stays fast at any depth, unlike
  // OFFSET which re-scans from 0 every page and blows the statement timeout.
  let cursor = null, scanned = 0, patched = 0, failedBatches = 0, loggedFields = false;

  while (scanned < MAX_PER_RUN) {
    // Rows with a recording but no transcription yet (newest first).
    let q = `canoe_calls?select=id,recording_id,created_at&recording_id=not.is.null&transcription=is.null` +
            `&created_at=gte.${from}&order=created_at.desc&limit=${FETCH}`;
    if (cursor) q += `&created_at=lt.${encodeURIComponent(cursor)}`;
    const pending = await sbFetch(q);
    if (!pending || !pending.length) break;
    scanned += pending.length;
    cursor = pending[pending.length - 1].created_at;

    // Fetch the matching recordings in batches of 100
    for (let i = 0; i < pending.length; i += 100) {
      const slice = pending.slice(i, i + 100);
      let recordings;
      try {
        ({ data: recordings } = await fetchRecordingsByIds(slice.map(r => r.recording_id)));
      } catch (e) {
        // Persistent failure on this batch — log, skip, leave rows pending for next run.
        failedBatches++;
        console.warn(`  Skipping batch near ${cursor}: ${e.message}`);
        continue;
      }
      if (!recordings || !recordings.length) continue;
      // Field names only (never values: the Actions log is public). recording_url is not stored
      // until the field Canoe uses for a playable link is confirmed from this line.
      if (!loggedFields) { console.log(`  recordings/get fields: ${Object.keys(recordings[0]).sort().join(', ')}`); loggedFields = true; }

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
  }

  if (!scanned) {
    console.log('  No pending transcriptions.');
    return;
  }
  console.log(`  Scanned ${scanned} pending rows.`);
  if (failedBatches) console.warn(`  ${failedBatches} batch(es) failed and were skipped — will retry next run.`);

  console.log(`Pass 2 complete. ${patched} rows patched with transcription data.`);
}

// ── Pass 3: pair ASCND data (hl_call_data) onto canoe_calls ───────────────────

async function pairAscndData(syncFrom) {
  // Bounded window: full sync window during a backfill, else a rolling 4 days
  // (enough to catch late-arriving ASCND data without rescanning old history),
  // reaching back further when Pass 1 is catching up.
  const to   = process.env.SYNC_TO ? new Date(process.env.SYNC_TO) : new Date();
  const rolling = new Date(to.getTime() - 4 * DAY_MS);
  const from = process.env.SYNC_FROM
    ? new Date(process.env.SYNC_FROM)
    : (syncFrom && Date.parse(syncFrom) < rolling.getTime() ? new Date(syncFrom) : rolling);
  console.log(`\nPass 3: pairing ASCND data — ${from.toISOString()} → ${to.toISOString()}`);

  const CHUNK_MS = 2 * 86400000;   // 2-day chunks keep each RPC call under the timeout
  let total = 0, chunks = 0, failed = 0;

  for (let s = from.getTime(); s < to.getTime(); s += CHUNK_MS) {
    const e = Math.min(s + CHUNK_MS, to.getTime());
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sync_hl_to_canoe_calls`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ from_ts: new Date(s).toISOString(), to_ts: new Date(e).toISOString() }),
      });
      if (res.ok) { total += Number(await res.json()); chunks++; }
      else { failed++; console.warn(`  chunk error ${res.status}: ${(await res.text()).slice(0, 150)}`); }
    } catch (err) {
      failed++; console.warn(`  chunk failed: ${err.message}`);
    }
  }

  if (failed) console.warn(`  ${failed} chunk(s) failed — will retry next run.`);
  console.log(`Pass 3 complete. Enriched ${total.toLocaleString()} calls across ${chunks} chunk(s).`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Each pass runs even if an earlier one failed (Pass 2/3 work on rows already in the table);
// any failure still fails the run.
async function run() {
  const failures = [];
  let window = null;

  if (process.env.SKIP_PASS1) {
    console.log('SKIP_PASS1 set — skipping phone-lead-transactions sync.');
  } else {
    const syncedThrough = await readSyncedThrough();
    window = getSyncWindow(syncedThrough);
    try {
      await syncCalls(window);
      // Advance the mark only when this window joins up with it (a manual SYNC_FROM backfill of an
      // older, detached range must not hide the gap after it).
      const joins = syncedThrough != null ? Date.parse(window.from) <= syncedThrough : !process.env.SYNC_FROM;
      if (joins && (syncedThrough == null || Date.parse(window.to) > syncedThrough)) await writeSyncedThrough(window.to);
    } catch (e) {
      failures.push(`Pass 1: ${e.message}`);
      console.error(`Pass 1 failed: ${e.message}\n  Rows already upserted are kept; the next run resumes from the last full sync.`);
    }
  }

  const syncFrom = window && window.from;
  try { await patchTranscriptions(syncFrom); } catch (e) { failures.push(`Pass 2: ${e.message}`); console.error(`Pass 2 failed: ${e.message}`); }
  try { await pairAscndData(syncFrom); } catch (e) { failures.push(`Pass 3: ${e.message}`); console.error(`Pass 3 failed: ${e.message}`); }

  // Agents, counterparty and Scores rollups for every day Pass 1 touched (also after a partial
  // Pass 1: whatever landed is real). Scores too, since a re-sync can rename a publisher/vertical.
  if (window) await requestRollupRefresh(window.from, ['agent_metrics', 'agent_counterparty', 'outcome_score']);
  await checkNewIvrs();

  if (failures.length) {
    console.error(`\nSync finished with ${failures.length} failed pass(es):\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nSync complete.');
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('Sync failed:', err.message);
    process.exit(1);
  });
}

module.exports = { mapPLT, getSyncWindow, canoePost, run, io };
