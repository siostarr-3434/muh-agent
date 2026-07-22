import { createSupabaseRequestClient } from './supabase.mjs'
import { createResponseState, readJson, requireSameOrigin, writeJson, writeMethodNotAllowed } from './http.mjs'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const passwordMaximumLength = 128
const passwordMinimumLength = 12
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const requestWindows = new Map()

function method(request, response, allowed, state) {
  if (allowed.includes(request.method ?? 'GET')) return true
  writeMethodNotAllowed(response, allowed, state)
  return false
}

function liveOnly(response, config, state) {
  if (config.live) return true
  writeJson(response, 503, { error: 'live_connection_not_configured', mode: 'demo' }, state)
  return false
}

function sameOriginOnly(request, response, config, state) {
  if (requireSameOrigin(request, config.appOrigin)) return true
  writeJson(response, 403, { error: 'origin_not_allowed' }, state)
  return false
}

function withinRateLimit(request, key, limit = 5, windowMs = 60_000) {
  const now = Date.now()
  const address = request.socket.remoteAddress ?? 'unknown'
  const bucketKey = `${address}:${key}`
  const previous = requestWindows.get(bucketKey)?.filter((time) => now - time < windowMs) ?? []
  if (previous.length >= limit) return false
  previous.push(now)
  requestWindows.set(bucketKey, previous)
  if (requestWindows.size > 1_000) {
    for (const [candidate, times] of requestWindows) {
      if (!times.some((time) => now - time < windowMs)) requestWindows.delete(candidate)
    }
  }
  return true
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= passwordMinimumLength && value.length <= passwordMaximumLength
}

async function authenticated(request, response, config) {
  const context = createSupabaseRequestClient(request, config)
  const { data, error } = await context.client.auth.getUser()
  if (error || !data.user) {
    writeJson(response, 401, { error: 'unauthorized' }, context.state)
    return null
  }
  return { ...context, user: data.user }
}

function normalizeApproval(row) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {}
  return {
    actionType: row.action_type,
    amount: typeof payload.amount === 'number' ? payload.amount : null,
    description: typeof payload.description === 'string' ? payload.description : '',
    expiresAt: row.expires_at,
    id: row.id,
    risk: row.risk,
    status: row.status,
    title: typeof payload.title === 'string' ? payload.title : row.action_type,
  }
}

async function dashboard(request, response, config) {
  if (!method(request, response, ['GET'])) return true
  if (!liveOnly(response, config)) return true
  const context = await authenticated(request, response, config)
  if (!context) return true
  const userId = context.user.id

  const [obligationsResult, deadlinesResult, approvalsResult, accountsResult, messagesResult, documentsResult] = await Promise.all([
    context.client.from('obligations').select('id,authority,title,category,amount,currency,due_date,status,evidence_level,source_url,note').eq('user_id', userId).order('due_date', { ascending: true }),
    context.client.from('deadlines').select('id,title,owner,due_at,status,evidence_level,source_url').eq('user_id', userId).order('due_at', { ascending: true }),
    context.client.from('approvals').select('id,action_type,risk,payload,status,expires_at,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
    context.client.from('email_accounts').select('id,provider,email,label,status,scopes,last_sync_at,last_error_code').eq('user_id', userId).order('created_at', { ascending: true }),
    context.client.from('email_messages').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    context.client.from('documents').select('id', { count: 'exact', head: true }).eq('user_id', userId),
  ])

  const failed = [obligationsResult, deadlinesResult, approvalsResult, accountsResult, messagesResult, documentsResult].some((result) => result.error)
  if (failed) {
    console.error('dashboard_query_failed')
    writeJson(response, 502, { error: 'dashboard_unavailable' }, context.state)
    return true
  }

  writeJson(response, 200, {
    accounts: accountsResult.data ?? [],
    approvals: (approvalsResult.data ?? []).map(normalizeApproval),
    counts: { documents: documentsResult.count ?? 0, messages: messagesResult.count ?? 0 },
    deadlines: deadlinesResult.data ?? [],
    obligations: obligationsResult.data ?? [],
  }, context.state)
  return true
}

async function passwordSignIn(request, response, config) {
  const state = createResponseState()
  if (!method(request, response, ['POST'], state)) return true
  if (!liveOnly(response, config, state) || !sameOriginOnly(request, response, config, state)) return true
  if (!withinRateLimit(request, 'auth-password')) {
    writeJson(response, 429, { error: 'rate_limited' }, state, { 'Retry-After': '60' })
    return true
  }

  const body = await readJson(request)
  const email = normalizeEmail(body?.email)
  const password = body?.password
  if (email.length > 254 || !emailPattern.test(email) || !validPassword(password)) {
    writeJson(response, 400, { error: 'invalid_credentials' }, state)
    return true
  }

  const context = createSupabaseRequestClient(request, config)
  const { data, error } = await context.client.auth.signInWithPassword({
    email,
    password,
  })
  if (error || !data.session || !data.user) {
    writeJson(response, 401, { error: 'invalid_credentials' }, context.state)
    return true
  }
  writeJson(response, 200, { signedIn: true }, context.state)
  return true
}

async function setPassword(request, response, config) {
  const state = createResponseState()
  if (!method(request, response, ['POST'], state)) return true
  if (!liveOnly(response, config, state) || !sameOriginOnly(request, response, config, state)) return true
  if (!withinRateLimit(request, 'auth-password-update')) {
    writeJson(response, 429, { error: 'rate_limited' }, state, { 'Retry-After': '60' })
    return true
  }

  const body = await readJson(request)
  if (!validPassword(body?.password)) {
    writeJson(response, 400, { error: 'invalid_password' }, state)
    return true
  }

  const context = createSupabaseRequestClient(request, config)
  const { data, error: userError } = await context.client.auth.getUser()
  if (userError || !data.user) {
    writeJson(response, 401, { error: 'unauthorized' }, context.state)
    return true
  }
  const { error } = await context.client.auth.updateUser({ password: body.password })
  if (error) {
    const code = /reauthentication/i.test(error.message) ? 'password_reauthentication_required' : 'password_update_failed'
    console.error(code)
    writeJson(response, 400, { error: code }, context.state)
    return true
  }
  writeJson(response, 200, { passwordUpdated: true }, context.state)
  return true
}

async function session(request, response, config) {
  const state = createResponseState()
  if (!method(request, response, ['GET'], state)) return true
  if (!config.live) {
    writeJson(response, 200, { authenticated: false, mode: 'demo' }, state)
    return true
  }
  const context = createSupabaseRequestClient(request, config)
  const { data, error } = await context.client.auth.getUser()
  writeJson(response, 200, {
    authenticated: !error && Boolean(data.user),
    email: !error ? data.user?.email ?? null : null,
    mode: 'live',
  }, context.state)
  return true
}

async function signOut(request, response, config) {
  const state = createResponseState()
  if (!method(request, response, ['POST'], state)) return true
  if (!liveOnly(response, config, state) || !sameOriginOnly(request, response, config, state)) return true
  const context = createSupabaseRequestClient(request, config)
  await context.client.auth.signOut({ scope: 'local' })
  writeJson(response, 200, { signedOut: true }, context.state)
  return true
}

async function approvalDecision(request, response, config, approvalId) {
  const state = createResponseState()
  if (!method(request, response, ['POST'], state)) return true
  if (!liveOnly(response, config, state) || !sameOriginOnly(request, response, config, state)) return true
  if (!uuidPattern.test(approvalId)) {
    writeJson(response, 400, { error: 'invalid_approval_id' }, state)
    return true
  }
  const body = await readJson(request)
  if (!['approved', 'rejected'].includes(body?.decision)) {
    writeJson(response, 400, { error: 'invalid_decision' }, state)
    return true
  }
  const context = await authenticated(request, response, config)
  if (!context) return true
  const { data, error } = await context.client.functions.invoke('approval-decision', {
    body: { decision: body.decision, id: approvalId },
    headers: { Origin: config.appOrigin },
  })
  if (error) {
    console.error('approval_decision_failed')
    writeJson(response, 502, { error: 'approval_decision_failed' }, context.state)
    return true
  }
  writeJson(response, 200, data, context.state)
  return true
}

async function invokedFunctionErrorCode(error) {
  const context = error && typeof error === 'object' ? error.context : null
  if (!context || typeof context.clone !== 'function') return null
  const payload = await context.clone().json().catch(() => null)
  const code = payload && typeof payload.error === 'string' ? payload.error : null
  return code && /^[a-z_]{3,80}$/.test(code) ? code : null
}

async function gmailConnect(request, response, config) {
  const state = createResponseState()
  if (!method(request, response, ['POST'], state)) return true
  if (!liveOnly(response, config, state) || !sameOriginOnly(request, response, config, state)) return true
  const body = await readJson(request)
  if (body?.includeDrive !== undefined && typeof body.includeDrive !== 'boolean') {
    writeJson(response, 400, { error: 'invalid_request' }, state)
    return true
  }
  const context = await authenticated(request, response, config)
  if (!context) return true
  const { data, error } = await context.client.functions.invoke('gmail-oauth-start', {
    body: { includeDrive: body?.includeDrive === true },
    headers: { Origin: config.appOrigin },
  })
  if (error || typeof data?.authorizationUrl !== 'string') {
    const edgeError = error ? await invokedFunctionErrorCode(error) : null
    const code = edgeError === 'oauth_not_configured' || edgeError === 'rate_limited' || edgeError === 'oauth_start_failed'
      ? edgeError
      : 'gmail_connect_failed'
    console.error('gmail_connect_failed')
    writeJson(response, edgeError === 'rate_limited' ? 429 : 502, { error: code }, context.state)
    return true
  }
  let authorizationUrl
  try {
    authorizationUrl = new URL(data.authorizationUrl)
  } catch {
    writeJson(response, 502, { error: 'invalid_oauth_destination' }, context.state)
    return true
  }
  if (authorizationUrl.protocol !== 'https:' || authorizationUrl.hostname !== 'accounts.google.com') {
    writeJson(response, 502, { error: 'invalid_oauth_destination' }, context.state)
    return true
  }
  writeJson(response, 200, { authorizationUrl: authorizationUrl.toString() }, context.state)
  return true
}

export async function handleApplicationRoute(request, response, config, path) {
  try {
    if (path === '/api/session') return await session(request, response, config)
    if (path === '/api/auth/sign-in') return await passwordSignIn(request, response, config)
    if (path === '/api/auth/password') return await setPassword(request, response, config)
    if (path === '/api/auth/signout') return await signOut(request, response, config)
    if (path === '/api/dashboard') return await dashboard(request, response, config)
    if (path === '/api/gmail/connect') return await gmailConnect(request, response, config)
    if (path === '/auth/callback') {
      writeJson(response, 410, { error: 'password_login_only' }, createResponseState())
      return true
    }
    const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/decision$/)
    if (approvalMatch) return await approvalDecision(request, response, config, approvalMatch[1])
    if (path.startsWith('/api/') || path === '/auth') {
      writeJson(response, 404, { error: 'not_found' }, createResponseState())
      return true
    }
    return false
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500
    if (status === 500) console.error('application_route_failed')
    writeJson(response, status, { error: status === 500 ? 'internal_error' : error.message }, createResponseState())
    return true
  }
}
