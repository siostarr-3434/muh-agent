import { createClient } from 'npm:@supabase/supabase-js@2'
import { encryptSecret, sha256Hex } from '../_shared/crypto.ts'

function env(name: string) {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function adminClient() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
}

function resultRedirect(status: string) {
  const url = new URL('/', env('PUBLIC_APP_ORIGIN'))
  url.searchParams.set('view', 'settings')
  url.searchParams.set('gmail', status)
  return Response.redirect(url.toString(), 303)
}

async function exchangeCode(code: string, redirectUri: string) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  })
  if (!response.ok) throw new Error('google_token_exchange_failed')
  return await response.json() as { access_token?: string; refresh_token?: string; scope?: string }
}

async function googleEmail(accessToken: string) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${accessToken}` } })
  if (!response.ok) throw new Error('google_profile_failed')
  const profile = await response.json() as { email?: string; email_verified?: boolean }
  if (!profile.email || profile.email_verified !== true) throw new Error('google_email_unverified')
  return profile.email.toLowerCase()
}

Deno.serve(async (request) => {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: { allow: 'GET' } })
  const requestUrl = new URL(request.url)
  const state = requestUrl.searchParams.get('state')
  const code = requestUrl.searchParams.get('code')
  if (!state || !code || requestUrl.searchParams.has('error')) return resultRedirect('cancelled')

  const admin = adminClient()
  try {
    const stateHash = await sha256Hex(state)
    const { data: candidate } = await admin.from('oauth_states').select('id').eq('provider', 'gmail').eq('state_hash', stateHash).maybeSingle()
    if (!candidate) return resultRedirect('expired')

    const consumedAt = new Date().toISOString()
    const { data: oauthState, error: consumeError } = await admin.from('oauth_states')
      .update({ consumed_at: consumedAt })
      .eq('id', candidate.id)
      .is('consumed_at', null)
      .gt('expires_at', consumedAt)
      .select('id,user_id,scopes,redirect_uri,expires_at,consumed_at').single()
    if (consumeError || !oauthState) return resultRedirect('expired')

    const tokens = await exchangeCode(code, oauthState.redirect_uri)
    if (!tokens.access_token) throw new Error('google_access_token_missing')
    const grantedScopes = new Set((tokens.scope ?? '').split(/\s+/).filter(Boolean))
    if (oauthState.scopes.some((scope: string) => !grantedScopes.has(scope))) throw new Error('google_scope_mismatch')
    const email = await googleEmail(tokens.access_token)
    let ciphertext: string | null = null
    if (tokens.refresh_token) {
      ciphertext = await encryptSecret(tokens.refresh_token, env('TOKEN_ENCRYPTION_KEY'))
    }

    const { error: connectError } = await admin.rpc('connect_gmail_account', {
      p_user_id: oauthState.user_id,
      p_email: email,
      p_scopes: oauthState.scopes,
      p_refresh_token_ciphertext: ciphertext,
    })
    if (connectError) throw new Error('account_save_failed')
    return resultRedirect('connected')
  } catch {
    return resultRedirect('failed')
  }
})
