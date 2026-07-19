import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/http.ts'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function env(name: string) {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function publishableKey() {
  return Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? env('SUPABASE_ANON_KEY')
}

function adminClient() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
}

async function authenticatedUser(request: Request) {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  const token = authorization.slice('Bearer '.length)
  const client = createClient(env('SUPABASE_URL'), publishableKey(), { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await client.auth.getUser(token)
  return error ? null : data.user
}

Deno.serve(async (request) => {
  const cors = corsHeaders(request)
  if (request.method === 'OPTIONS') return cors ? new Response(null, { status: 204, headers: cors }) : json({ error: 'origin_not_allowed' }, 403)
  if (!cors) return json({ error: 'origin_not_allowed' }, 403)
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'POST, OPTIONS' })

  const user = await authenticatedUser(request)
  if (!user) return json({ error: 'unauthorized' }, 401, cors)

  const body = await request.json().catch(() => null) as { id?: unknown; decision?: unknown } | null
  if (!body || typeof body.id !== 'string' || !uuidPattern.test(body.id) || !['approved', 'rejected'].includes(String(body.decision))) {
    return json({ error: 'invalid_request' }, 400, cors)
  }

  const decision = body.decision as 'approved' | 'rejected'
  const admin = adminClient()
  const { data, error } = await admin.rpc('decide_approval', {
    p_user_id: user.id,
    p_approval_id: body.id,
    p_decision: decision,
  })
  const approval = data?.[0] ?? null

  if (error) return json({ error: 'decision_failed' }, 500, cors)
  if (!approval) return json({ error: 'approval_not_pending' }, 409, cors)

  // This function records the decision only. Execution is a separate, audited worker step.
  return json({ approval }, 200, cors)
})
