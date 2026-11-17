// The Claude connector's page side: the OAuth consent card on /oauth/consent (only Claude's own
// callbacks get a code), the boot and sign-in paths that show it instead of the app, and the
// Claude tab (connect steps, connected apps with Disconnect, saved reports, recent queries).
// The server side has its own tests: supabase/functions/mcp/test/ and supabase/tests/066-068.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
function lift(decl) {
  const start = html.indexOf(decl);
  assert.ok(start >= 0, `${decl} not found in index.html`);
  let i = start + html.slice(start).search(/\)\s*\{/), depth = 0;
  i = html.indexOf('{', i);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(start, i + 1);
}
function load(ctx, decls, exportNames) {
  const src = decls.map(lift).join(';\n');
  vm.runInNewContext(src + ';\n' + exportNames.map(n => `this.${n} = ${n};`).join(' '), ctx);
  return ctx;
}
const BASE = {
  esc: s => s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  jsStr: s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
  nullMark: () => '<span class="null-mark">-</span>',
  labelOf: v => String(v ?? '').replace(/_/g, ' '),
  claudeDate: s => s ? `D(${s})` : '-',
  URL,
};
const unhtml = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = s => unhtml(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

test('redirect allowlist: only Claude (claude.ai / claude.com over https) or a local Claude Code callback', () => {
  const { oauthRedirectAllowed: ok } = load({ ...BASE }, ['function oauthRedirectAllowed('], ['oauthRedirectAllowed']);
  for (const u of ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', 'https://www.claude.ai/cb',
                   'http://localhost:53682/callback', 'http://127.0.0.1:9999/callback']) assert.equal(ok(u), true, u);
  for (const u of ['http://claude.ai/api/mcp/auth_callback', 'https://claude.ai.evil.example/cb', 'https://evilclaude.ai/cb',
                   'https://evil.example/claude.ai', 'https://localhost/cb', 'javascript:alert(1)', 'not a url', '', undefined]) assert.equal(ok(u), false, String(u));
});

test('consent card: names the app and its address; a non-Claude address gets no Allow button', () => {
  const ctx = load({ ...BASE }, ['function oauthRedirectAllowed(', 'function oauthConsentHtml('], ['oauthConsentHtml']);
  const good = ctx.oauthConsentHtml({ client: { name: 'Claude' }, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }, 'pat@example.com');
  assert.match(text(good), /Claude at claude\.ai wants to use the registry as pat@example\.com/);
  assert.match(good, /onclick="oauthDecide\('approve'\)">Allow</);
  assert.match(text(good), /cannot change any call data/);
  const bad = ctx.oauthConsentHtml({ client: { name: '<img src=x onerror=alert(1)>Claude' }, redirect_uri: 'https://claude-mcp.example/cb' }, 'pat@example.com');
  assert.doesNotMatch(bad, /<img/, 'the self-registered client name is escaped');
  assert.doesNotMatch(bad, /approve/, 'no way to approve a non-Claude callback');
  assert.match(text(bad), /not Claude's address/);
});

async function consentCtx(authApi) {
  const els = { 'oauth-overlay': { classList: { remove() { els.shown = true; } } }, 'oauth-body': { innerHTML: '' }, 'oauth-error': { textContent: '' } };
  const ctx = load({ ...BASE, OAUTH_AUTHZ_ID: 'az-1', authApi, getAuthUser: () => 'pat@example.com', assigned: [], console: { warn() {} },
    location: { assign(u) { ctx.assigned.push(u); } }, document: { getElementById: id => els[id], querySelectorAll: () => [] },
    oauthOff: e => e && (e.code === 'feature_disabled' || e.status === 404) },
  ['function oauthRedirectAllowed(', 'function oauthConsentHtml(', 'async function oauthConsentInit(', 'async function oauthDecide('],
  ['oauthConsentInit', 'oauthDecide']);
  ctx.els = els;
  await ctx.oauthConsentInit();
  return ctx;
}

test('consent flow: details shown, approve posts the decision and returns to Claude', async () => {
  const calls = [];
  const ctx = await consentCtx(async (p, init) => {
    calls.push([p, init && init.body]);
    return p.endsWith('/consent') ? { redirect_url: 'https://claude.ai/api/mcp/auth_callback?code=c1&state=s' }
      : { authorization_id: 'az-1', client: { name: 'Claude' }, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', scope: 'email' };
  });
  assert.equal(ctx.els.shown, true);
  assert.equal(calls[0][0], 'oauth/authorizations/az-1');
  assert.match(ctx.els['oauth-body'].innerHTML, /Allow/);
  await ctx.oauthDecide('approve');
  assert.deepEqual(calls[1], ['oauth/authorizations/az-1/consent', '{"action":"approve"}']);
  assert.deepEqual(ctx.assigned, ['https://claude.ai/api/mcp/auth_callback?code=c1&state=s']);
});

test('consent flow: already allowed goes straight back; switched off or expired says so', async () => {
  let ctx = await consentCtx(async () => ({ redirect_url: 'https://claude.ai/api/mcp/auth_callback?code=c2' }));
  assert.deepEqual(ctx.assigned, ['https://claude.ai/api/mcp/auth_callback?code=c2']);
  ctx = await consentCtx(async () => { const e = new Error('OAuth server is disabled'); e.status = 404; e.code = 'feature_disabled'; throw e; });
  assert.match(text(ctx.els['oauth-body'].innerHTML), /not switched on yet/);
  assert.doesNotMatch(ctx.els['oauth-body'].innerHTML, /OAuth server is disabled/, 'raw error stays in the console');
  ctx = await consentCtx(async () => { const e = new Error('authorization not found'); e.status = 400; throw e; });
  assert.match(text(ctx.els['oauth-body'].innerHTML), /expired or was already used/);
});

test('boot and sign-in on /oauth/consent show the consent card instead of loading the app', () => {
  assert.match(html, /if \(await ensureAuth\(\)\) \{ checkAuth\(\); startTokenRefreshTimer\(\); if \(OAUTH_AUTHZ_ID\) return oauthConsentInit\(\); await applyRoute\(\);/);
  const login = lift('async function doLogin(');
  assert.ok(login.indexOf('if (OAUTH_AUTHZ_ID) { await oauthConsentInit(); return; }') < login.indexOf('reloadAgentsData()'), 'consent before any app load');
  assert.match(html, /const OAUTH_AUTHZ_ID = new URLSearchParams\(location\.search\)\.get\('authorization_id'\);\nif \(OAUTH_AUTHZ_ID\) document\.querySelector\('#login-overlay \.login-title'\)\.textContent = 'Sign in to connect Claude';/);
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert.match(toml, /from = "\/oauth\/consent"\n\s+to = "\/index\.html"\n\s+status = 200/, 'Netlify serves the page at the authorization path');
});

test('Claude tab: in the nav, opens claudeInit, shows the connector URL', () => {
  assert.match(html, /<button class="nav-tab" onclick="switchTab\('claude',this\)">Claude<\/button>\n\s+<button class="nav-tab" onclick="switchTab\('settings',this\)">Settings/);
  assert.match(lift('function switchTab('), /if \(id === 'claude'\) claudeInit\(\);/);
  assert.match(html, /<div id="tab-claude" class="tab-pane">/);
  assert.match(html, /const MCP_URL = `\$\{SB_URL\}\/functions\/v1\/mcp`;/);
  assert.match(lift('function claudeInit('), /getElementById\('claude-mcp-url'\)\.textContent = MCP_URL/);
});

test('connected apps: last use per client from the query log, Disconnect revokes the grant', async () => {
  const { claudeUsage } = load({ ...BASE }, ['function claudeUsage('], ['claudeUsage']);
  assert.deepEqual(JSON.parse(JSON.stringify(claudeUsage([
    { client_id: 'c1', created_at: '2026-11-17T10:00:00Z' }, { client_id: 'c1', created_at: '2026-11-16T10:00:00Z' },
    { client_id: null, created_at: '2026-11-15T10:00:00Z' }]))),
    { c1: { last: '2026-11-17T10:00:00Z', count: 2 }, '': { last: '2026-11-15T10:00:00Z', count: 1 } });

  const els = { 'claude-grants': { innerHTML: '' }, 'claude-activity': { innerHTML: '' } };
  const reqs = [];
  const ctx = load({ ...BASE, els, document: { getElementById: id => els[id] }, loadErrorHtml: t => `ERR ${t}`,
    authApi: async (p, init) => { reqs.push([p, init && init.method]); return p === 'user/oauth/grants' ? [{ client: { id: 'c1', name: 'Claude' }, scopes: ['email'], granted_at: '2026-11-17T09:00:00Z' }] : null; },
    sbFetch: async () => [{ client_id: 'c1', created_at: '2026-11-17T10:00:00Z', tool: 'aggregate_calls', row_count: 12, error: null, query: 'select <b>1</b>' }],
    confirm: () => true, oauthOff: () => false, claudeUsage },
  ['async function claudeLoadAccess(', 'async function claudeRevoke('], ['claudeLoadAccess', 'claudeRevoke']);
  await ctx.claudeLoadAccess();
  assert.match(text(els['claude-grants'].innerHTML), /Claude D\(2026-11-17T09:00:00Z\) D\(2026-11-17T10:00:00Z\) 1 Disconnect/);
  assert.match(text(els['claude-activity'].innerHTML), /aggregate calls 12 rows select <b>1<\/b>/);
  assert.doesNotMatch(els['claude-activity'].innerHTML, /<b>1/, 'query text is escaped');
  await ctx.claudeRevoke('c1', 'Claude');
  assert.deepEqual(reqs.find(r => r[1] === 'DELETE'), ['user/oauth/grants?client_id=c1', 'DELETE']);
});

test('connected apps: before the OAuth server is switched on, a plain note (no error)', async () => {
  const els = { 'claude-grants': { innerHTML: '' }, 'claude-activity': { innerHTML: '' } };
  const ctx = load({ ...BASE, els, document: { getElementById: id => els[id] }, loadErrorHtml: t => `ERR ${t}`,
    authApi: async () => { const e = new Error('OAuth server is disabled'); e.status = 404; e.code = 'feature_disabled'; throw e; },
    sbFetch: async () => [], oauthOff: e => e && e.code === 'feature_disabled', claudeUsage: () => ({}) },
  ['async function claudeLoadAccess('], ['claudeLoadAccess']);
  await ctx.claudeLoadAccess();
  assert.match(text(els['claude-grants'].innerHTML), /not switched on yet/);
  assert.match(text(els['claude-activity'].innerHTML), /No connector queries yet/);
});

test('saved reports: listed with inputs and query, renamed and deleted through the 067 functions', async () => {
  const els = { 'claude-reports': { innerHTML: '' } };
  const sent = [];
  const reports = [{ id: 'r1', name: 'Weekly <pubs>', description: 'By publisher', kind: 'aggregate', updated_at: '2026-11-17T10:00:00Z',
    definition: { group_by: ['publisher'] }, parameters: [{ name: 'start', type: 'date', default: 'start_of_last_week' }] }];
  const ctx = load({ ...BASE, els, claudeReports: [], document: { getElementById: id => els[id] }, loadErrorHtml: t => `ERR ${t}`,
    confirm: () => true, console: { warn() {} },
    sbFetch: async (p, init) => { sent.push([p, init && init.body]); return p === 'rpc/mcp_reports_list' ? reports : null; } },
  ['function claudeReportsHtml(', 'function claudeRenderReports(', 'async function claudeLoadReports(', 'async function claudeSaveReport(', 'async function claudeDeleteReport('],
  ['claudeLoadReports', 'claudeRenderReports', 'claudeSaveReport', 'claudeDeleteReport']);
  await ctx.claudeLoadReports();
  const t = text(els['claude-reports'].innerHTML);
  assert.match(t, /Weekly <pubs> By publisher Query/);
  assert.match(t, /Aggregate start = start_of_last_week/);
  assert.doesNotMatch(els['claude-reports'].innerHTML, /<pubs>/, 'names are escaped');
  ctx.claudeRenderReports('r1');
  assert.match(els['claude-reports'].innerHTML, /id="cl-rep-name" value="Weekly &lt;pubs&gt;"/);
  els['cl-rep-name'] = { value: ' Weekly publishers ' }; els['cl-rep-desc'] = { value: '' }; els['cl-rep-err'] = { textContent: '' };
  await ctx.claudeSaveReport('r1');
  assert.deepEqual(JSON.parse(sent.find(s => s[0] === 'rpc/mcp_report_save')[1]), { p_id: 'r1', p_name: 'Weekly publishers', p_description: '' });
  await ctx.claudeDeleteReport('r1');
  assert.deepEqual(JSON.parse(sent.find(s => s[0] === 'rpc/mcp_report_delete')[1]), { p_id: 'r1' });
});

test('saved reports: before 067 is applied, a plain note instead of an error', async () => {
  const els = { 'claude-reports': { innerHTML: '' } };
  const ctx = load({ ...BASE, els, claudeReports: [], document: { getElementById: id => els[id] }, loadErrorHtml: t => `ERR ${t}`,
    sbFetch: async () => { throw new Error('Supabase 404: {"code":"PGRST202"}'); } },
  ['function claudeReportsHtml(', 'function claudeRenderReports(', 'async function claudeLoadReports('], ['claudeLoadReports']);
  await ctx.claudeLoadReports();
  assert.match(text(els['claude-reports'].innerHTML), /once the Claude connector is switched on/);
});
