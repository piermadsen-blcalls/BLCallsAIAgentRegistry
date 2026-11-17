// PostgREST RPC calls made with the signed-in user's own access token: the database sees that
// user (role authenticated, their auth.uid()), so RLS and the 066/067 functions apply. This
// function never holds a service-role key.

export class DbError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly hint?: string) {
    super(message);
  }
}

export interface Db {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
}

export function userDb(supabaseUrl: string, apiKey: string, accessToken: string): Db {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: apiKey,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(args),
      });
      const text = await res.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
      if (!res.ok) {
        const e = (body ?? {}) as { message?: string; code?: string; hint?: string };
        throw new DbError(e.message || `Database error ${res.status}`, res.status, e.code, e.hint);
      }
      return body as T;
    },
  };
}
