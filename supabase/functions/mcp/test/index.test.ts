// The HTTP side: OAuth discovery, 401s, the per-request auth check, the MCP handshake and tool
// calls. PostgREST is stubbed (fetch); the SQL itself is covered by 066/067's SQL tests and the
// end-to-end check in the PR.
// Run: deno test --allow-env supabase/functions/mcp/test/
import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@1';

Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
let handler: (req: Request) => Promise<Response>;
Deno.serve = ((h: typeof handler) => { handler = h; }) as unknown as typeof Deno.serve;
await import('../index.ts');

// ── PostgREST stand-in ──
type Rpc = { fn: string; args: Record<string, unknown>; auth: string | null; apikey: string | null };
let calls: Rpc[] = [];
let respond: (fn: string, args: Record<string, unknown>) => Response;
const GOOD = 'good-token';
function postgrest(input: Request | URL | string, init?: RequestInit): Response {
  const url = String(input instanceof Request ? input.url : input);
  const m = /^https:\/\/proj\.supabase\.co\/rest\/v1\/rpc\/(\w+)$/.exec(url);
  if (!m) throw new Error('unexpected fetch ' + url);
  const h = new Headers(init?.headers);
  const args = JSON.parse(String(init?.body ?? '{}'));
  calls.push({ fn: m[1], args, auth: h.get('Authorization'), apikey: h.get('apikey') });
  if (h.get('Authorization') !== `Bearer ${GOOD}`) {
    return new Response(JSON.stringify({ code: 'PGRST301', message: 'JWT expired' }), { status: 401 });
  }
  return respond(m[1], args);
}
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) =>
  Promise.resolve().then(() => postgrest(input, init))) as typeof fetch;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function defaultRespond(fn: string, args: Record<string, unknown>): Response {
  if (fn === 'mcp_whoami') return ok({ user_id: 'u1', email: 'a@example.com', client_id: 'c1' });
  if (fn === 'mcp_run_sql') return ok({ rows: [{ publisher: 'Pub A', calls: 12 }], row_count: 1, truncated: false, echo: args });
  if (fn === 'mcp_reports_list') return ok([]);
  return new Response('{}', { status: 404 });
}

const BASE = 'https://proj.supabase.co/functions/v1/mcp';
function mcp(body: unknown, token: string | null = GOOD) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return handler(new Request(BASE, { method: 'POST', headers, body: JSON.stringify(body) }));
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
function reset() { calls = []; respond = defaultRespond; }

Deno.test('protected-resource metadata points Claude at Supabase Auth', async () => {
  reset();
  const res = await handler(new Request(`${BASE}/.well-known/oauth-protected-resource`));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.resource, BASE);
  assertEquals(body.authorization_servers, ['https://proj.supabase.co/auth/v1']);
  assertEquals(calls.length, 0, 'no database call for discovery');
});

Deno.test('no token: 401 with the discovery pointer, nothing else runs', async () => {
  reset();
  const res = await mcp(init, null);
  assertEquals(res.status, 401);
  assertEquals(res.headers.get('WWW-Authenticate'), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
  assertEquals(calls.length, 0);
});

Deno.test('bad or revoked token: 401 invalid_token', async () => {
  reset();
  let res = await mcp(init, 'expired');
  assertEquals(res.status, 401);
  assertMatch(res.headers.get('WWW-Authenticate')!, /error="invalid_token"/);
  respond = (fn) => fn === 'mcp_whoami'
    ? new Response(JSON.stringify({ code: '42501', message: 'This session was revoked or has expired.' }), { status: 403 })
    : defaultRespond(fn, {});
  res = await mcp(init);
  assertEquals(res.status, 401);
  assertStringIncludes((await res.json()).error_description, 'revoked');
});

Deno.test('database down: 502, not a 401 (Claude should not re-authorize)', async () => {
  reset();
  respond = () => new Response('upstream', { status: 503 });
  assertEquals((await mcp(init)).status, 502);
});

Deno.test('initialize and tools/list for a signed-in user', async () => {
  reset();
  const res = await mcp(init);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.result.serverInfo.name, 'bl-calls-registry');
  assertStringIncludes(body.result.instructions, 'Mountain Time');
  assertEquals(calls[0].fn, 'mcp_whoami');
  assertEquals(calls[0].auth, `Bearer ${GOOD}`, 'the user\'s own token goes to PostgREST');
  assertMatch(calls[0].apikey!, /^sb_publishable_/, 'publishable key only');

  const list = await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  const names = list.result.tools.map((t: { name: string }) => t.name);
  assertEquals(names, ['describe_data', 'search_calls', 'get_call', 'aggregate_calls', 'list_values', 'run_sql',
                       'list_reports', 'run_report', 'create_report', 'update_report', 'delete_report']);
  for (const t of list.result.tools) {
    assertEquals(t.annotations.readOnlyHint, !/^(create|update|delete)_report$/.test(t.name), `${t.name} read-only hint`);
  }
});

Deno.test('aggregate_calls runs one mcp_run_sql as the user and returns rows + the SQL', async () => {
  reset();
  const res = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aggregate_calls', arguments: { group_by: ['publisher'], filters: { last_days: 7 } } } });
  const body = await res.json();
  assert(!body.result.isError, body.result.content[0].text);
  const out = JSON.parse(body.result.content[0].text);
  assertEquals(out.rows, [{ publisher: 'Pub A', calls: 12 }]);
  assertStringIncludes(out.sql, 'publisher_name as "publisher"');
  const run = calls.find(c => c.fn === 'mcp_run_sql')!;
  assertEquals(run.args.tool, 'aggregate_calls');
  assertEquals(run.args.max_rows, 100);
});

Deno.test('tool errors come back as isError text Claude can act on', async () => {
  reset();
  let body = await (await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'aggregate_calls', arguments: { group_by: ['color'] } } })).json();
  assert(body.result.isError);
  assertStringIncludes(body.result.content[0].text, 'Unknown group_by color');
  assert(!calls.some(c => c.fn === 'mcp_run_sql'), 'bad input never reaches the database');

  respond = (fn, args) => fn === 'mcp_run_sql' ? ok({ error: 'permission denied for table canoe_calls', sqlstate: '42501' }) : defaultRespond(fn, args);
  body = await (await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_sql', arguments: { query: 'select * from public.canoe_calls' } } })).json();
  assert(body.result.isError);
  assertStringIncludes(body.result.content[0].text, 'Only the views calls, agents');

  respond = (fn, args) => fn === 'mcp_run_sql'
    ? new Response(JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout' }), { status: 500 })
    : defaultRespond(fn, args);
  body = await (await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'run_sql', arguments: { query: 'select count(*) from calls' } } })).json();
  assertStringIncludes(body.result.content[0].text, 'longer than 8 seconds');
});

Deno.test('create_report checks the query plan before saving; run_report fills parameters', async () => {
  reset();
  const saved: Record<string, unknown>[] = [];
  respond = (fn, args) => {
    if (fn === 'mcp_report_save') {
      const r = { id: 'r1', name: args.p_name, description: args.p_description, kind: args.p_kind, definition: args.p_definition, parameters: args.p_parameters, created_at: 'now', updated_at: 'now' };
      saved.push(r);
      return ok(r);
    }
    if (fn === 'mcp_reports_list') return ok(saved);
    return defaultRespond(fn, args);
  };
  const create = await (await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_report', arguments: {
    name: 'Weekly publishers', kind: 'aggregate',
    arguments: { group_by: ['publisher'], filters: { start_date: '{{start}}', end_date: '{{end}}' } },
    parameters: [{ name: 'start', type: 'date', default: 'start_of_last_week' }, { name: 'end', type: 'date', default: 'end_of_last_week' }],
  } } })).json();
  assert(!create.result.isError, create.result.content[0].text);
  const check = calls.find(c => c.fn === 'mcp_run_sql')!;
  assertEquals(check.args.explain_only, true, 'plan checked first');
  assert(calls.findIndex(c => c.fn === 'mcp_run_sql') < calls.findIndex(c => c.fn === 'mcp_report_save'), 'checked before saved');

  calls = [];
  const run = await (await mcp({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'run_report', arguments: { report: 'weekly PUBLISHERS', params: { start: '2026-11-02' } } } })).json();
  assert(!run.result.isError, run.result.content[0].text);
  const out = JSON.parse(run.result.content[0].text);
  assertEquals(out.params.start, '2026-11-02');
  assertMatch(out.params.end, /^\d{4}-\d{2}-\d{2}$/);
  assertStringIncludes(out.sql, `('2026-11-02'::date)::timestamp`);
  assertEquals(calls.find(c => c.fn === 'mcp_run_sql')!.args.explain_only, false);

  const missing = await (await mcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'run_report', arguments: { report: 'nope' } } })).json();
  assertStringIncludes(missing.result.content[0].text, 'Your reports: Weekly publishers');
});

Deno.test('GET (no server stream in stateless mode) is 405 after auth', async () => {
  reset();
  const res = await handler(new Request(BASE, { headers: { Authorization: `Bearer ${GOOD}`, Accept: 'text/event-stream' } }));
  assertEquals(res.status, 405);
});

Deno.test('the function never reads a service-role key', async () => {
  for (const f of ['index.ts', 'tools.ts', 'db.ts', 'sql.ts']) {
    const src = await Deno.readTextFile(new URL(`../${f}`, import.meta.url));
    assert(!/SERVICE_ROLE|service_role|SECRET_KEY/.test(src), `${f} mentions a service key`);
  }
});
