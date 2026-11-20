// No secrets in the browser: Settings -> Dashboard Users and the calibration / A/B test runs call
// the admin edge function with the user's own session instead of a pasted service-role key or
// GitHub PAT. The function's gate and upstream calls have their own tests
// (supabase/functions/admin/test/). Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
function lift(decl) {
  const start = page.indexOf(decl);
  assert.ok(start >= 0, `${decl} not found in index.html`);
  let i = start + page.slice(start).search(/\)\s*\{/), depth = 0;
  i = page.indexOf('{', i);
  for (; i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}' && --depth === 0) break;
  }
  return page.slice(start, i + 1);
}

test('no key or PAT box, and the page never calls GoTrue admin or GitHub itself', () => {
  for (const gone of ['s-service-key', 'modeltest-pat', 'ab-github-pat', 'settingsServiceKey', 'settingsUnlockUsers', "setItem('gh_pat'", "setItem('sb_service_key'"])
    assert.ok(!page.includes(gone), `${gone} is gone`);
  assert.doesNotMatch(page, /auth\/v1\/admin|auth\/v1\/invite|api\.github\.com/);
  // A key or PAT pasted before this change is dropped from the session.
  const init = lift('async function settingsInit(');
  assert.match(init, /sessionStorage\.removeItem\('sb_service_key'\)/);
  assert.match(init, /sessionStorage\.removeItem\('gh_pat'\)/);
  assert.match(init, /settingsLoadUsers\(\)/, 'admins see the user list without unlocking');
});

function adminCtx(responses) {
  const sent = [];
  const ctx = {
    SB_URL: 'https://proj.supabase.co', SB_KEY: 'pub', _refreshInFlight: null, refreshed: 0,
    sbTokenDue: () => false, getAuthToken: () => ctx.token, token: 'old',
    refreshSession: async () => { ctx.refreshed++; ctx.token = 'new'; return true; },
    localStorage: { getItem: k => (k === 'sb_refresh_token' ? 'rt' : null) },
    fetch: async (url, init) => { sent.push({ url, init }); return responses.shift(); },
    JSON,
  };
  vm.runInNewContext(`const ADMIN_URL = \`\${SB_URL}/functions/v1/admin\`;\n${lift('async function adminRequest(')}; this.adminRequest = adminRequest;`, ctx);
  return { ctx, sent };
}

test('adminRequest: posts the action with the user session, refreshes once on 401', async () => {
  const { ctx, sent } = adminCtx([{ status: 401 }, { status: 200, ok: true }]);
  const res = await ctx.adminRequest('delete_user', { id: 'u1' });
  assert.equal(res.status, 200);
  assert.equal(ctx.refreshed, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, 'https://proj.supabase.co/functions/v1/admin');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer old');
  assert.equal(sent[1].init.headers.Authorization, 'Bearer new');
  assert.equal(sent[1].init.headers.apikey, 'pub');
  assert.deepEqual(JSON.parse(sent[1].init.body), { action: 'delete_user', id: 'u1' });
});

test('Users and test runs go through adminRequest with the same inputs as before', () => {
  assert.match(lift('async function settingsLoadUsers('), /adminRequest\('list_users'\)/);
  assert.match(lift('async function settingsInviteUser('), /adminRequest\('invite_user', \{ email \}\)/);
  assert.match(lift('async function settingsDeleteUser('), /adminRequest\('delete_user', \{ id \}\)/);
  assert.match(lift('async function modeltestRun('), /adminRequest\('dispatch_process', \{ inputs \}\)/);
  assert.match(lift('async function promptsRunABTest('), /adminRequest\('dispatch_process', \{ inputs: \{ prompt_id: promptId, batch_size: batchSize \} \}\)/);
});

test('A/B run: no PAT needed; a server error shows its message', async () => {
  const els = {
    'ab-prompt-select': { value: 'p1' }, 'ab-batch-size': { value: '25' }, 'ab-status': { classList: { remove() {}, add() {} }, textContent: '' },
  };
  const calls = [];
  let reply = { ok: true, status: 204 };
  const ctx = {
    document: { getElementById: id => els[id] },
    adminRequest: async (action, payload) => { calls.push([action, payload]); return reply; },
  };
  vm.runInNewContext(`${lift('function setTone(')}; ${lift('async function promptsRunABTest(')}; this.run = promptsRunABTest;`, ctx);
  await ctx.run();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['dispatch_process', { inputs: { prompt_id: 'p1', batch_size: '25' } }]]);
  assert.equal(els['ab-status'].textContent, 'Started. Progress is in GitHub Actions.');
  reply = { ok: false, status: 403, json: async () => ({ message: 'Admins only.' }) };
  await ctx.run();
  assert.equal(els['ab-status'].textContent, 'Admins only.');
});
