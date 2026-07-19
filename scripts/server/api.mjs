import { createSupabaseRequestClient } from './supabase.mjs'
import { createResponseState, readJson, requireSameOrigin, writeJson, writeMethodNotAllowed, writeRedirect } from './http.mjs'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
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

async function requestLink(request, response, config) {
  const state = createResponseState()
  if (!method(request, response, ['POST'], state)) return true
  if (!liveOnly(response, config, state) || !sameOriginOnly(request, response, config, state)) return true
  if (!withinRateLimit(request, 'auth-link')) {
    writeJson(response, 429, { error: 'rate_limited' }, state, { 'Retry-After': '60' })
    return true
  }

  const body = await readJson(request)
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (email.length > 254 || !emailPattern.test(email)) {
    writeJson(response, 400, { error: 'invalid_email' }, state)
    return true
  }

  const context = createSupabaseRequestClient(request, config)
  const { error } = await context.client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${config.appOrigin}/auth/callback`,
      shouldCreateUser: false,
    },
  })
  if (error) console.error('auth_link_request_failed')
  // Identical response prevents account enumeration.
  writeJson(response, 202, { accepted: true }, context.state)
  return true
}

async function authCallback(request, response, config) {
  const state = createResponseState()
  if (!method(request, response, ['GET'], state)) return true
  if (!liveOnly(response, config, state)) return true
  const url = new URL(request.url ?? '/auth/callback', config.appOrigin)
  const code = url.searchParams.get('code')
  if (!code || code.length > 2_048) {
    writeRedirect(response, `${config.appOrigin}/?auth=invalid`, state)
    return true
  }
  const context = createSupabaseRequestClient(request, config)
  const { error } = await context.client.auth.exchangeCodeForSession(code)
  writeRedirect(response, `${config.appOrigin}/?auth=${error ? 'error' : 'success'}`, context.state)
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
    console.error('gmail_connect_failed')
    writeJson(response, 502, { error: 'gmail_connect_failed' }, context.state)
    return true
  }
  const authorizationUrl = new URL(data.authorizationUrl)
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
    if (path === '/api/auth/request-link') return await requestLink(request, response, config)
    if (path === '/api/auth/signout') return await signOut(request, response, config)
    if (path === '/api/dashboard') return await dashboard(request, response, config)
    if (path === '/api/gmail/connect') return await gmailConnect(request, response, config)
    if (path === '/auth/callback') return await authCallback(request, response, config)
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
