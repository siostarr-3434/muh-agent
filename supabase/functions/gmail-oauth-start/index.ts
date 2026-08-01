import { createClient } from 'npm:@supabase/supabase-js@2'
import { randomState, sha256Hex, validateEncryptionKey } from '../_shared/crypto.ts'
import { corsHeaders, json } from '../_shared/http.ts'

const driveReadonlyScope = 'https://www.googleapis.com/auth/drive.readonly'
const calendarEventsOwnedScope = 'https://www.googleapis.com/auth/calendar.events.owned'
const calendarTargetEmail = 'siostarr@hairartclinics.com'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

function oauthConfig() {
  env('GOOGLE_CLIENT_SECRET')
  validateEncryptionKey(env('TOKEN_ENCRYPTION_KEY'))
  return {
    clientId: env('GOOGLE_CLIENT_ID'),
    redirectUri: env('GOOGLE_REDIRECT_URI'),
  }
}

function errorCode(error: unknown) {
  return error instanceof Error && (
    /^(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REDIRECT_URI|TOKEN_ENCRYPTION_KEY) is not configured$/.test(error.message) ||
    error.message === 'TOKEN_ENCRYPTION_KEY is invalid'
  )
    ? 'oauth_not_configured'
    : 'oauth_start_failed'
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
    const oauth = oauthConfig()

    const payload = await request.json().catch(() => ({})) as { accountId?: unknown; includeCalendar?: unknown; includeDrive?: unknown }
    const includeDrive = payload.includeDrive === true
    const includeCalendar = payload.includeCalendar === true
    if (payload.includeDrive !== undefined && typeof payload.includeDrive !== 'boolean') return json({ error: 'invalid_request' }, 400, cors)
    if (payload.includeCalendar !== undefined && typeof payload.includeCalendar !== 'boolean') return json({ error: 'invalid_request' }, 400, cors)
    if (includeCalendar && (typeof payload.accountId !== 'string' || !uuidPattern.test(payload.accountId))) {
      return json({ error: 'invalid_calendar_account' }, 400, cors)
    }

    const admin = adminClient()
    let calendarAccount: { email: string; scopes: string[] } | null = null
    if (includeCalendar) {
      const { data, error } = await admin.from('email_accounts')
        .select('email,scopes')
        .eq('id', payload.accountId as string)
        .eq('user_id', user.id)
        .eq('provider', 'gmail')
        .maybeSingle()
      if (error) throw error
      if (!data) return json({ error: 'invalid_calendar_account' }, 400, cors)
      if (data.email.toLowerCase() !== calendarTargetEmail) return json({ error: 'invalid_calendar_target' }, 409, cors)
      calendarAccount = data
    }

    const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']
    if (includeDrive || calendarAccount?.scopes.includes(driveReadonlyScope)) scopes.push(driveReadonlyScope)
    if (includeCalendar) scopes.push(calendarEventsOwnedScope)

    const { data: rateAllowed, error: rateError } = await admin.rpc('consume_audit_rate_limit', {
      p_event_type: 'gmail_oauth_start_requested',
      p_limit: 5,
      p_user_id: user.id,
      p_window_seconds: 60,
    })
    if (rateError) throw rateError
    if (rateAllowed !== true) return json({ error: 'rate_limited' }, 429, { ...cors, 'retry-after': '60' })

    const { error: cleanupError } = await admin.from('oauth_states')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', 'gmail')
      .lt('expires_at', new Date().toISOString())
    if (cleanupError) throw cleanupError

    const state = randomState()
    const { error } = await admin.from('oauth_states').insert({
      account_id: includeCalendar ? payload.accountId : null,
      user_id: user.id,
      provider: 'gmail',
      state_hash: await sha256Hex(state),
      scopes,
      redirect_uri: oauth.redirectUri,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    })
    if (error) throw error

    const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    googleUrl.searchParams.set('client_id', oauth.clientId)
    googleUrl.searchParams.set('redirect_uri', oauth.redirectUri)
    googleUrl.searchParams.set('response_type', 'code')
    googleUrl.searchParams.set('access_type', 'offline')
    googleUrl.searchParams.set('include_granted_scopes', 'true')
    googleUrl.searchParams.set('prompt', 'consent')
    googleUrl.searchParams.set('scope', scopes.join(' '))
    googleUrl.searchParams.set('state', state)
    if (calendarAccount?.email) googleUrl.searchParams.set('login_hint', calendarAccount.email)
    return json({ authorizationUrl: googleUrl.toString() }, 200, cors)
  } catch (error) {
    const code = errorCode(error)
    console.error(code)
    return json({ error: code }, code === 'oauth_not_configured' ? 503 : 500, cors)
  }
})
