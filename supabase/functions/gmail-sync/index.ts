import { createClient } from 'npm:@supabase/supabase-js@2'
import { decryptSecret, sha256Hex } from '../_shared/crypto.ts'
import { json } from '../_shared/http.ts'

function env(name: string) {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function adminClient() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
}

async function refreshAccessToken(refreshToken: string) {
  const response = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), grant_type: 'refresh_token' }),
  })
  if (!response.ok) throw new Error('refresh_token_rejected')
  const payload = await response.json() as { access_token?: string }
  if (!payload.access_token) throw new Error('access_token_missing')
  return payload.access_token
}

async function gmailJson(path: string, accessToken: string) {
  const response = await fetchWithRetry(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${accessToken}` } })
  if (!response.ok) throw new Error('gmail_api_failed')
  return await response.json()
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3) {
  let response: Response | null = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    response = await fetch(url, init)
    if (response.status !== 429 && response.status < 500) return response
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
  }
  return response!
}

async function workerAuthorized(request: Request) {
  const supplied = request.headers.get('x-worker-secret')
  if (!supplied) return false
  return await sha256Hex(supplied) === await sha256Hex(env('WORKER_CRON_SECRET'))
}

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  return headers?.find((item) => item.name?.toLowerCase() === name)?.value ?? null
}

const inboxMessageLimit = 30
const officialMessageLimit = 30
const queuedMessageLimit = 30
const officialGmailQuery = '{from:ind.nl from:cjib.nl from:belastingdienst.nl from:waterland.nl from:rechtspraak.nl from:om.nl from:politie.nl from:mijnoverheid.nl from:uwv.nl from:svb.nl from:digid.nl} newer_than:730d'

const dutchMonths: Record<string, number> = {
  januari: 1,
  februari: 2,
  maart: 3,
  april: 4,
  mei: 5,
  juni: 6,
  juli: 7,
  augustus: 8,
  september: 9,
  oktober: 10,
  november: 11,
  december: 12,
}

function compactText(...parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

function lowerText(value: string) {
  return value.toLocaleLowerCase('nl-NL')
}

function emailDomain(value: string | null) {
  const match = value?.match(/@([a-z0-9.-]+\.[a-z]{2,})/i)
  return match?.[1]?.toLowerCase() ?? ''
}

function parseDutchAmount(value: string) {
  const normalized = value.replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  const amount = Number(normalized)
  return Number.isFinite(amount) && amount >= 0 ? Number(amount.toFixed(2)) : null
}

function extractAmount(text: string) {
  const prefix = text.match(/(?:€|eur)\s*([0-9][0-9.\s]*(?:[,.][0-9]{2})?)/i)
  if (prefix?.[1]) return parseDutchAmount(prefix[1])
  const suffix = text.match(/([0-9][0-9.\s]*(?:[,.][0-9]{2})?)\s*(?:euro|eur)\b/i)
  return suffix?.[1] ? parseDutchAmount(suffix[1]) : null
}

function isoDate(year: number, month: number, day: number) {
  const candidate = new Date(Date.UTC(year, month - 1, day, 12))
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null
  return candidate.toISOString().slice(0, 10)
}

function extractDueDate(text: string) {
  const numeric = text.match(/\b([0-3]?\d)[-/.]([01]?\d)[-/.](20\d{2})\b/)
  if (numeric?.[1] && numeric[2] && numeric[3]) return isoDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]))

  const monthNames = Object.keys(dutchMonths).join('|')
  const named = text.match(new RegExp(`\\b([0-3]?\\d)\\s+(${monthNames})\\s+(20\\d{2})\\b`, 'i'))
  if (named?.[1] && named[2] && named[3]) return isoDate(Number(named[3]), dutchMonths[lowerText(named[2])], Number(named[1]))
  return null
}

function daysUntil(date: string | null) {
  if (!date) return null
  const today = new Date()
  today.setUTCHours(12, 0, 0, 0)
  const target = new Date(`${date}T12:00:00.000Z`)
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000)
}

function classifyAuthority(domain: string, text: string) {
  const checks: Array<{ authority: string; tags: string[]; matches: string[] }> = [
    { authority: 'IND', tags: ['immigration', 'ind'], matches: ['ind.nl', 'immigratie', 'naturalisatie', 'kennismigrant', 'verblijfsvergunning', 'erkend referent'] },
    { authority: 'CJIB', tags: ['fine', 'cjib'], matches: ['cjib.nl', 'cjib', 'boete', 'bekeuring', 'verkeersboete'] },
    { authority: 'Belastingdienst', tags: ['tax'], matches: ['belastingdienst.nl', 'belastingdienst', 'aanslag', 'toeslag', 'inkomstenbelasting', 'btw'] },
    { authority: 'Gemeente Waterland', tags: ['municipality'], matches: ['waterland.nl', 'gemeente waterland', 'broek in waterland', 'gemeentebelasting'] },
    { authority: 'Rechtspraak', tags: ['court'], matches: ['rechtspraak.nl', 'rechtbank', 'zitting', 'uitspraak', 'beroep'] },
    { authority: 'Openbaar Ministerie', tags: ['justice'], matches: ['om.nl', 'openbaar ministerie', 'officier van justitie'] },
    { authority: 'Politie', tags: ['police'], matches: ['politie.nl', 'politie'] },
    { authority: 'UWV', tags: ['work', 'pregnancy'], matches: ['uwv.nl', 'zwangerschapsverlof', 'wazo', 'ziektewet'] },
    { authority: 'SVB', tags: ['family'], matches: ['svb.nl', 'kinderbijslag'] },
    { authority: 'MijnOverheid', tags: ['government'], matches: ['mijnoverheid.nl', 'berichtenbox', 'mijn overheid'] },
    { authority: 'DigiD', tags: ['digid'], matches: ['digid.nl', 'digid'] },
  ]
  for (const check of checks) {
    if (check.matches.some((match) => domain.endsWith(match) || text.includes(match))) return check
  }
  return { authority: domain ? domain : 'Bilinmeyen kaynak', tags: [] }
}

function classifyCategory(text: string, authority: string) {
  if (authority === 'CJIB' || /\b(boete|bekeuring|verkeersboete|sanctie)\b/i.test(text)) return 'fine'
  if (authority === 'Belastingdienst' || /\b(aanslag|belasting|toeslag|btw|inkomstenbelasting)\b/i.test(text)) return 'tax'
  if (/\b(zorgverzekering|premie|eigen risico|polis|kraamzorg)\b/i.test(text)) return 'insurance'
  if (/\b(factuur|betaling|betaal|incasso|te betalen|openstaand)\b/i.test(text)) return 'invoice'
  return 'other'
}

function classifyMessage(accountEmail: string, fromAddress: string | null, subject: string | null, snippet: string | null) {
  const raw = compactText(fromAddress, subject, snippet)
  const text = lowerText(raw)
  const domain = emailDomain(fromAddress)
  const authority = classifyAuthority(domain, text)
  const amount = extractAmount(raw)
  const dueDate = extractDueDate(raw)
  const category = classifyCategory(text, authority.authority)
  const hasDeadlineLanguage = /\b(uiterlijk|deadline|voor\s+\d|binnen|termijn|bezwaar|beroep|aanleveren|documenten)\b/i.test(raw)
  const hasPaymentLanguage = /\b(betalen|betaling|incasso|factuur|openstaand|te betalen|aanmaning)\b/i.test(raw)
  const legalTags = ['immigration', 'ind', 'fine', 'court', 'justice', 'police']
  const relevant = authority.tags.length > 0 || amount !== null || dueDate !== null || hasDeadlineLanguage || hasPaymentLanguage
  const urgent = authority.tags.some((tag) => legalTags.includes(tag)) || (daysUntil(dueDate) ?? 99) <= 7
  const severity = urgent ? 'critical' : relevant ? 'warning' : 'info'
  const tags = Array.from(new Set([...authority.tags, category].filter((tag) => tag !== 'other')))
  const title = subject?.trim() || `${authority.authority} bericht`

  return {
    amount,
    authority: authority.authority,
    category,
    classification: relevant ? tags.join(',') || category : 'general',
    dueDate,
    hasDeadlineLanguage,
    hasPaymentLanguage,
    notificationBody: compactText(
      `Bron: ${accountEmail}`,
      amount !== null ? `Bedrag: €${amount.toFixed(2)}` : null,
      dueDate ? `Datum: ${dueDate}` : null,
      snippet?.slice(0, 180),
    ),
    relevant,
    severity,
    tags,
    title,
  }
}

async function existingRow(admin: ReturnType<typeof adminClient>, table: 'notifications' | 'obligations' | 'deadlines', userId: string, sourceRef: string) {
  const { data, error } = await admin.from(table).select('id').eq('user_id', userId).eq('source_url', sourceRef).limit(1)
  if (error) throw new Error(`${table}_query_failed`)
  return (data ?? []).length > 0
}

async function persistTriage(admin: ReturnType<typeof adminClient>, account: { id: string; user_id: string; email: string }, sourceRef: string, triage: ReturnType<typeof classifyMessage>) {
  if (!triage.relevant) return
  if (!await existingRow(admin, 'notifications', account.user_id, sourceRef)) {
    const { error } = await admin.from('notifications').insert({
      body: triage.notificationBody,
      severity: triage.severity,
      source_url: sourceRef,
      title: triage.title,
      user_id: account.user_id,
    })
    if (error) throw new Error('notification_save_failed')
  }

  if ((triage.category !== 'other' || triage.amount !== null) && !await existingRow(admin, 'obligations', account.user_id, sourceRef)) {
    const { error } = await admin.from('obligations').insert({
      amount: triage.amount,
      authority: triage.authority,
      category: triage.category,
      due_date: triage.dueDate,
      evidence_level: 'review',
      note: `Gmail hesabı: ${account.email}. Resmi belge ve ödeme kanalı ayrıca doğrulanmalı.`,
      source_url: sourceRef,
      status: 'open',
      title: triage.title,
      user_id: account.user_id,
    })
    if (error) throw new Error('obligation_save_failed')
  }

  if ((triage.dueDate || triage.hasDeadlineLanguage) && triage.dueDate && !await existingRow(admin, 'deadlines', account.user_id, sourceRef)) {
    const { error } = await admin.from('deadlines').insert({
      due_at: `${triage.dueDate}T12:00:00.000Z`,
      evidence_level: 'review',
      owner: triage.authority,
      source_url: sourceRef,
      status: 'open',
      title: triage.title,
      user_id: account.user_id,
    })
    if (error) throw new Error('deadline_save_failed')
  }
}

function listPath(query?: string) {
  const params = new URLSearchParams({ maxResults: String(query ? officialMessageLimit : inboxMessageLimit) })
  if (query) params.set('q', query)
  else params.set('labelIds', 'INBOX')
  return `messages?${params.toString()}`
}

async function listMessages(accessToken: string, query?: string) {
  const list = await gmailJson(listPath(query), accessToken) as { messages?: Array<{ id: string; threadId?: string }> }
  return list.messages ?? []
}

async function queuedMessages(admin: ReturnType<typeof adminClient>, accountId: string) {
  const { data, error } = await admin
    .from('email_messages')
    .select('provider_message_id,thread_id')
    .eq('account_id', accountId)
    .eq('processing_status', 'queued')
    .limit(queuedMessageLimit)
  if (error) throw new Error('queued_messages_query_failed')
  return (data ?? []).map((item) => ({ id: item.provider_message_id, threadId: item.thread_id ?? undefined }))
}

async function syncMessage(admin: ReturnType<typeof adminClient>, account: { id: string; user_id: string; email: string }, accessToken: string, message: { id: string; threadId?: string }) {
  const detail = await gmailJson(`messages/${encodeURIComponent(message.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, accessToken) as { id?: string; threadId?: string; snippet?: string; internalDate?: string; labelIds?: string[]; payload?: { headers?: Array<{ name?: string; value?: string }> } }
  const providerMessageId = detail.id ?? message.id
  const fromAddress = header(detail.payload?.headers, 'From')
  const subject = header(detail.payload?.headers, 'Subject')
  const triage = classifyMessage(account.email, fromAddress, subject, detail.snippet ?? null)
  const sourceRef = `gmail://${account.id}/${providerMessageId}`
  const { data: saved, error } = await admin.from('email_messages').upsert({
    user_id: account.user_id,
    account_id: account.id,
    provider_message_id: providerMessageId,
    thread_id: detail.threadId ?? message.threadId ?? null,
    from_address: fromAddress,
    subject,
    received_at: detail.internalDate ? new Date(Number(detail.internalDate)).toISOString() : null,
    snippet: detail.snippet ?? null,
    label_ids: detail.labelIds ?? [],
    sensitivity: 'restricted',
    classification: triage.classification,
    extracted_data: {
      account_email: account.email,
      amount: triage.amount,
      authority: triage.authority,
      category: triage.category,
      due_date: triage.dueDate,
      source_ref: sourceRef,
      tags: triage.tags,
    },
    processing_status: triage.relevant ? 'review_required' : 'processed',
  }, { onConflict: 'account_id,provider_message_id' }).select('id')
  if (error) throw new Error('message_save_failed')
  const savedId = (saved ?? [])[0]?.id
  if (!savedId) return 0
  await persistTriage(admin, account, sourceRef, triage)
  return 1
}

async function syncAccount(admin: ReturnType<typeof adminClient>, account: { id: string; user_id: string; email: string }) {
  const { data: token } = await admin.from('email_tokens').select('refresh_token_ciphertext').eq('account_id', account.id).single()
  if (!token) throw new Error('token_missing')
  const accessToken = await refreshAccessToken(await decryptSecret(token.refresh_token_ciphertext, env('TOKEN_ENCRYPTION_KEY')))
  const messages = new Map<string, { id: string; threadId?: string }>()
  for (const message of await listMessages(accessToken)) messages.set(message.id, message)
  for (const message of await listMessages(accessToken, officialGmailQuery)) messages.set(message.id, message)
  for (const message of await queuedMessages(admin, account.id)) messages.set(message.id, message)
  let imported = 0

  for (const message of messages.values()) {
    imported += await syncMessage(admin, account, accessToken, message)
  }

  await admin.from('email_accounts').update({ status: 'connected', last_sync_at: new Date().toISOString(), last_error_code: null }).eq('id', account.id)
  return imported
}

async function syncAccountWithAudit(admin: ReturnType<typeof adminClient>, account: { id: string; user_id: string; email: string }) {
  try {
    const imported = await syncAccount(admin, account)
    await admin.from('audit_events').insert({ user_id: account.user_id, actor: 'worker', event_type: 'gmail_sync_completed', object_type: 'email_account', object_id: account.id, metadata: { imported } })
    return { accountId: account.id, imported, status: 'ok' }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'sync_failed'
    await admin.from('email_accounts').update({ status: code === 'refresh_token_rejected' ? 'reauth_required' : 'error', last_error_code: code }).eq('id', account.id)
    await admin.from('audit_events').insert({ user_id: account.user_id, actor: 'worker', event_type: 'gmail_sync_failed', object_type: 'email_account', object_id: account.id, metadata: { code } })
    return { accountId: account.id, imported: 0, status: 'failed' }
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
  if (!await workerAuthorized(request)) return json({ error: 'unauthorized' }, 401)
  const admin = adminClient()
  const { data: accounts, error } = await admin
    .from('email_accounts')
    .select('id,user_id,email')
    .eq('provider', 'gmail')
    .eq('status', 'connected')
    .order('last_sync_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(25)
  if (error) return json({ error: 'accounts_query_failed' }, 500)

  const results = await Promise.all((accounts ?? []).map((account) => syncAccountWithAudit(admin, account)))

  return json({ accounts: results, completedAt: new Date().toISOString() })
})
