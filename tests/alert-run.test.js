// End-to-end digest runs: the real scripts/alert.js against an in-memory PostgREST + webhook.
// Covers the digest window (calls scored after a send must reach the next digest, exactly once)
// and DRY_RUN (must not write anything, so it can never block a real send). Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'alert.js');
const T0 = '2026-11-02T18:00:00.000Z';   // last digest before the test
const T1 = '2026-11-05T18:00:00.000Z';   // first send in the test
const T2 = '2026-11-09T18:00:00.000Z';   // second send
const hours = (iso, h) => new Date(Date.parse(iso) + h * 3600000).toISOString();

function call(id, created_at, ai_processed_at, flags) {
  return { id, created_at, ai_processed_at, flags, publisher_name: 'Pub A', advertiser_name: 'Buyer', vertical_name: 'Roofing', suspicious_call: false, is_test: false };
}

// Tiny PostgREST: only the endpoints and operators alert.js uses.
function mockServer(db) {
  const match = (row, q) => {
    for (const [k, v] of q) {
      if (k === 'select' || k === 'limit' || k === 'order') continue;
      const [op, ...rest] = v.split('.'); const val = rest.join('.');
      const cell = row[k];
      if (op === 'eq' && String(cell) !== val) return false;
      const cmp = (a, b) => (Date.parse(a) - Date.parse(b));
      if (op === 'gte' && !(cell != null && cmp(cell, val) >= 0)) return false;
      if (op === 'gt'  && !(cell != null && cmp(cell, val) > 0)) return false;
      if (op === 'lte' && !(cell != null && cmp(cell, val) <= 0)) return false;
      if (op === 'lt'  && !(cell != null && cmp(cell, val) < 0)) return false;
    }
    return true;
  };
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const table = url.pathname.replace('/rest/v1/', '');
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      if (url.pathname === '/webhook') { db.webhook.push(JSON.parse(body)); return send(200, { ok: true }); }
      if (req.method === 'GET') {
        let rows = (db[table] || []).filter(r => match(r, url.searchParams));
        if (url.searchParams.get('order')) rows = [...rows].sort((a, b) => (a.ai_processed_at + a.id < b.ai_processed_at + b.id ? -1 : 1));
        const range = req.headers.range;
        if (range) { const [a, b] = range.split('-').map(Number); rows = rows.slice(a, b + 1); }
        return send(200, rows);
      }
      if (req.method === 'POST') { db[table].push(JSON.parse(body)); return send(201); }
      if (req.method === 'PATCH') {
        const patch = JSON.parse(body);
        for (const r of db[table].filter(r => match(r, url.searchParams))) Object.assign(r, patch);
        return send(204);
      }
      send(404);
    });
  });
}

async function withServer(db, fn) {
  const server = mockServer(db);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}

function runAlert(base, env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH, SUPABASE_URL: base, SUPABASE_SERVICE_KEY: 'test-key',
        ASCND_ALERT_WEBHOOK_URL: `${base}/webhook`, DASHBOARD_URL: 'https://example.invalid', ...env,
      },
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
  });
}

function freshDb(calls) {
  return {
    account_managers: [{ id: 'm1', manager_name: 'Test Manager', manager_email: 'am@example.invalid' }],
    manager_alert_settings: [{ manager_id: 'm1', enabled: true, last_sent_at: T0 }],
    account_manager_assignments: [{ manager_id: 'm1', account_type: 'publisher', account_name: 'Pub A' }],
    canoe_calls: calls, alert_log: [], webhook: [],
  };
}
const flagTotal = post => post.accounts.reduce((n, a) => n + Object.values(a.flags).reduce((x, y) => x + y, 0), 0);

test('a call scored after a send reaches the next digest, and nothing is reported twice', async () => {
  const calls = [
    call('early', hours(T0, -30), hours(T0, 2), ['geo_mismatch']),   // made before T0, scored after it
    call('mid', hours(T0, 5), hours(T0, 20), ['angry_caller']),      // made and scored between T0 and T1
    call('late', hours(T1, -2), null, []),                           // made just before T1, not scored yet
  ];
  const db = freshDb(calls);
  await withServer(db, async base => {
    await runAlert(base, { ALERT_WINDOW_TO: T1 });
    assert.equal(db.webhook.length, 1);
    assert.equal(flagTotal(db.webhook[0]), 2, 'first digest: early + mid');
    assert.equal(db.manager_alert_settings[0].last_sent_at, T1);

    // Ingest scores 'late' after the first send.
    Object.assign(calls[2], { ai_processed_at: hours(T1, 3), flags: ['outbound_dial'] });
    await runAlert(base, { ALERT_WINDOW_TO: T2 });
    assert.equal(db.webhook.length, 2);
    assert.deepEqual(db.webhook[1].accounts[0].flags, { outbound_dial: 1 }, 'second digest: only late');
  });
});

test('the digest link covers every call the email counted', async () => {
  const db = freshDb([call('early', hours(T0, -30), hours(T0, 2), ['geo_mismatch'])]);
  await withServer(db, async base => {
    await runAlert(base, { ALERT_WINDOW_TO: T1 });
    const link = new URL(db.webhook[0].accounts[0].link);
    assert.ok(link.searchParams.get('from') <= hours(T0, -30).slice(0, 10), `link from ${link.searchParams.get('from')} misses the call made ${hours(T0, -30)}`);
  });
});

test('DRY_RUN writes nothing, so the next real run still sends', async () => {
  const db = freshDb([call('mid', hours(T0, 5), hours(T0, 20), ['angry_caller'])]);
  await withServer(db, async base => {
    const out = await runAlert(base, { DRY_RUN: 'true', ALERT_WINDOW_TO: T1 });
    assert.match(out, /DRY RUN/);
    assert.equal(db.webhook.length, 0);
    assert.deepEqual(db.alert_log, [], 'dry run left an alert_log row');
    assert.equal(db.manager_alert_settings[0].last_sent_at, T0);

    await runAlert(base, { DRY_RUN: 'false', ALERT_WINDOW_TO: T1 });
    assert.equal(db.webhook.length, 1, 'real run after a dry run must send');
    assert.equal(db.alert_log.length, 1);
    assert.equal(db.alert_log[0].dry_run, false);
  });
});

test('an old dry-run alert_log row does not block a real send for the same period', async () => {
  const db = freshDb([call('mid', hours(T0, 5), hours(T0, 20), ['angry_caller'])]);
  db.alert_log.push({ manager_id: 'm1', period_start: T0.slice(0, 10), dry_run: true });
  await withServer(db, async base => {
    await runAlert(base, { ALERT_WINDOW_TO: T1 });
    assert.equal(db.webhook.length, 1);
  });
});
