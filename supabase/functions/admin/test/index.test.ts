// The admin function's gate (is_admin() as the caller: 401 / 403 before anything runs) and each
// action's upstream call. PostgREST, GoTrue and GitHub are stubbed (fetch).
// Run: deno test --allow-env supabase/functions/admin/test/
import { assert, assertEquals } from 'jsr:@std/assert@1';

Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
Deno.env.set('GITHUB_DISPATCH_TOKEN', 'gh-token');
let handler: (req: Request) => Promise<Response>;
Deno.serve = ((h: typeof handler) => { handler = h; }) as unknown as typeof Deno.serve;
await import('../index.ts');

// ── Upstream stand-ins ──
type Call = { method: string; url: string; auth: string | null; apikey: string | null; body: unknown };
let calls: Call[] = [];
let admins: Record<string, boolean>;   // token -> is_admin(); a token not listed is invalid (401)
let upstream: (c: Call) => Response;
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function defaultUpstream(c: Call): Response {
  if (c.url.startsWith('https://proj.supabase.co/auth/v1/admin/users?')) return ok({ users: [{ id: 'u1', email: 'a@example.com' }], aud: 'authenticated' });
  if (c.url === 'https://proj.supabase.co/auth/v1/invite') return ok({ id: 'u2', email: (c.body as { email: string }).email });
  if (c.url.startsWith('https://proj.supabase.co/auth/v1/admin/users/')) return ok({});
  if (c.url.startsWith('https://api.github.com/')) return new Response(null, { status: 204 });
  throw new Error('unexpected fetch ' + c.url);
}
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => Promise.resolve().then(() => {
  const h = new Headers(init?.headers);
  const c: Call = { method: init?.method ?? 'GET', url: String(input instanceof Request ? input.url : input), auth: h.get('Authorization'),
    apikey: h.get('apikey'), body: init?.body ? JSON.parse(String(init.body)) : null };
  calls.push(c);
  if (c.url === 'https://proj.supabase.co/rest/v1/rpc/is_admin') {
    const token = c.auth?.replace(/^Bearer /, '') ?? '';
    if (!(token in admins)) return ok({ code: 'PGRST301', message: 'JWT expired' }, 401);
    return ok(admins[token]);
  }
  return upstream(c);
})) as typeof fetch;

const BASE = 'https://proj.supabase.co/functions/v1/admin';
function call(body: unknown, token: string | null = 'admin-token', method = 'POST') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return handler(new Request(BASE, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }));
}
function reset() { calls = []; admins = { 'admin-token': true, 'user-token': false }; upstream = defaultUpstream; }
const upstreamCalls = () => calls.filter(c => !c.url.endsWith('/rpc/is_admin'));

// ── Deny paths: nothing past the gate runs ──
for (const action of [{ action: 'list_users' }, { action: 'invite_user', email: 'x@example.com' },
  { action: 'delete_user', id: '00000000-0000-4000-8000-000000000001' }, { action: 'dispatch_process', inputs: { batch_size: '5' } }]) {
  Deno.test(`${action.action}: no token is 401, no database or upstream call`, async () => {
    reset();
    const res = await call(action, null);
    assertEquals(res.status, 401);
    assertEquals(calls.length, 0);
  });
  Deno.test(`${action.action}: invalid or expired token is 401, no upstream call`, async () => {
    reset();
    const res = await call(action, 'expired');
    assertEquals(res.status, 401);
    assertEquals(upstreamCalls().length, 0);
  });
  Deno.test(`${action.action}: signed-in non-admin is 403, no upstream call`, async () => {
    reset();
    const res = await call(action, 'user-token');
    assertEquals(res.status, 403);
    assertEquals((await res.json()).message, 'Admins only.');
    assertEquals(upstreamCalls().length, 0);
  });
}

Deno.test('the publishable key as the bearer token is not a session: 401', async () => {
  reset();
  const res = await call({ action: 'list_users' }, 'sb_publishable_lW7L0lMP-BR056Ou9db-dA_ckEGhf8J');
  assertEquals(res.status, 401);
  assertEquals(upstreamCalls().length, 0);
});

Deno.test('is_admin is checked with the caller token and the publishable key, never the service key', async () => {
  reset();
  await call({ action: 'list_users' });
  const check = calls.find(c => c.url.endsWith('/rpc/is_admin'))!;
  assertEquals(check.auth, 'Bearer admin-token');
  assertEquals(check.apikey, 'sb_publishable_lW7L0lMP-BR056Ou9db-dA_ckEGhf8J');
});

Deno.test('is_admin returning anything but true is a 403', async () => {
  reset();
  admins = { 'admin-token': 'yes' as unknown as boolean };
  assertEquals((await call({ action: 'list_users' })).status, 403);
});

Deno.test('database down: 502, nothing runs', async () => {
  reset();
  const stub = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) =>
    String(input).endsWith('/rpc/is_admin') ? Promise.resolve(new Response('boom', { status: 503 })) : stub(input, init)) as typeof fetch;
  try {
    const res = await call({ action: 'list_users' });
    assertEquals(res.status, 502);
    assertEquals(upstreamCalls().length, 0);
  } finally {
    globalThis.fetch = stub;
  }
});

Deno.test('CORS preflight answers without a token; other methods are 405', async () => {
  reset();
  const pre = await call(null, null, 'OPTIONS');
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get('Access-Control-Allow-Origin'), '*');
  assert(pre.headers.get('Access-Control-Allow-Headers')!.includes('authorization'));
  assertEquals((await call(null, 'admin-token', 'GET')).status, 405);
  assertEquals(calls.length, 0);
});

// ── Allow paths: an admin gets the same upstream calls the page used to make ──
Deno.test('list_users: GoTrue admin list with the service key, body relayed', async () => {
  reset();
  const res = await call({ action: 'list_users' });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), '*');
  assertEquals((await res.json()).users[0].email, 'a@example.com');
  const [c] = upstreamCalls();
  assertEquals([c.method, c.url, c.auth, c.apikey], ['GET', 'https://proj.supabase.co/auth/v1/admin/users?per_page=100', 'Bearer service-key', 'service-key']);
});

Deno.test('invite_user: POST /invite with the email', async () => {
  reset();
  const res = await call({ action: 'invite_user', email: ' new@example.com ' });
  assertEquals(res.status, 200);
  const [c] = upstreamCalls();
  assertEquals([c.method, c.url, c.auth], ['POST', 'https://proj.supabase.co/auth/v1/invite', 'Bearer service-key']);
  assertEquals(c.body, { email: 'new@example.com' });
  assertEquals((await call({ action: 'invite_user', email: '' })).status, 400);
});

Deno.test('invite_user: a GoTrue error comes back with its status and message', async () => {
  reset();
  upstream = () => ok({ message: 'A user with this email address has already been registered' }, 422);
  const res = await call({ action: 'invite_user', email: 'a@example.com' });
  assertEquals(res.status, 422);
  assertEquals((await res.json()).message, 'A user with this email address has already been registered');
});

Deno.test('delete_user: DELETE /admin/users/{id}; a non-uuid id is refused', async () => {
  reset();
  const id = '00000000-0000-4000-8000-000000000001';
  assertEquals((await call({ action: 'delete_user', id })).status, 200);
  const [c] = upstreamCalls();
  assertEquals([c.method, c.url, c.auth], ['DELETE', `https://proj.supabase.co/auth/v1/admin/users/${id}`, 'Bearer service-key']);
  calls = [];
  for (const bad of ['../invite', 'u1', 42, null]) assertEquals((await call({ action: 'delete_user', id: bad })).status, 400);
  assertEquals(upstreamCalls().length, 0);
});

Deno.test('dispatch_process: process.yml on main with the inputs and the server token, 204 relayed', async () => {
  reset();
  const inputs = { ai_model: 'gemini-3.6-flash', batch_size: '100', test_mode: 'true', test_batch_id: 't1', test_call_ids: 'a,b' };
  const res = await call({ action: 'dispatch_process', inputs });
  assertEquals(res.status, 204);
  const [c] = upstreamCalls();
  assertEquals([c.method, c.url, c.auth], ['POST',
    'https://api.github.com/repos/piermadsen-blcalls/BLCallsAIAgentRegistry/actions/workflows/process.yml/dispatches', 'Bearer gh-token']);
  assertEquals(c.body, { ref: 'main', inputs });
});

Deno.test('dispatch_process: a GitHub error comes back with its status and message', async () => {
  reset();
  upstream = () => ok({ message: 'Bad credentials' }, 401);
  const res = await call({ action: 'dispatch_process', inputs: { prompt_id: 'p1', batch_size: '50' } });
  assertEquals(res.status, 401);
  assertEquals((await res.json()).message, 'Bad credentials');
});

Deno.test('dispatch_process: only process.yml inputs, as strings; nothing else is forwarded', async () => {
  reset();
  assertEquals((await call({ action: 'dispatch_process', inputs: { ref: 'evil' } })).status, 400);
  assertEquals((await call({ action: 'dispatch_process', inputs: { batch_size: 5 } })).status, 400);
  assertEquals((await call({ action: 'dispatch_process', inputs: ['x'] })).status, 400);
  assertEquals((await call({ action: 'dispatch_process' })).status, 400);
  assertEquals(upstreamCalls().length, 0);
});

Deno.test('unknown action or a non-object body: 400', async () => {
  reset();
  assertEquals((await call({ action: 'drop_tables' })).status, 400);
  assertEquals((await call([1])).status, 400);
  assertEquals(upstreamCalls().length, 0);
});
