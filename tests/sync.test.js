// Canoe sync: recording columns survive re-syncs, Canoe failures back off and do not stop the
// other passes, and a stored high-water mark closes gaps left by failed or skipped runs.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
process.env.CANOE_API_URL = 'http://canoe.test';
delete process.env.SYNC_FROM; delete process.env.SYNC_TO; delete process.env.SKIP_PASS1;
const sync = require('../scripts/sync.js');

const NOW = new Date('2026-11-12T04:30:00Z');
const at = iso => Date.parse(iso);

test('a re-sync upsert never touches recording_url or recording_type', () => {
  const row = sync.mapPLT({ id: 'PH1', recording_id: 'RC1', created_at: '2026-11-11T10:00:00Z' });
  assert.equal(row.recording_id, 'RC1');
  assert.ok(!('recording_url' in row), 'recording_url would be upserted as null');
  assert.ok(!('recording_type' in row), 'recording_type would be upserted as null');
});

test('sync window: 2 days by default, back to the last full sync after missed runs, capped at 30 days', () => {
  assert.equal(sync.getSyncWindow(null, NOW).from, '2026-11-10T00:00:00.000Z');
  assert.equal(sync.getSyncWindow(at('2026-11-11T04:00:00Z'), NOW).from, '2026-11-10T00:00:00.000Z', 'a recent mark never narrows the window');
  assert.equal(sync.getSyncWindow(at('2026-11-07T03:00:00Z'), NOW).from, '2026-11-07T02:00:00.000Z', 'resume 1h before the mark');
  assert.equal(sync.getSyncWindow(at('2026-09-01T00:00:00Z'), NOW).from, '2026-10-13T04:30:00.000Z');
  assert.equal(sync.getSyncWindow(null, NOW).to, NOW.toISOString());
});

test('Canoe errors are retried with growing backoff', async () => {
  const waits = [];
  let calls = 0;
  sync.io.sleep = async ms => { waits.push(ms); };
  sync.io.post = async () => (++calls < 3 ? { status: 504, text: 'upstream request timeout' } : { status: 200, text: '{"data":[]}' });
  assert.deepEqual(await sync.canoePost('x/get', {}), { data: [] });
  assert.deepEqual(waits, [5000, 10000]);
});

// Fake Supabase for run(): records every request.
function stubSupabase(syncedThrough) {
  const log = [];
  global.fetch = async (url, opts = {}) => {
    const path = url.replace('http://sb.test/rest/v1/', '');
    log.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (status, data) => ({ ok: status < 300, status, text: async () => (data === undefined ? '' : JSON.stringify(data)), json: async () => data });
    if (path.startsWith('sync_state') && (opts.method || 'GET') === 'GET') return reply(200, syncedThrough ? [{ synced_through: syncedThrough }] : []);
    if (path.startsWith('canoe_calls?select=')) return reply(200, []);
    if (path === 'rpc/sync_hl_to_canoe_calls') return reply(200, 0);
    return reply(204);
  };
  return log;
}

test('a Canoe outage in Pass 1 still runs Pass 2 and 3, keeps the mark, and fails the run', async () => {
  const mark = new Date(Date.now() - 3 * 86400000);  // three days ago: two missed nightly runs
  const log = stubSupabase(mark.toISOString());
  sync.io.sleep = async () => {};
  sync.io.post = async () => ({ status: 504, text: 'upstream request timeout' });
  try {
    await sync.run();
    assert.equal(process.exitCode, 1);
    assert.ok(log.some(r => r.path.startsWith('canoe_calls?select=id,recording_id')), 'Pass 2 ran');
    assert.ok(log.some(r => r.path === 'rpc/sync_hl_to_canoe_calls'), 'Pass 3 ran');
    assert.ok(!log.some(r => r.path.startsWith('sync_state') && r.method === 'POST'), 'mark must not advance past a failed Pass 1');
    const refresh = log.find(r => r.path === 'rpc/request_rollup_refresh');
    assert.equal(refresh.body.from_ts, new Date(mark.getTime() - 3600000).toISOString(), 'window resumed 1h before the mark');
  } finally { process.exitCode = 0; }
});

test('a clean run upserts, advances the mark to the window end and requests all rollups', async () => {
  const log = stubSupabase(new Date(Date.now() - 86400000).toISOString());
  sync.io.post = async (url) => (url.includes('phone-lead-transactions')
    ? { status: 200, text: JSON.stringify({ data: [{ id: 'PH1', recording_id: 'RC1', created_at: '2026-11-11T10:00:00Z' }], pagination: { pageCount: 1 } }) }
    : { status: 200, text: '{"data":[]}' });
  await sync.run();
  assert.ok(!process.exitCode);
  const upsert = log.find(r => r.path === 'canoe_calls' && r.method === 'POST');
  assert.deepEqual(upsert.body.map(r => r.id), ['PH1']);
  const mark = log.find(r => r.path.startsWith('sync_state') && r.method === 'POST');
  assert.ok(Date.now() - Date.parse(mark.body.synced_through) < 60000, 'mark = this run\'s window end');
  const refresh = log.find(r => r.path === 'rpc/request_rollup_refresh');
  assert.deepEqual(refresh.body.rollups, ['agent_metrics', 'agent_counterparty', 'outcome_score']);
});

test('recording links: only http(s) provider_recording_url values are kept', () => {
  assert.equal(sync.recordingLink({ provider_recording_url: ' https://rec.example/RE1 ' }), 'https://rec.example/RE1');
  assert.equal(sync.recordingLink({ provider_recording_url: 'javascript:alert(1)' }), null);
  assert.equal(sync.recordingLink({ provider_recording_url: '' }), null);
  assert.equal(sync.recordingLink(undefined), null);
});

test('Pass 2b stores recording links as id + recording_url upserts, leaving transcription alone', async () => {
  process.env.SKIP_PASS1 = '1';
  const log = [];
  global.fetch = async (url, opts = {}) => {
    const path = url.replace('http://sb.test/rest/v1/', '');
    log.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (status, data) => ({ ok: status < 300, status, text: async () => (data === undefined ? '' : JSON.stringify(data)), json: async () => data });
    if (path.includes('recording_url=is.null')) return reply(200, [
      { id: 'PH1', recording_id: 'RC1', created_at: '2026-11-12T10:00:00Z' },
      { id: 'PH2', recording_id: 'RC2', created_at: '2026-11-12T09:00:00Z' },
      { id: 'PH3', recording_id: 'RC3', created_at: '2026-11-12T08:00:00Z' },
    ]);
    if (path.startsWith('canoe_calls?select=')) return reply(200, []);
    if (path === 'rpc/sync_hl_to_canoe_calls') return reply(200, 0);
    return reply(204);
  };
  const asked = [];
  sync.io.post = async (url, body) => {
    asked.push(JSON.parse(body));
    return { status: 200, text: JSON.stringify({ data: [
      { id: 'RC1', provider: 'twilio', provider_recording_url: 'https://rec.example/RE1', transcription: 'hello' },
      { id: 'RC2', provider: 'twilio', provider_recording_url: null },
    ] }) };
  };
  try {
    await sync.run();
    assert.ok(!process.exitCode);
    assert.deepEqual(asked[0].id, ['IN', ['RC1', 'RC2', 'RC3']]);
    const upserts = log.filter(r => r.path === 'canoe_calls' && r.method === 'POST');
    assert.deepEqual(upserts.map(r => r.body), [[{ id: 'PH1', recording_url: 'https://rec.example/RE1' }]], 'only rows with a link, only id + recording_url');
  } finally { delete process.env.SKIP_PASS1; process.exitCode = 0; }
});
