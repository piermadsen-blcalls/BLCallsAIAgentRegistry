import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabaseUrl   = Deno.env.get('SUPABASE_URL')!
  const anonKey       = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  // Verify caller and check admin status using their JWT
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: { user }, error: userError } = await callerClient.auth.getUser()
  if (userError || !user) return json({ error: 'Unauthorized' }, 401)

  const { data: manager } = await callerClient
    .from('account_managers')
    .select('is_admin')
    .eq('manager_email', user.email)
    .maybeSingle()

  if (!manager?.is_admin) return json({ error: 'Forbidden: admin only' }, 403)

  // All good — use service role for admin operations
  const adminClient = createClient(supabaseUrl, serviceKey)
  const url  = new URL(req.url)
  const parts = url.pathname.replace(/^\/functions\/v1\/admin-users\/?/, '').split('/').filter(Boolean)

  // GET /admin-users → list all users
  if (req.method === 'GET') {
    const { data, error } = await adminClient.auth.admin.listUsers({ perPage: 200 })
    if (error) return json({ error: error.message }, 500)
    return json(data.users.map(u => ({
      id:              u.id,
      email:           u.email,
      created_at:      u.created_at,
      last_sign_in_at: u.last_sign_in_at,
    })))
  }

  // POST /admin-users → invite
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const email = body.email?.trim()
    if (!email) return json({ error: 'email required' }, 400)
    const { error } = await adminClient.auth.admin.inviteUserByEmail(email)
    if (error) return json({ error: error.message }, 400)
    return json({ ok: true })
  }

  // DELETE /admin-users/:id → delete user
  if (req.method === 'DELETE' && parts[0]) {
    const targetId = parts[0]
    if (targetId === user.id) return json({ error: 'Cannot delete your own account' }, 400)
    const { error } = await adminClient.auth.admin.deleteUser(targetId)
    if (error) return json({ error: error.message }, 400)
    return json({ ok: true })
  }

  return json({ error: 'Not found' }, 404)
})
