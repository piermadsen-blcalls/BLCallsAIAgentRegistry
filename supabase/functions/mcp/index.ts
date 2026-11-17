// Claude connector for the call data: a remote MCP server (Streamable HTTP, stateless, JSON
// responses) that users add to their own Claude as a custom connector.
//
// Auth (MCP authorization spec): with no valid token this answers 401 with a WWW-Authenticate
// header pointing at /.well-known/oauth-protected-resource, which names Supabase Auth's OAuth 2.1
// server as the authorization server. Claude registers itself, sends the user to the registry's
// consent screen (index.html, ?authorization_id=...), where they sign in with their registry
// login and allow access. Claude then sends that user's access token with every request. This
// function checks it (mcp_whoami: a signed-in registry user with a live session) and forwards it
// to PostgREST, so every query runs as that user. It holds no service-role key.
//
// Deploy: supabase functions deploy mcp --no-verify-jwt   (it serves the discovery doc and the
// 401s itself). Needs migrations 066 + 067 and the OAuth 2.1 server switched on (see the PR).
// Env: SUPABASE_URL (set by Supabase). Optional: MCP_PUBLIC_URL, MCP_PUBLISHABLE_KEY.
import { Server } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from 'npm:@modelcontextprotocol/sdk@1.25.3/types.js';
import { DbError, userDb } from './db.ts';
import { callTool, INSTRUCTIONS, TOOLS } from './tools.ts';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
// The client-safe publishable key (the same one index.html uses); RLS and the user's token decide access.
const API_KEY = Deno.env.get('MCP_PUBLISHABLE_KEY') ?? 'sb_publishable_lW7L0lMP-BR056Ou9db-dA_ckEGhf8J';
const PUBLIC_URL = (Deno.env.get('MCP_PUBLIC_URL') ?? `${SUPABASE_URL}/functions/v1/mcp`).replace(/\/$/, '');
const METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function unauthorized(detail?: string): Response {
  const challenge = `Bearer resource_metadata="${METADATA_URL}"` +
    (detail ? `, error="invalid_token", error_description="${detail.replace(/["\\]/g, '')}"` : '');
  return json({ error: detail ? 'invalid_token' : 'unauthorized', error_description: detail ?? 'Sign in with your AI Agent Registry login.' },
    401, { 'WWW-Authenticate': challenge });
}

export async function handle(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path.endsWith('/.well-known/oauth-protected-resource')) {
    return json({
      resource: PUBLIC_URL,
      authorization_servers: [`${SUPABASE_URL}/auth/v1`],
      bearer_methods_supported: ['header'],
      resource_name: 'BL Calls - AI Agent Registry call data',
    }, 200, { 'Cache-Control': 'max-age=3600' });
  }

  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1];
  if (!token) return unauthorized();
  const db = userDb(SUPABASE_URL, API_KEY, token);
  try {
    await db.rpc('mcp_whoami');
  } catch (e) {
    if (e instanceof DbError && (e.status === 401 || e.status === 403 || e.code === '42501')) return unauthorized(e.message);
    console.error('mcp auth check failed', e);
    return json({ error: 'server_error', error_description: 'Could not check your sign-in. Try again.' }, 502);
  }

  // Stateless: no server-to-client stream, no sessions.
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const server = new Server({ name: 'bl-calls-registry', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, req => callTool(db, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

Deno.serve(handle);
