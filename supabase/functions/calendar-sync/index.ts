import { createClient } from 'npm:@supabase/supabase-js@2'
import { decryptSecret, sha256Hex } from '../_shared/crypto.ts'
import { corsHeaders, json } from '../_shared/http.ts'

const calendarScopes = new Set([
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.owned',
])
const calendarTargetEmail = 'siostarr@hairartclinics.com'
const sourceTypes = new Set(['obligation', 'deadline'])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const automaticLookbackDays = 90
const maximumAutomaticItems = 20

type Admin = ReturnType<typeof adminClient>
type SourceType = 'obligation' | 'deadline'

interface ConnectionRow {
  account_id: string
  auto_sync: boolean
  calendar_id: string
  reminder_minutes: number
  status: string
  user_id: string
}

interface AccountRow {
  email: string
  id: string
  scopes: string[]
  status: string
  user_id: string
}

interface SourceRecord {
  id: string
  payload: Record<string, unknown>
  sourceType: SourceType
  updatedAt: string
}

interface EventLinkRow {
  id: string
  provider_event_id: string
  source_id: string
  source_type: SourceType
}

class CalendarFailure extends Error {
  constructor(readonly code: string, readonly status = 502) {
    super(code)
  }
}

function env(name: string) {
  const value = Deno.env.get(name)
  if (!value) throw new CalendarFailure('calendar_not_configured', 503)
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
  const client = createClient(env('SUPABASE_URL'), publishableKey(), { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await client.auth.getUser(token)
  return error ? null : data.user
}

async function workerAuthorized(request: Request) {
  const supplied = request.headers.get('x-worker-secret')
  if (!supplied) return false
  return await sha256Hex(supplied) === await sha256Hex(env('WORKER_CRON_SECRET'))
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3) {
  let response: Response | null = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    response = await fetch(url, init)
    if (response.status !== 429 && response.status < 500) return response
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt))
  }
  return response!
}

async function refreshAccessToken(refreshToken: string) {
  const response = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => null) as { error?: string } | null
    if (response.status === 400 && payload?.error === 'invalid_grant') throw new CalendarFailure('calendar_reauthorization_required', 409)
    if (response.status === 401 || payload?.error === 'invalid_client') throw new CalendarFailure('calendar_oauth_client_invalid', 503)
    if (response.status === 429) throw new CalendarFailure('calendar_rate_limited', 429)
    if (response.status >= 500) throw new CalendarFailure('calendar_token_temporarily_unavailable', 503)
    throw new CalendarFailure('calendar_token_refresh_failed')
  }
  const payload = await response.json() as { access_token?: string }
  if (!payload.access_token) throw new CalendarFailure('calendar_access_token_missing')
  return payload.access_token
}

function hasCalendarScope(scopes: unknown) {
  return Array.isArray(scopes) && scopes.some((scope) => typeof scope === 'string' && calendarScopes.has(scope))
}

function safeHttpsUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function safeCalendarUrl(value: unknown) {
  const url = safeHttpsUrl(value)
  if (!url) return null
  const hostname = new URL(url).hostname
  return hostname === 'calendar.google.com' || hostname === 'www.google.com' ? url : null
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function amountLabel(value: unknown, currency: unknown) {
  const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(amount)) return null
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: typeof currency === 'string' ? currency : 'EUR' }).format(amount)
}

function calendarEventId(sourceType: SourceType, sourceId: string) {
  return `muhagent${sourceType}${sourceId.replaceAll('-', '').toLowerCase()}`
}

function limited(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

async function loadSingleSource(admin: Admin, userId: string, sourceType: SourceType, sourceId: string): Promise<SourceRecord> {
  if (sourceType === 'obligation') {
    const { data, error } = await admin.from('obligations')
      .select('id,authority,title,category,amount,currency,due_date,status,evidence_level,updated_at')
      .eq('id', sourceId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw new CalendarFailure('calendar_source_query_failed')
    if (!data) throw new CalendarFailure('calendar_source_not_found', 404)
    if (!data.due_date) throw new CalendarFailure('calendar_date_missing', 400)
    if (['paid', 'cancelled'].includes(data.status)) throw new CalendarFailure('calendar_source_inactive', 409)
    return { id: data.id, payload: data, sourceType, updatedAt: data.updated_at }
  }

  const { data, error } = await admin.from('deadlines')
    .select('id,title,owner,due_at,status,evidence_level,updated_at')
    .eq('id', sourceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new CalendarFailure('calendar_source_query_failed')
  if (!data) throw new CalendarFailure('calendar_source_not_found', 404)
  if (!data.due_at) throw new CalendarFailure('calendar_date_missing', 400)
  if (['done', 'dismissed'].includes(data.status)) throw new CalendarFailure('calendar_source_inactive', 409)
  return { id: data.id, payload: data, sourceType, updatedAt: data.updated_at }
}

async function loadAutomaticSources(admin: Admin, userId: string) {
  const cutoff = new Date(Date.now() - automaticLookbackDays * 86_400_000)
  const cutoffDate = cutoff.toISOString().slice(0, 10)
  const [obligationsResult, deadlinesResult] = await Promise.all([
    admin.from('obligations')
      .select('id,authority,title,category,amount,currency,due_date,status,evidence_level,updated_at')
      .eq('user_id', userId)
      .eq('evidence_level', 'verified')
      .in('status', ['open', 'overdue', 'disputed'])
      .gte('due_date', cutoffDate)
      .order('due_date', { ascending: true })
      .limit(maximumAutomaticItems),
    admin.from('deadlines')
      .select('id,title,owner,due_at,status,evidence_level,updated_at')
      .eq('user_id', userId)
      .eq('evidence_level', 'verified')
      .in('status', ['open', 'waiting'])
      .gte('due_at', cutoff.toISOString())
      .order('due_at', { ascending: true })
      .limit(maximumAutomaticItems),
  ])
  if (obligationsResult.error || deadlinesResult.error) throw new CalendarFailure('calendar_source_query_failed')
  return [
    ...(obligationsResult.data ?? []).map((payload) => ({ id: payload.id, payload, sourceType: 'obligation' as const, updatedAt: payload.updated_at })),
    ...(deadlinesResult.data ?? []).map((payload) => ({ id: payload.id, payload, sourceType: 'deadline' as const, updatedAt: payload.updated_at })),
  ].sort((left, right) => {
    const leftDate = left.sourceType === 'obligation' ? left.payload.due_date : left.payload.due_at
    const rightDate = right.sourceType === 'obligation' ? right.payload.due_date : right.payload.due_at
    return String(leftDate).localeCompare(String(rightDate))
  }).slice(0, maximumAutomaticItems)
}

function eventBody(source: SourceRecord, connection: ConnectionRow) {
  const appOrigin = new URL(env('PUBLIC_APP_ORIGIN'))
  const view = source.sourceType === 'obligation' ? 'payments' : 'deadlines'
  const appUrl = new URL(`/?view=${view}`, appOrigin).toString()
  const payload = source.payload
  const date = source.sourceType === 'obligation'
    ? limited(payload.due_date, 10)
    : new Date(String(payload.due_at)).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CalendarFailure('calendar_date_missing', 400)

  const description: Array<string | null> = source.sourceType === 'obligation'
    ? [
        `Kurum: ${limited(payload.authority, 180)}`,
        amountLabel(payload.amount, payload.currency) ? `Tutar: ${amountLabel(payload.amount, payload.currency)}` : null,
        `Son ödeme: ${date}`,
        `Durum: ${limited(payload.status, 40)}`,
        `Muh Agent kaydı: ${appUrl}`,
      ]
    : [
        `Kurum / sorumlu: ${limited(payload.owner, 180)}`,
        `Son tarih: ${date}`,
        `Durum: ${limited(payload.status, 40)}`,
        `Muh Agent kaydı: ${appUrl}`,
      ]

  const summary = source.sourceType === 'obligation'
    ? `Muh Agent · Ödeme: ${limited(payload.authority, 110) || limited(payload.title, 110)}`
    : `Muh Agent · Süre: ${limited(payload.title, 140)}`

  return {
    body: {
      description: description.filter(Boolean).join('\n').slice(0, 6_000),
      end: { date: addDays(date, 1) },
      extendedProperties: {
        private: {
          muhAgentSourceId: source.id,
          muhAgentSourceType: source.sourceType,
          muhAgentVersion: '1',
        },
      },
      reminders: {
        overrides: [{ method: 'popup', minutes: connection.reminder_minutes }],
        useDefault: false,
      },
      source: { title: 'Muh Agent', url: appUrl },
      start: { date },
      status: 'confirmed',
      summary: summary.slice(0, 200),
      transparency: 'opaque',
      visibility: 'private',
    },
    date,
  }
}

async function calendarError(response: Response) {
  const payload = await response.clone().json().catch(() => null) as { error?: { errors?: Array<{ reason?: string }>; message?: string; status?: string } } | null
  const reason = payload?.error?.errors?.[0]?.reason ?? ''
  const message = payload?.error?.message ?? ''
  const status = payload?.error?.status ?? ''
  const detail = `${reason} ${message} ${status}`
  if (response.status === 401) return new CalendarFailure('calendar_reauthorization_required', 409)
  if (response.status === 403 && /accessnotconfigured|service_disabled|has not been used|disabled/i.test(detail)) {
    return new CalendarFailure('calendar_api_not_enabled', 503)
  }
  if (response.status === 403) return new CalendarFailure('calendar_write_forbidden', 409)
  if (response.status === 429) return new CalendarFailure('calendar_rate_limited', 429)
  return new CalendarFailure('calendar_api_failed')
}

async function writeGoogleEvent(accessToken: string, calendarId: string, providerEventId: string, body: Record<string, unknown>) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  const eventUrl = `${base}/${encodeURIComponent(providerEventId)}`
  const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }
  const existing = await fetchWithRetry(eventUrl, { headers })

  if (existing.ok) {
    const etag = existing.headers.get('etag')
    const response = await fetchWithRetry(`${eventUrl}?sendUpdates=none`, {
      method: 'PUT',
      headers: etag ? { ...headers, 'if-match': etag } : headers,
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await calendarError(response)
    return { action: 'updated', event: await response.json() as { htmlLink?: string; id?: string } }
  }

  if (existing.status !== 404 && existing.status !== 410) throw await calendarError(existing)
  const response = await fetchWithRetry(`${base}?sendUpdates=none`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, id: providerEventId }),
  })
  if (response.status === 409) {
    const update = await fetchWithRetry(`${eventUrl}?sendUpdates=none`, { method: 'PUT', headers, body: JSON.stringify(body) })
    if (!update.ok) throw await calendarError(update)
    return { action: 'updated', event: await update.json() as { htmlLink?: string; id?: string } }
  }
  if (!response.ok) throw await calendarError(response)
  return { action: 'created', event: await response.json() as { htmlLink?: string; id?: string } }
}

async function deleteGoogleEvent(accessToken: string, calendarId: string, providerEventId: string) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(providerEventId)}?sendUpdates=none`
  const response = await fetchWithRetry(url, { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` } })
  if (response.ok || response.status === 404 || response.status === 410) return
  throw await calendarError(response)
}

async function retireInactiveEvents(admin: Admin, connection: ConnectionRow, accessToken: string, actor: 'user' | 'worker') {
  const { data: links, error: linksError } = await admin.from('calendar_event_links')
    .select('id,provider_event_id,source_id,source_type')
    .eq('account_id', connection.account_id)
    .eq('user_id', connection.user_id)
    .eq('status', 'active')
    .limit(250)
  if (linksError) throw new CalendarFailure('calendar_link_query_failed')
  if (!links?.length) return { artifacts: [] as Array<Record<string, unknown>>, deleted: 0, failed: 0, lastError: null as string | null }

  const typedLinks = links as EventLinkRow[]
  const obligationIds = typedLinks.filter((link) => link.source_type === 'obligation').map((link) => link.source_id)
  const deadlineIds = typedLinks.filter((link) => link.source_type === 'deadline').map((link) => link.source_id)
  const obligationResult = obligationIds.length
    ? await admin.from('obligations').select('id,status').eq('user_id', connection.user_id).in('id', obligationIds)
    : { data: [], error: null }
  const deadlineResult = deadlineIds.length
    ? await admin.from('deadlines').select('id,status').eq('user_id', connection.user_id).in('id', deadlineIds)
    : { data: [], error: null }
  if (obligationResult.error || deadlineResult.error) throw new CalendarFailure('calendar_source_query_failed')

  const activeObligations = new Set((obligationResult.data ?? []).filter((row) => !['paid', 'cancelled'].includes(row.status)).map((row) => row.id))
  const activeDeadlines = new Set((deadlineResult.data ?? []).filter((row) => !['done', 'dismissed'].includes(row.status)).map((row) => row.id))
  const artifacts: Array<Record<string, unknown>> = []
  let deleted = 0
  let failed = 0
  let lastError: string | null = null

  for (const link of typedLinks) {
    const remainsActive = link.source_type === 'obligation' ? activeObligations.has(link.source_id) : activeDeadlines.has(link.source_id)
    if (remainsActive) continue
    try {
      const { error: intentAuditError } = await admin.from('audit_events').insert({
        actor,
        event_type: 'calendar_event_delete_started',
        metadata: { account_id: connection.account_id, calendar_id: connection.calendar_id, provider_event_id: link.provider_event_id },
        object_id: link.source_id,
        object_type: link.source_type,
        user_id: connection.user_id,
      })
      if (intentAuditError) throw new CalendarFailure('calendar_audit_failed')
      await deleteGoogleEvent(accessToken, connection.calendar_id, link.provider_event_id)
      const { error: updateError } = await admin.from('calendar_event_links').update({
        event_url: null,
        last_error_code: null,
        last_synced_at: new Date().toISOString(),
        status: 'deleted',
      }).eq('id', link.id).eq('account_id', connection.account_id).eq('user_id', connection.user_id)
      if (updateError) throw new CalendarFailure('calendar_link_save_failed')
      const { error: auditError } = await admin.from('audit_events').insert({
        actor,
        event_type: 'calendar_event_deleted',
        metadata: { account_id: connection.account_id, calendar_id: connection.calendar_id },
        object_id: link.source_id,
        object_type: link.source_type,
        user_id: connection.user_id,
      })
      if (auditError) throw new CalendarFailure('calendar_audit_failed')
      deleted += 1
      artifacts.push({ action: 'deleted', eventId: link.provider_event_id, sourceId: link.source_id, sourceType: link.source_type })
    } catch (error) {
      failed += 1
      lastError = error instanceof CalendarFailure ? error.code : 'calendar_event_delete_failed'
      artifacts.push({ action: 'failed', error: lastError, eventId: link.provider_event_id, sourceId: link.source_id, sourceType: link.source_type })
      if (['calendar_reauthorization_required', 'calendar_api_not_enabled', 'calendar_write_forbidden'].includes(lastError)) break
    }
  }

  return { artifacts, deleted, failed, lastError }
}

async function existingLink(admin: Admin, accountId: string, source: SourceRecord) {
  const { data, error } = await admin.from('calendar_event_links')
    .select('event_url,last_synced_at,payload_hash,provider_event_id,status')
    .eq('account_id', accountId)
    .eq('source_type', source.sourceType)
    .eq('source_id', source.id)
    .maybeSingle()
  if (error) throw new CalendarFailure('calendar_link_query_failed')
  return data
}

async function saveLink(admin: Admin, connection: ConnectionRow, source: SourceRecord, providerEventId: string, payloadHash: string, eventUrl: string | null, errorCode?: string) {
  const { error } = await admin.from('calendar_event_links').upsert({
    account_id: connection.account_id,
    event_url: eventUrl,
    last_error_code: errorCode ?? null,
    last_synced_at: new Date().toISOString(),
    payload_hash: payloadHash,
    provider_event_id: providerEventId,
    source_id: source.id,
    source_type: source.sourceType,
    status: errorCode ? 'error' : 'active',
    user_id: connection.user_id,
  }, { onConflict: 'account_id,source_type,source_id' })
  if (error) throw new CalendarFailure('calendar_link_save_failed')
}

async function syncSource(admin: Admin, connection: ConnectionRow, accessToken: string, source: SourceRecord, force: boolean, actor: 'user' | 'worker') {
  const baseEventId = calendarEventId(source.sourceType, source.id)
  const event = eventBody(source, connection)
  const payloadHash = await sha256Hex(JSON.stringify({ ...event.body, sourceUpdatedAt: source.updatedAt }))
  const link = await existingLink(admin, connection.account_id, source)
  const providerEventId = link?.status === 'deleted'
    ? `${baseEventId}${payloadHash.slice(0, 8)}`
    : link?.provider_event_id ?? baseEventId
  const sevenDaysAgo = Date.now() - 7 * 86_400_000
  if (!force && link?.status === 'active' && link.payload_hash === payloadHash && new Date(link.last_synced_at).getTime() > sevenDaysAgo) {
    return { action: 'skipped', eventId: providerEventId, eventUrl: safeCalendarUrl(link.event_url), sourceId: source.id, sourceType: source.sourceType }
  }

  try {
    const { error: intentAuditError } = await admin.from('audit_events').insert({
      actor,
      event_type: 'calendar_event_sync_started',
      metadata: { account_id: connection.account_id, calendar_id: connection.calendar_id, provider_event_id: providerEventId, reminder_minutes: connection.reminder_minutes },
      object_id: source.id,
      object_type: source.sourceType,
      user_id: connection.user_id,
    })
    if (intentAuditError) throw new CalendarFailure('calendar_audit_failed')
    const result = await writeGoogleEvent(accessToken, connection.calendar_id, providerEventId, event.body)
    const eventUrl = safeCalendarUrl(result.event.htmlLink)
    await saveLink(admin, connection, source, providerEventId, payloadHash, eventUrl)
    const { error: auditError } = await admin.from('audit_events').insert({
      actor,
      event_type: result.action === 'created' ? 'calendar_event_created' : 'calendar_event_updated',
      metadata: { account_id: connection.account_id, calendar_id: connection.calendar_id, reminder_minutes: connection.reminder_minutes },
      object_id: source.id,
      object_type: source.sourceType,
      user_id: connection.user_id,
    })
    if (auditError) throw new CalendarFailure('calendar_audit_failed')
    return { action: result.action, eventId: providerEventId, eventUrl, sourceId: source.id, sourceType: source.sourceType }
  } catch (error) {
    const code = error instanceof CalendarFailure ? error.code : 'calendar_event_sync_failed'
    await saveLink(admin, connection, source, providerEventId, payloadHash, safeCalendarUrl(link?.event_url), code).catch(() => undefined)
    throw error
  }
}

async function loadConnectionAccount(admin: Admin, connection: ConnectionRow) {
  const { data, error } = await admin.from('email_accounts')
    .select('id,user_id,email,status,scopes')
    .eq('id', connection.account_id)
    .eq('user_id', connection.user_id)
    .eq('provider', 'gmail')
    .maybeSingle()
  if (error) throw new CalendarFailure('calendar_account_query_failed')
  const account = data as AccountRow | null
  if (!account || account.status !== 'connected' || !hasCalendarScope(account.scopes)) {
    throw new CalendarFailure('calendar_reauthorization_required', 409)
  }
  if (account.email.toLowerCase() !== calendarTargetEmail) throw new CalendarFailure('calendar_target_account_invalid', 409)
  return account
}

async function syncConnection(admin: Admin, connection: ConnectionRow, requestedSource: { sourceId: string; sourceType: SourceType } | null, force: boolean, actor: 'user' | 'worker') {
  let account: AccountRow
  try {
    account = await loadConnectionAccount(admin, connection)
    const { data: token, error: tokenError } = await admin.from('email_tokens').select('refresh_token_ciphertext').eq('account_id', account.id).maybeSingle()
    if (tokenError || !token) throw new CalendarFailure('calendar_token_missing', 409)
    const refreshToken = await decryptSecret(token.refresh_token_ciphertext, env('TOKEN_ENCRYPTION_KEY'))
    const accessToken = await refreshAccessToken(refreshToken)
    const sources = requestedSource
      ? [await loadSingleSource(admin, connection.user_id, requestedSource.sourceType, requestedSource.sourceId)]
      : await loadAutomaticSources(admin, connection.user_id)

    const artifacts: Array<Record<string, unknown>> = []
    const counts = { created: 0, deleted: 0, failed: 0, skipped: 0, updated: 0 }
    let lastError: string | null = null
    for (const source of sources) {
      try {
        const result = await syncSource(admin, connection, accessToken, source, force, actor)
        counts[result.action as keyof typeof counts] += 1
        artifacts.push(result)
      } catch (error) {
        counts.failed += 1
        lastError = error instanceof CalendarFailure ? error.code : 'calendar_event_sync_failed'
        artifacts.push({ action: 'failed', error: lastError, sourceId: source.id, sourceType: source.sourceType })
        if (['calendar_reauthorization_required', 'calendar_api_not_enabled', 'calendar_write_forbidden'].includes(lastError)) break
      }
    }

    if (!['calendar_reauthorization_required', 'calendar_api_not_enabled', 'calendar_write_forbidden'].includes(lastError ?? '')) {
      const retirement = await retireInactiveEvents(admin, connection, accessToken, actor)
      counts.deleted += retirement.deleted
      counts.failed += retirement.failed
      artifacts.push(...retirement.artifacts)
      lastError ??= retirement.lastError
    }

    await admin.from('calendar_connections').update({
      last_error_code: lastError,
      last_sync_at: new Date().toISOString(),
      status: lastError === 'calendar_reauthorization_required' ? 'reauth_required' : lastError ? 'error' : 'connected',
    }).eq('account_id', connection.account_id).eq('user_id', connection.user_id)
    const { error: auditError } = await admin.from('audit_events').insert({
      actor,
      event_type: 'calendar_sync_completed',
      metadata: { account_id: connection.account_id, ...counts, requested_source: requestedSource?.sourceType ?? null },
      object_id: connection.account_id,
      object_type: 'calendar_connection',
      user_id: connection.user_id,
    })
    if (auditError) throw new CalendarFailure('calendar_audit_failed')
    return { accountEmail: account.email, accountId: account.id, artifacts, counts, status: lastError ? 'warning' : 'success' }
  } catch (error) {
    const code = error instanceof CalendarFailure ? error.code : 'calendar_sync_failed'
    await admin.from('calendar_connections').update({
      last_error_code: code,
      last_sync_at: new Date().toISOString(),
      status: code === 'calendar_reauthorization_required' ? 'reauth_required' : 'error',
    }).eq('account_id', connection.account_id).eq('user_id', connection.user_id)
    throw error
  }
}

async function userRateAllowed(admin: Admin, userId: string) {
  const { data, error } = await admin.rpc('consume_audit_rate_limit', {
    p_event_type: 'calendar_sync_requested',
    p_limit: 10,
    p_user_id: userId,
    p_window_seconds: 60,
  })
  if (error) throw new CalendarFailure('calendar_rate_limit_query_failed')
  return data === true
}

async function claimConnection(admin: Admin, connection: ConnectionRow, leaseToken: string) {
  const { data, error } = await admin.rpc('claim_calendar_connection', {
    p_account_id: connection.account_id,
    p_lease_seconds: 300,
    p_lease_token: leaseToken,
    p_user_id: connection.user_id,
  })
  if (error) throw new CalendarFailure('calendar_lease_failed')
  return data === true
}

async function releaseConnection(admin: Admin, connection: ConnectionRow, leaseToken: string) {
  const { error } = await admin.from('calendar_connections').update({ sync_lease_token: null, sync_lease_until: null })
    .eq('account_id', connection.account_id)
    .eq('user_id', connection.user_id)
    .eq('sync_lease_token', leaseToken)
  if (error) console.error(JSON.stringify({ event: 'calendar_lease_release_failed', account_id: connection.account_id }))
}

Deno.serve(async (request) => {
  const cors = corsHeaders(request)
  if (request.method === 'OPTIONS') return cors ? new Response(null, { status: 204, headers: cors }) : json({ error: 'origin_not_allowed' }, 403)
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST, OPTIONS', ...(cors ?? {}) })

  try {
    const user = cors ? await authenticatedUser(request) : null
    const worker = user ? false : await workerAuthorized(request)
    if (!user && !worker) return json({ error: cors ? 'unauthorized' : 'origin_not_allowed' }, 401, cors ?? {})

    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const accountId = typeof body.accountId === 'string' ? body.accountId : null
    const sourceType = typeof body.sourceType === 'string' && sourceTypes.has(body.sourceType) ? body.sourceType as SourceType : null
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : null
    const requestedSource = sourceType && sourceId && uuidPattern.test(sourceId) ? { sourceId, sourceType } : null
    if (user && (!accountId || !uuidPattern.test(accountId))) return json({ error: 'invalid_calendar_account' }, 400, cors ?? {})
    if (user && ((body.sourceType || body.sourceId) && !requestedSource)) return json({ error: 'invalid_calendar_source' }, 400, cors ?? {})
    if (worker && (body.accountId || body.sourceType || body.sourceId)) return json({ error: 'invalid_worker_request' }, 400)

    const admin = adminClient()
    if (user && !await userRateAllowed(admin, user.id)) return json({ error: 'calendar_rate_limited' }, 429, { ...(cors ?? {}), 'retry-after': '60' })

    let query = admin.from('calendar_connections')
      .select('account_id,user_id,calendar_id,auto_sync,reminder_minutes,status')
      .eq('auto_sync', true)
      .in('status', ['connected', 'error'])
      .order('last_sync_at', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: true })
      .limit(25)
    query = user ? query.eq('user_id', user.id).eq('account_id', accountId!) : query
    const { data, error } = await query
    if (error) throw new CalendarFailure('calendar_connection_query_failed')
    if (!data?.length) throw new CalendarFailure('calendar_connection_missing', 409)

    const results = []
    for (const connection of data as ConnectionRow[]) {
      const leaseToken = crypto.randomUUID()
      const claimed = await claimConnection(admin, connection, leaseToken)
      if (!claimed) {
        if (user) throw new CalendarFailure('calendar_sync_in_progress', 409)
        results.push({ accountId: connection.account_id, artifacts: [], counts: { created: 0, deleted: 0, failed: 0, skipped: 1, updated: 0 }, status: 'warning' })
        continue
      }
      try {
        results.push(await syncConnection(admin, connection, requestedSource, user ? true : body.force === true, user ? 'user' : 'worker'))
      } catch (error) {
        if (user) throw error
        const code = error instanceof CalendarFailure ? error.code : 'calendar_sync_failed'
        results.push({ accountId: connection.account_id, artifacts: [{ action: 'failed', error: code }], counts: { created: 0, deleted: 0, failed: 1, skipped: 0, updated: 0 }, status: 'warning' })
      } finally {
        await releaseConnection(admin, connection, leaseToken)
      }
    }
    const totals = results.reduce((sum, result) => ({
      created: sum.created + result.counts.created,
      deleted: sum.deleted + result.counts.deleted,
      failed: sum.failed + result.counts.failed,
      skipped: sum.skipped + result.counts.skipped,
      updated: sum.updated + result.counts.updated,
    }), { created: 0, deleted: 0, failed: 0, skipped: 0, updated: 0 })
    const status = totals.failed ? 'warning' : 'success'
    return json({
      artifacts: results.flatMap((result) => result.artifacts),
      completedAt: new Date().toISOString(),
      nextActions: totals.failed ? ['Ayarlar bölümünde takvim bağlantı hatasını kontrol et.'] : [],
      status,
      summary: `${totals.created} oluşturuldu, ${totals.updated} güncellendi, ${totals.deleted} kapatıldı, ${totals.skipped} değişmedi, ${totals.failed} hata`,
      totals,
    }, 200, cors ?? {})
  } catch (error) {
    const code = error instanceof CalendarFailure ? error.code : 'calendar_sync_failed'
    const status = error instanceof CalendarFailure ? error.status : 502
    console.error(JSON.stringify({ event: 'calendar_sync_failed', code }))
    return json({ error: code, nextActions: ['Takvim iznini ve Google Calendar API durumunu kontrol et.'], status: 'error', summary: 'Takvim eşitlemesi tamamlanamadı.' }, status, cors ?? {})
  }
})
