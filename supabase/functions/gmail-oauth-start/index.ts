import { createClient } from 'npm:@supabase/supabase-js@2'
import { randomState, sha256Hex } from '../_shared/crypto.ts'
import { corsHeaders, json } from '../_shared/http.ts'

function env(name: string) {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function adminClient() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
}

function publishableKey() {
  return Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? env('SUPABASE_ANON_KEY')
}

async function authenticatedUser(request: Request) {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  const token = authorization.slice('Bearer '.length)
  const userClient = createClient(env('SUPABASE_URL'), publishableKey(), { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await userClient.auth.getUser(token)
  if (error) return null
  return data.user
}

Deno.serve(async (request) => {
  const cors = corsHeaders(request)
  if (request.method === 'OPTIONS') return cors ? new Response(null, { status: 204, headers: cors }) : json({ error: 'origin_not_allowed' }, 403)
  if (!cors) return json({ error: 'origin_not_allowed' }, 403)
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'POST, OPTIONS' })

  try {
    const user = await authenticatedUser(request)
    if (!user) return json({ error: 'unauthorized' }, 401, cors)

    const payload = await request.json().catch(() => ({})) as { includeDrive?: unknown }
    const includeDrive = payload.includeDrive === true
    const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']
    if (includeDrive) scopes.push('https://www.googleapis.com/auth/drive.readonly')

    const admin = adminClient()
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString()
    const { count, error: countError } = await admin.from('oauth_states').select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', oneMinuteAgo)
    if (countError) throw countError
    if ((count ?? 0) >= 5) return json({ error: 'rate_limited' }, 429, { ...cors, 'retry-after': '60' })

    await admin.from('oauth_states').delete().eq('user_id', user.id).lt('expires_at', new Date().toISOString())

    const state = randomState()
    const redirectUri = env('GOOGLE_REDIRECT_URI')
    const { error } = await admin.from('oauth_states').insert({
      user_id: user.id,
      provider: 'gmail',
      state_hash: await sha256Hex(state),
      scopes,
      redirect_uri: redirectUri,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    })
    if (error) throw error

    const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    googleUrl.searchParams.set('client_id', env('GOOGLE_CLIENT_ID'))
    googleUrl.searchParams.set('redirect_uri', redirectUri)
    googleUrl.searchParams.set('response_type', 'code')
    googleUrl.searchParams.set('access_type', 'offline')
    googleUrl.searchParams.set('prompt', 'consent')
    googleUrl.searchParams.set('scope', scopes.join(' '))
    googleUrl.searchParams.set('state', state)
    return json({ authorizationUrl: googleUrl.toString() }, 200, cors)
  } catch {
    return json({ error: 'oauth_start_failed' }, 500, cors)
  }
})
