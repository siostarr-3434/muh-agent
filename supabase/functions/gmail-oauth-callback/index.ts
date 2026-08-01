import { createClient } from 'npm:@supabase/supabase-js@2'
import { encryptSecret, sha256Hex, validateEncryptionKey } from '../_shared/crypto.ts'

type OAuthCallbackFailureCode =
  | 'account_save_failed'
  | 'calendar_connection_save_failed'
  | 'google_access_token_missing'
  | 'google_account_mismatch'
  | 'google_client_invalid'
  | 'google_code_invalid'
  | 'google_email_unverified'
  | 'google_profile_failed'
  | 'google_refresh_token_missing'
  | 'google_scope_mismatch'
  | 'google_token_exchange_failed'
  | 'oauth_not_configured'
  | 'state_consume_failed'
  | 'state_lookup_failed'
  | 'token_encryption_invalid'
  | 'unexpected'

class OAuthCallbackFailure extends Error {
  constructor(readonly code: OAuthCallbackFailureCode) {
    super(code)
  }
}

function failure(code: OAuthCallbackFailureCode) {
  return new OAuthCallbackFailure(code)
}

function env(name: string) {
  const value = Deno.env.get(name)
  if (!value) throw new Error(name + ' is not configured')
  return value
}

function adminClient() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
}

function oauthConfig() {
  const tokenEncryptionKey = env('TOKEN_ENCRYPTION_KEY')
  validateEncryptionKey(tokenEncryptionKey)
  return {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    tokenEncryptionKey,
  }
}

function callbackFailureCode(error: unknown): OAuthCallbackFailureCode {
  if (error instanceof OAuthCallbackFailure) return error.code
  if (error instanceof Error && /^(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|TOKEN_ENCRYPTION_KEY) is not configured$/.test(error.message)) {
    return 'oauth_not_configured'
  }
  if (error instanceof Error && error.message === 'TOKEN_ENCRYPTION_KEY is invalid') return 'token_encryption_invalid'
  return 'unexpected'
}

function resultRedirect(status: string, errorCode?: OAuthCallbackFailureCode, calendar = false) {
  const url = new URL('/', env('PUBLIC_APP_ORIGIN'))
  url.searchParams.set('view', 'settings')
  url.searchParams.set(calendar ? 'calendar' : 'gmail', status)
  if (errorCode) url.searchParams.set(calendar ? 'calendar_error' : 'gmail_error', errorCode)
  return Response.redirect(url.toString(), 303)
}

async function exchangeCode(code: string, redirectUri: string, oauth: ReturnType<typeof oauthConfig>) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null
    if (payload?.error === 'invalid_client') throw failure('google_client_invalid')
    if (payload?.error === 'invalid_grant') throw failure('google_code_invalid')
    throw failure('google_token_exchange_failed')
  }
  return await response.json() as { access_token?: string; refresh_token?: string; scope?: string }
}

async function googleEmail(accessToken: string) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { authorization: 'Bearer ' + accessToken },
  })
  if (!response.ok) throw failure('google_profile_failed')
  const profile = await response.json() as { email?: string; email_verified?: boolean | string }
  if (!profile.email || (profile.email_verified !== true && profile.email_verified !== 'true')) {
    throw failure('google_email_unverified')
  }
  return profile.email.toLowerCase()
}

function scopeGranted(scope: string, granted: Set<string>) {
  if (scope === 'email') {
    return granted.has('email') || granted.has('https://www.googleapis.com/auth/userinfo.email')
  }
  return granted.has(scope)
}

Deno.serve(async (request) => {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: { allow: 'GET' } })
  const requestUrl = new URL(request.url)
  const state = requestUrl.searchParams.get('state')
  const code = requestUrl.searchParams.get('code')
  if (!state) return resultRedirect('cancelled')

  let calendarRequested = false
  try {
    const oauth = oauthConfig()
    const admin = adminClient()
    const stateHash = await sha256Hex(state)
    const { data: candidate, error: candidateError } = await admin
      .from('oauth_states')
      .select('id')
      .eq('provider', 'gmail')
      .eq('state_hash', stateHash)
      .maybeSingle()
    if (candidateError) throw failure('state_lookup_failed')
    if (!candidate) return resultRedirect('expired')

    const consumedAt = new Date().toISOString()
    const { data: oauthState, error: consumeError } = await admin.from('oauth_states')
      .update({ consumed_at: consumedAt })
      .eq('id', candidate.id)
      .is('consumed_at', null)
      .gt('expires_at', consumedAt)
      .select('id,user_id,account_id,scopes,redirect_uri,expires_at,consumed_at')
      .single()
    if (consumeError) throw failure('state_consume_failed')
    if (!oauthState) return resultRedirect('expired')
    calendarRequested = oauthState.scopes.some((scope: string) => scope === 'https://www.googleapis.com/auth/calendar.events' || scope === 'https://www.googleapis.com/auth/calendar.events.owned')
    if (!code || requestUrl.searchParams.has('error')) return resultRedirect('cancelled', undefined, calendarRequested)

    const tokens = await exchangeCode(code, oauthState.redirect_uri, oauth)
    if (!tokens.access_token) throw failure('google_access_token_missing')
    const grantedScopes = new Set((tokens.scope ?? '').split(/\s+/).filter(Boolean))
    if (!oauthState.scopes.every((scope: string) => scopeGranted(scope, grantedScopes))) {
      throw failure('google_scope_mismatch')
    }
    if (!tokens.refresh_token) throw failure('google_refresh_token_missing')

    const email = await googleEmail(tokens.access_token)
    if (calendarRequested) {
      if (!oauthState.account_id) throw failure('calendar_connection_save_failed')
      const { data: expectedAccount, error: expectedAccountError } = await admin.from('email_accounts')
        .select('email')
        .eq('id', oauthState.account_id)
        .eq('user_id', oauthState.user_id)
        .eq('provider', 'gmail')
        .maybeSingle()
      if (expectedAccountError || !expectedAccount) throw failure('calendar_connection_save_failed')
      if (expectedAccount.email.toLowerCase() !== email) throw failure('google_account_mismatch')
    }
    const { data: existingAccount, error: existingAccountError } = await admin.from('email_accounts')
      .select('scopes')
      .eq('user_id', oauthState.user_id)
      .eq('provider', 'gmail')
      .eq('email', email)
      .maybeSingle()
    if (existingAccountError) throw failure('account_save_failed')
    const persistedScopes = [...new Set([
      ...oauthState.scopes,
      ...(Array.isArray(existingAccount?.scopes) ? existingAccount.scopes.filter((scope: unknown) => typeof scope === 'string') : []),
    ])]
    const ciphertext = await encryptSecret(tokens.refresh_token, oauth.tokenEncryptionKey)
    const { data: connectedAccountId, error: connectError } = await admin.rpc('connect_google_account', {
      p_calendar_account_id: calendarRequested ? oauthState.account_id : null,
      p_user_id: oauthState.user_id,
      p_email: email,
      p_scopes: persistedScopes,
      p_refresh_token_ciphertext: ciphertext,
    })
    if (connectError) throw failure(calendarRequested ? 'calendar_connection_save_failed' : 'account_save_failed')
    if (calendarRequested && connectedAccountId !== oauthState.account_id) throw failure('google_account_mismatch')

    console.log('gmail_oauth_callback_connected')
    return resultRedirect('connected', undefined, calendarRequested)
  } catch (error) {
    const code = callbackFailureCode(error)
    console.error(JSON.stringify({ event: 'gmail_oauth_callback_failed', code }))
    return resultRedirect('failed', code, calendarRequested)
  }
})
