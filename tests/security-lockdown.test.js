// Security lockdown (migration 063): anon gets nothing, config writes are admin-only. The page
// loads agents after a sign-in instead of at a signed-out boot, and hides the controls the
// database now refuses to non-admins. The SQL side has its own test
// (supabase/tests/063_security_lockdown_test.sql). Run: node --test tests/
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
function fakeDoc() {
  const els = {};
  const el = id => els[id] || (els[id] = { id, innerHTML: '', textContent: '', style: {}, querySelectorAll: () => [], focus() {} });
  return { els, getElementById: el };
}

// ── scripts/check_anon_access.js ─────────────────────────────────────────────
const check = require('../scripts/check_anon_access.js');

test('anon check: blocked or empty passes; any readable row or a runnable RPC fails', () => {
  assert.equal(check.verdict(401, null)[0], 'PASS');
  assert.equal(check.verdict(403, null)[0], 'PASS');
  assert.equal(check.verdict(404, null)[0], 'PASS');
  assert.equal(check.verdict(200, 0)[0], 'PASS');
  assert.deepEqual(check.verdict(206, 154106), ['FAIL', '206, 154106 rows readable']);
  assert.equal(check.verdict(200, null)[0], 'FAIL', 'no count = not proven empty');
  assert.equal(check.verdict(500, null)[0], 'FAIL');
  const cfg = check.pageConfig();
  assert.match(cfg.url, /^https:\/\/\w+\.supabase\.co$/);
  assert.match(cfg.key, /^sb_publishable_/, 'tests the key the page ships, never a secret one');
});

test('anon check: covers every table any migration creates', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const created = new Set();
  for (const f of fs.readdirSync(dir)) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)/gi)) created.add(m[1]);
  }
  const missing = [...created].filter(t => !check.TABLES.includes(t) && !/^zz/.test(t));
  assert.deepEqual(missing, []);
});

// ── supabase/migrations/063 ──────────────────────────────────────────────────
test('063: drops every anon/public policy an earlier migration created, in one transaction', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const mig = fs.readFileSync(path.join(dir, '063_security_lockdown.sql'), 'utf8');
  for (const f of fs.readdirSync(dir).filter(f => f < '063')) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of sql.matchAll(/create policy "([^"]+)"\s+on\s+(?:public\.)?(\w+)\s+(?:as \w+\s+)?for\s+\w+\s+to\s+(anon|public)\b/gi)) {
      assert.ok(mig.includes(`drop policy if exists "${m[1]}"`) && new RegExp(`"${m[1]}"\\s+on public\\.${m[2]};`).test(mig), `${f}: "${m[1]}" on ${m[2]} not dropped`);
    }
  }
  assert.match(mig, /^begin;$/m);
  assert.match(mig, /^commit;$/m);
  assert.match(mig, /revoke all on all functions in schema public from anon, public;/);
  assert.match(mig, /grant update \(compliance_reviewed\) on public\.canoe_calls to authenticated;/);
  const down = fs.readFileSync(path.join(ROOT, 'supabase', 'rollbacks', '063_security_lockdown_down.sql'), 'utf8');
  assert.match(down, /drop function if exists public\.is_admin\(\);/);
});

// ── index.html: boot and sign-in ─────────────────────────────────────────────
test('boot: signed out loads no agents; every sign-in loads them before the metrics and the banner', () => {
  assert.match(lift('async function bootDashboard('), /agentsLoadedPromise = getAuthToken\(\) \? loadAgentsData\(\) : Promise\.resolve\(\);/);
  const signIns = page.match(/const agentsReady = reloadAgentsData\(\);\n\s+await applyRoute\(\);\n\s+await agentsReady;\n\s+refreshMetrics\(\); loadFreshness\(\); showNewIvrsForAdmins\(true\);/g) || [];
  assert.equal(signIns.length, 2, 'password sign-in and set-password');
  for (const fn of ['async function doLogin(', 'async function doSetPassword(']) assert.match(lift(fn), /reloadAgentsData\(\)/, fn);
});

test('reloadAgentsData: replaces the shared promise, loads all four, then redraws', async () => {
  const calls = [];
  const ctx = {
    agentsLoadedPromise: 'stale',
    loadAliases: async () => calls.push('aliases'), loadAgentActivity: async () => calls.push('activity'),
    loadAgentsFromSupabase: async () => calls.push('agents'), loadTestCalls: async () => calls.push('testcalls'),
    recomputeStats: () => calls.push('stats'), applyFilters: () => calls.push('filters'),
  };
  vm.runInNewContext(lift('function loadAgentsData(') + ';\n' + lift('function reloadAgentsData(') + ';\nthis.reloadAgentsData = reloadAgentsData;', ctx);
  const done = ctx.reloadAgentsData();
  assert.notEqual(ctx.agentsLoadedPromise, 'stale', 'Review and Insights await the new promise');
  await done;
  assert.deepEqual(calls.slice(-2), ['stats', 'filters'], 'redraw after the loads');
  assert.deepEqual(calls.slice(0, 4).sort(), ['activity', 'agents', 'aliases', 'testcalls']);
});

// ── index.html: admin-only controls ──────────────────────────────────────────
const MANAGERS = [{ id: 'm1', manager_name: 'Ann', manager_email: 'ann@example.com', is_admin: true }];

test('Settings: only admins see Add manager and Remove', () => {
  assert.match(page, /<button class="settings-add-btn" id="settings-add-mgr-btn" style="display:none"/, 'hidden until admin status is known');
  assert.match(lift('async function settingsInit('), /if \(window\.isAdmin\) \{\n\s+document\.getElementById\('settings-add-mgr-btn'\)\.style\.display = '';/);
  for (const isAdmin of [true, false]) {
    const doc = fakeDoc();
    const ctx = { document: doc, window: { isAdmin }, compManagers: MANAGERS, settingsRefreshManagerSelect() {} };
    vm.runInNewContext(lift('function esc(') + ';\n' + lift('function settingsRenderManagers(') + ';\nthis.render = settingsRenderManagers;', ctx);
    ctx.render();
    const html = doc.els['settings-managers-table'].innerHTML;
    assert.equal(/settingsDeleteManager/.test(html), isAdmin, `Remove for isAdmin=${isAdmin}`);
    assert.equal(/settingsSetAdmin/.test(html), isAdmin, `Admin checkbox for isAdmin=${isAdmin}`);
  }
});

test('Settings: account assignment dropdowns are read-only for non-admins', () => {
  for (const isAdmin of [true, false, undefined]) {
    const doc = fakeDoc();
    const ctx = { document: doc, window: { isAdmin }, compManagers: MANAGERS, compAssignments: [], accountsTab: 'all',
      allAccounts: [{ account_name: 'Pub A', account_type: 'publisher' }] };
    vm.runInNewContext(lift('function esc(') + ';\n' + lift('function settingsRenderAccountsTable(') + ';\nthis.render = settingsRenderAccountsTable;', ctx);
    ctx.render();
    assert.equal(/assign-mgr-select" style="min-width:160px" disabled/.test(doc.els['settings-accounts-table'].innerHTML), isAdmin !== true, `isAdmin=${isAdmin}`);
  }
});

test('Review: only admins can edit the IVR objective', () => {
  for (const [isAdmin, objective] of [[true, ''], [true, 'Book roof inspections'], [false, 'Book roof inspections'], [undefined, '']]) {
    const doc = fakeDoc();
    const ctx = { document: doc, window: { isAdmin }, RV: { agent: { objective } } };
    vm.runInNewContext(lift('function esc(') + ';\n' + lift('function renderObjective(') + ';\nthis.render = renderObjective;', ctx);
    ctx.render(false);
    const html = doc.els['rv-objective'].innerHTML;
    assert.equal(/renderObjective\(true\)/.test(html), isAdmin === true, `edit button for isAdmin=${isAdmin}`);
    assert.match(html, objective ? /Book roof inspections/ : /No objective set yet\./, 'everyone still reads it');
  }
});
