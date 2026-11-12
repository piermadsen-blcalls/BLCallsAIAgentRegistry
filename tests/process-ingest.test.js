// Gemini batch ingest writes: scoring is write-once (a call submitted twice keeps its first score,
// so ai_processed_at never moves and the digest reports it once), and each ingested job asks for
// an outcome-score rollup refresh from its oldest call. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
const { ingestSucceededJob } = require('../scripts/process.js');

function stubFetch(calls) {
  const log = [];
  global.fetch = async (url, opts = {}) => {
    log.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (url.includes('/canoe_calls?id=in.')) return ok(calls);
    if (url.includes('/rpc/find_duplicate_callers')) return ok([]);
    return ok(null);
  };
  return log;
}

const answer = (key, outcome) => ({
  metadata: { key },
  response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ outcome, summary: 's', flags: [], suspicious_call: false }) }] } }] },
});

test('ingest only writes calls that are not scored yet, and requests a rollup refresh from the oldest call', async () => {
  const log = stubFetch([
    { id: 'PH1', zip: null, vertical_name: 'Roofing', created_at: '2026-11-10T09:00:00+00:00' },
    { id: 'PH2', zip: null, vertical_name: 'Roofing', created_at: '2026-11-08T23:30:00+00:00' },
  ]);
  const job = { id: 'job1', job_name: 'batches/1', call_ids: ['PH1', 'PH2'], prompt_id: null, model: 'gemini-test' };
  await ingestSucceededJob(job, { response: { inlinedResponses: [answer('PH1', 'sale'), answer('PH2', 'voicemail')] } });

  const writes = log.filter(r => r.method === 'PATCH' && r.url.includes('/canoe_calls?'));
  assert.equal(writes.length, 2);
  for (const w of writes) assert.match(w.url, /&ai_processed_at=is\.null$/, `unguarded score write: ${w.url}`);

  const refresh = log.filter(r => r.url.endsWith('/rpc/request_rollup_refresh'));
  assert.equal(refresh.length, 1, 'one refresh request per ingested job');
  assert.equal(new Date(refresh[0].body.from_ts).toISOString(), '2026-11-08T23:30:00.000Z');
  assert.deepEqual(refresh[0].body.rollups, ['outcome_score']);
});

test('a job with no usable answers requests no refresh', async () => {
  const log = stubFetch([{ id: 'PH1', zip: null, vertical_name: 'Roofing', created_at: '2026-11-10T09:00:00+00:00' }]);
  const job = { id: 'job2', job_name: 'batches/2', call_ids: ['PH1'], prompt_id: null, model: 'gemini-test' };
  await ingestSucceededJob(job, { response: { inlinedResponses: [{ metadata: { key: 'PH1' }, error: { code: 500 } }] } });
  assert.equal(log.filter(r => r.url.endsWith('/rpc/request_rollup_refresh')).length, 0);
});
