/**
 * sync.js
 * Pulls all calls from Canoe API and upserts into canoe_calls (Supabase).
 * Runs via GitHub Actions on a schedule.
 *
 * Required env vars:
 *   CANOE_API_URL      - e.g. https://exchange-gateway.ringpartner.com
 *   CANOE_API_KEY      - your Canoe API key
 *   SUPABASE_URL       - e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY - service role key (bypasses RLS)
 */

const CANOE_API_URL        = process.env.CANOE_API_URL;
const CANOE_API_KEY        = process.env.CANOE_API_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const PAGE_SIZE    = 250;
const UPSERT_BATCH = 100;


// Default: yesterday midnight → today midnight UTC
// Override by setting SYNC_FROM and SYNC_TO env vars (ISO strings)
function getSyncWindow() {
  if (process.env.SYNC_FROM && process.env.SYNC_TO) {
    return { from: process.env.SYNC_FROM, to: process.env.SYNC_TO };
  }
  const todayMidnight = new Date();
  todayMidnight.setUTCHours(0, 0, 0, 0);
  const yesterdayMidnight = new Date(todayMidnight);
  yesterdayMidnight.setUTCDate(yesterdayMidnight.getUTCDate() - 1);
  return { from: yesterdayMidnight.toISOString(), to: todayMidnight.toISOString() };
}

async function fetchPage(page) {
  const { from, to } = getSyncWindow();

  const res = await fetch(`${CANOE_API_URL}/recordings/get`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-apikey': CANOE_API_KEY,
    },
    body: JSON.stringify({
      add_related: 1,
      order_by: '-created_at',
      page,
      limit: PAGE_SIZE,
    }),
  });

  if (!res.ok) throw new Error(`Canoe API error ${res.status}: ${await res.text()}`);
  return res.json();
}

function mapRow(r) {
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
    phone_lead_transaction_id: r.phone_lead_transaction_id,
    recording_type:            r.recording_type,
    duration:                  r.duration,
    called_from:               r.called_from,
    called_to:                 r.called_to,
    zip:                       r.zip,
    city:                      r.city,
    state:                     r.state,
    keypresses:                r.keypresses,
    canoe_outcome:             r.outcome,
    canoe_summary:             r.summary,
    transcription:             r.transcription || null,
    created_at:                r.created_at,
    synced_at:                 new Date().toISOString(),
  };
}

async function upsertBatch(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/canoe_calls`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) throw new Error(`Supabase upsert error ${res.status}: ${await res.text()}`);
}

async function getLastSyncedAt() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/canoe_calls?select=synced_at&order=synced_at.desc&limit=1`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  const rows = await res.json();
  return rows?.[0]?.synced_at ?? null;
}

async function run() {
  console.log(`Canoe API key present: ${!!CANOE_API_KEY}, length: ${(CANOE_API_KEY||'').length}`);
  const { from, to } = getSyncWindow();
  console.log(`Starting Canoe sync — window: ${from} → ${to}`);

  const fromDate = new Date(from);
  const toDate   = new Date(to);

  let page        = 1;
  let totalSynced = 0;
  let done        = false;

  while (!done) {
    console.log(`Fetching page ${page}...`);
    const { data, pagination } = await fetchPage(page);

    if (!data || data.length === 0) break;

    const inWindow = [];
    for (const row of data) {
      const rowDate = new Date(row.created_at);
      if (rowDate >= toDate) continue;       // too new, skip
      if (rowDate < fromDate) { done = true; break; } // too old, stop paging
      inWindow.push(row);
    }

    if (inWindow.length > 0) {
      for (let i = 0; i < inWindow.length; i += UPSERT_BATCH) {
        const batch = inWindow.slice(i, i + UPSERT_BATCH).map(mapRow);
        await upsertBatch(batch);
        totalSynced += batch.length;
      }
    }

    console.log(`  Page ${page}/${pagination.pageCount} — ${inWindow.length} in window, ${totalSynced} total upserted`);

    if (!done && page >= pagination.pageCount) break;
    page++;
  }

  console.log(`Sync complete. Total records upserted: ${totalSynced}`);
}

run().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
