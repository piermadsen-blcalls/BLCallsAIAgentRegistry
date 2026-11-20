// Admin actions for the registry's Settings tab, so no secret is ever pasted into the browser:
// Dashboard Users (list logins, invite, remove) need the service-role key, and the model
// calibration / A/B test runs dispatch process.yml with a GitHub token. Both stay here.
//
// Auth: the page sends the signed-in user's own access token. This function calls
// public.is_admin() (063) with it through PostgREST, so the database decides: no token or an
// invalid/expired one is a 401, a signed-in non-admin is a 403, and nothing else runs.
//
// Request: POST {"action": ..., ...}
//   list_users                     -> GoTrue GET  /admin/users?per_page=100
//   invite_user      {email}       -> GoTrue POST /invite
//   delete_user      {id}          -> GoTrue DELETE /admin/users/{id}
//   dispatch_process {inputs}      -> GitHub workflow_dispatch of process.yml on main
// The upstream status and JSON body come back as-is; this function's own errors are {message}.
//
// Deploy: supabase functions deploy admin --no-verify-jwt   (it checks the token itself and has
// to answer the browser's CORS preflight, which carries no token).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (both set by Supabase), GITHUB_DISPATCH_TOKEN
// (secret: fine-grained token, Actions read/write on the repo). Optional: ADMIN_PUBLISHABLE_KEY.

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GITHUB_TOKEN = Deno.env.get('GITHUB_DISPATCH_TOKEN') ?? '';
// The client-safe publishable key (the same one index.html uses), for the is_admin() check.
const API_KEY = Deno.env.get('ADMIN_PUBLISHABLE_KEY') ?? 'sb_publishable_lW7L0lMP-BR056Ou9db-dA_ckEGhf8J';
const DISPATCH_URL = 'https://api.github.com/repos/piermadsen-blcalls/BLCallsAIAgentRegistry/actions/workflows/process.yml/dispatches';
// process.yml's workflow_dispatch inputs; anything else is refused rather than forwarded.
const PROCESS_INPUTS = new Set(['ai_model', 'ai_mode', 'batch_size', 'prompt_id', 'test_mode', 'test_batch_id', 'batch_mode', 'test_call_ids']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bearer-token auth, no cookies, so any origin may call; the token is what grants access.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const fail = (message: string, status: number) => json({ message }, status);

// Relays an upstream response: same status, same JSON body (empty for a 204).
async function relay(res: Response): Promise<Response> {
  const text = await res.text();
  return new Response(text || null, { status: res.status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// true / false from is_admin() as the caller; null when the token is missing, invalid or expired.
async function isAdmin(token: string): Promise<boolean | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_admin`, {
    method: 'POST',
    headers: { apikey: API_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`is_admin ${res.status}: ${await res.text()}`);
  return (await res.json()) === true;
}

function auth(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
  });
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail('Method not allowed.', 405);

  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1];
  if (!token) return fail('Sign in first.', 401);
  let admin: boolean | null;
  try {
    admin = await isAdmin(token);
  } catch (e) {
    console.error('admin check failed', e);
    return fail('Could not check your access. Try again.', 502);
  }
  if (admin === null) return fail('Your session has expired. Sign in again.', 401);
  if (!admin) return fail('Admins only.', 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return fail('Expected a JSON object.', 400);
  }

  try {
    switch (body.action) {
      case 'list_users':
        if (!SERVICE_KEY) return fail('The service key is not configured on the server.', 500);
        return relay(await auth('admin/users?per_page=100'));
      case 'invite_user': {
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        if (!email) return fail('Email required.', 400);
        if (!SERVICE_KEY) return fail('The service key is not configured on the server.', 500);
        return relay(await auth('invite', { method: 'POST', body: JSON.stringify({ email }) }));
      }
      case 'delete_user': {
        const id = typeof body.id === 'string' ? body.id : '';
        if (!UUID.test(id)) return fail('A user id is required.', 400);
        if (!SERVICE_KEY) return fail('The service key is not configured on the server.', 500);
        return relay(await auth(`admin/users/${id}`, { method: 'DELETE' }));
      }
      case 'dispatch_process': {
        const inputs = body.inputs;
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return fail('inputs required.', 400);
        for (const [k, v] of Object.entries(inputs)) {
          if (!PROCESS_INPUTS.has(k)) return fail(`Unknown input: ${k}`, 400);
          if (typeof v !== 'string') return fail(`Input ${k} must be a string.`, 400);
        }
        if (!GITHUB_TOKEN) return fail('The GitHub token is not configured on the server.', 500);
        return relay(await fetch(DISPATCH_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'bl-calls-registry-admin' },
          body: JSON.stringify({ ref: 'main', inputs }),
        }));
      }
      default:
        return fail('Unknown action.', 400);
    }
  } catch (e) {
    console.error('admin action failed', body.action, e);
    return fail('The request failed upstream. Try again.', 502);
  }
}

Deno.serve(handle);
