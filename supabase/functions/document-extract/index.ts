import { createClient } from 'npm:@supabase/supabase-js@2'
import { decryptSecret, sha256Hex } from '../_shared/crypto.ts'
import { json } from '../_shared/http.ts'

const driveReadonlyScope = 'https://www.googleapis.com/auth/drive.readonly'
const maxFilesPerRun = 8
const maxFileBytes = 10_485_760
const openAiModel = Deno.env.get('OPENAI_DOCUMENT_MODEL') || 'gpt-4.1-mini'
const supportedMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
])

type Admin = ReturnType<typeof adminClient>

interface ProviderFile {
  account_id: string
  document_id: string | null
  extracted_data: Record<string, unknown>
  extraction_attempts: number
  id: string
  mime_type: string
  name: string
  provider_file_id: string
  size_bytes: number | null
  source_ref: string
  user_id: string
  web_url: string | null
}

interface Extraction {
  action_required: boolean
  action_summary_tr: string | null
  amount_eur: number | null
  authority: string
  confidence: number
  currency: 'EUR' | null
  document_date: string | null
  document_type: 'fine' | 'tax' | 'invoice' | 'immigration' | 'court' | 'municipality' | 'health' | 'insurance' | 'benefit' | 'other'
  due_date: string | null
  is_relevant: boolean
  objection_deadline: string | null
  payment_required: boolean
  reference_hint: string | null
  risk: 'critical' | 'warning' | 'info'
  sensitive_data_seen: boolean
  summary_tr: string
  title: string
}

function env(name: string) {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function adminClient() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
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
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), grant_type: 'refresh_token' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  })
  if (!response.ok) throw new Error('refresh_token_rejected')
  const payload = await response.json() as { access_token?: string }
  if (!payload.access_token) throw new Error('access_token_missing')
  return payload.access_token
}

async function workerAuthorized(request: Request) {
  const supplied = request.headers.get('x-worker-secret')
  if (!supplied) return false
  return await sha256Hex(supplied) === await sha256Hex(env('WORKER_CRON_SECRET'))
}

function bearerToken(request: Request) {
  const header = request.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

async function authorizationScope(request: Request, admin: Admin) {
  if (await workerAuthorized(request)) return { mode: 'worker' as const, userId: null }
  const token = bearerToken(request)
  if (!token) return null
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) return null
  return { mode: 'user' as const, userId: data.user.id }
}

async function openAiKey(admin: Admin) {
  const fromEnv = Deno.env.get('OPENAI_API_KEY')
  if (fromEnv) return fromEnv
  const { data } = await admin
    .schema('vault')
    .from('decrypted_secrets')
    .select('decrypted_secret')
    .eq('name', 'openai_api_key')
    .maybeSingle()
  const fromVault = typeof data?.decrypted_secret === 'string' ? data.decrypted_secret.trim() : ''
  if (fromVault) return fromVault
  throw new Error('openai_api_key_missing')
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

async function sha256Bytes(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function exportedMimeType(mimeType: string) {
  if (mimeType === 'application/vnd.google-apps.document') return 'application/pdf'
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'application/pdf'
  return mimeType
}

function downloadUrl(file: ProviderFile) {
  const fileId = encodeURIComponent(file.provider_file_id)
  if (file.mime_type === 'application/vnd.google-apps.document' || file.mime_type === 'application/vnd.google-apps.spreadsheet') {
    return `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportedMimeType(file.mime_type))}`
  }
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
}

async function downloadDriveFile(file: ProviderFile, accessToken: string) {
  const response = await fetchWithRetry(downloadUrl(file), {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`drive_download_failed_${response.status}`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength <= 0) throw new Error('empty_file')
  if (buffer.byteLength > maxFileBytes) throw new Error('file_too_large')
  return { buffer, mimeType: exportedMimeType(file.mime_type), sizeBytes: buffer.byteLength }
}

async function accessTokenForFile(admin: Admin, file: ProviderFile) {
  const { data: account, error: accountError } = await admin
    .from('email_accounts')
    .select('id,email,scopes,status')
    .eq('id', file.account_id)
    .eq('user_id', file.user_id)
    .single()
  if (accountError || !account) throw new Error('account_not_found')
  if (account.status !== 'connected') throw new Error('account_not_connected')
  if (!Array.isArray(account.scopes) || !account.scopes.includes(driveReadonlyScope)) throw new Error('drive_scope_missing')
  const { data: token, error: tokenError } = await admin
    .from('email_tokens')
    .select('refresh_token_ciphertext')
    .eq('account_id', file.account_id)
    .single()
  if (tokenError || !token) throw new Error('token_missing')
  return {
    accessToken: await refreshAccessToken(await decryptSecret(token.refresh_token_ciphertext, env('TOKEN_ENCRYPTION_KEY'))),
    accountEmail: account.email as string,
  }
}

function extractionSchema() {
  return {
    additionalProperties: false,
    properties: {
      action_required: { type: 'boolean' },
      action_summary_tr: { type: ['string', 'null'] },
      amount_eur: { type: ['number', 'null'] },
      authority: { type: 'string' },
      confidence: { type: 'number' },
      currency: { enum: ['EUR', null] },
      document_date: { type: ['string', 'null'] },
      document_type: { enum: ['fine', 'tax', 'invoice', 'immigration', 'court', 'municipality', 'health', 'insurance', 'benefit', 'other'] },
      due_date: { type: ['string', 'null'] },
      is_relevant: { type: 'boolean' },
      objection_deadline: { type: ['string', 'null'] },
      payment_required: { type: 'boolean' },
      reference_hint: { type: ['string', 'null'] },
      risk: { enum: ['critical', 'warning', 'info'] },
      sensitive_data_seen: { type: 'boolean' },
      summary_tr: { type: 'string' },
      title: { type: 'string' },
    },
    required: [
      'action_required',
      'action_summary_tr',
      'amount_eur',
      'authority',
      'confidence',
      'currency',
      'document_date',
      'document_type',
      'due_date',
      'is_relevant',
      'objection_deadline',
      'payment_required',
      'reference_hint',
      'risk',
      'sensitive_data_seen',
      'summary_tr',
      'title',
    ],
    type: 'object',
  }
}

function responseOutputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === 'string') return payload.output_text
  const output = Array.isArray(payload.output) ? payload.output : []
  const chunks: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') chunks.push(text)
    }
  }
  return chunks.join('\n')
}

function normalizeExtraction(value: unknown): Extraction {
  if (!value || typeof value !== 'object') throw new Error('invalid_extraction_payload')
  const item = value as Partial<Extraction>
  const type = ['fine', 'tax', 'invoice', 'immigration', 'court', 'municipality', 'health', 'insurance', 'benefit', 'other'].includes(String(item.document_type)) ? item.document_type! : 'other'
  const risk = item.risk === 'critical' || item.risk === 'warning' ? item.risk : 'info'
  const amount = typeof item.amount_eur === 'number' && Number.isFinite(item.amount_eur) && item.amount_eur >= 0 ? Number(item.amount_eur.toFixed(2)) : null
  const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0
  return {
    action_required: item.action_required === true,
    action_summary_tr: typeof item.action_summary_tr === 'string' ? item.action_summary_tr.slice(0, 1_000) : null,
    amount_eur: amount,
    authority: typeof item.authority === 'string' && item.authority.trim() ? item.authority.trim().slice(0, 160) : 'Bilinmeyen kurum',
    confidence,
    currency: amount === null ? null : 'EUR',
    document_date: typeof item.document_date === 'string' ? item.document_date.slice(0, 32) : null,
    document_type: type,
    due_date: typeof item.due_date === 'string' ? item.due_date.slice(0, 32) : null,
    is_relevant: item.is_relevant === true,
    objection_deadline: typeof item.objection_deadline === 'string' ? item.objection_deadline.slice(0, 32) : null,
    payment_required: item.payment_required === true || amount !== null,
    reference_hint: typeof item.reference_hint === 'string' ? item.reference_hint.slice(0, 160) : null,
    risk,
    sensitive_data_seen: item.sensitive_data_seen === true,
    summary_tr: typeof item.summary_tr === 'string' && item.summary_tr.trim() ? item.summary_tr.trim().slice(0, 2_000) : 'Belge okundu; kısa özet çıkarılamadı.',
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 220) : 'Okunan belge',
  }
}

async function extractWithOpenAi(apiKey: string, file: ProviderFile, filePayload: { buffer: ArrayBuffer; mimeType: string }) {
  const base64 = arrayBufferToBase64(filePayload.buffer)
  const dataUrl = `data:${filePayload.mimeType};base64,${base64}`
  const content: Array<Record<string, unknown>> = [
    {
      text: [
        'Bu belge Hollanda’da yaşayan bir expat için gelen resmi/finansal evrak olabilir.',
        'Belgeyi OCR ile oku ve yalnızca JSON çıkar.',
        'Amaç: borç/ceza/vergi/IND/belediye/mahkeme/sağlık yazısını sınıflandırmak; tutar, son ödeme, itiraz veya belge teslim süresini bulmak.',
        'BSN, tam IBAN, tam dosya numarası veya kimlik numarasını döndürme. Gerekirse sadece son 4 karakteri reference_hint içinde maskele.',
        'Emin olmadığın alanlara null yaz. Tahmin etme.',
        `Dosya adı: ${file.name}`,
        `MIME: ${file.mime_type}`,
      ].join('\n'),
      type: 'input_text',
    },
  ]
  if (filePayload.mimeType.startsWith('image/')) {
    content.push({ image_url: dataUrl, type: 'input_image' })
  } else {
    content.push({ file_data: dataUrl, filename: file.name, type: 'input_file' })
  }

  const response = await fetchWithRetry('https://api.openai.com/v1/responses', {
    body: JSON.stringify({
      input: [{ content, role: 'user' }],
      max_output_tokens: 1800,
      model: openAiModel,
      text: {
        format: {
          name: 'dutch_expat_document_extraction',
          schema: extractionSchema(),
          strict: true,
          type: 'json_schema',
        },
      },
    }),
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`openai_extract_failed_${response.status}`)
  const payload = await response.json() as Record<string, unknown>
  const text = responseOutputText(payload)
  if (!text) throw new Error('openai_empty_output')
  return normalizeExtraction(JSON.parse(text))
}

function obligationCategory(type: Extraction['document_type']) {
  if (type === 'fine') return 'fine'
  if (type === 'tax') return 'tax'
  if (type === 'insurance' || type === 'health') return 'insurance'
  if (type === 'invoice' || type === 'municipality') return 'invoice'
  return 'other'
}

async function existingBySource(admin: Admin, table: 'deadlines' | 'notifications' | 'obligations', userId: string, sourceUrl: string) {
  const { data, error } = await admin.from(table).select('id').eq('user_id', userId).eq('source_url', sourceUrl).limit(1)
  if (error) throw new Error(`${table}_query_failed`)
  return (data ?? []).length > 0
}

async function persistObligation(admin: Admin, file: ProviderFile, documentId: string, extraction: Extraction) {
  if (!extraction.is_relevant && extraction.amount_eur === null && !extraction.payment_required) return
  if (await existingBySource(admin, 'obligations', file.user_id, file.source_ref)) return
  const { error } = await admin.from('obligations').insert({
    amount: extraction.amount_eur,
    authority: extraction.authority,
    category: obligationCategory(extraction.document_type),
    currency: 'EUR',
    document_id: documentId,
    due_date: extraction.due_date,
    evidence_level: extraction.confidence >= 0.82 ? 'verified' : 'review',
    note: [
      extraction.summary_tr,
      extraction.action_summary_tr ? `Aksiyon: ${extraction.action_summary_tr}` : null,
      extraction.reference_hint ? `Referans: ${extraction.reference_hint}` : null,
      'Ödeme veya itiraz öncesi resmi kanal ayrıca doğrulanmalı.',
    ].filter(Boolean).join(' '),
    source_url: file.source_ref,
    status: 'open',
    title: extraction.title,
    user_id: file.user_id,
  })
  if (error) throw new Error('obligation_save_failed')
}

async function persistDeadline(admin: Admin, file: ProviderFile, extraction: Extraction, kind: 'due' | 'objection', date: string | null) {
  if (!date) return
  const sourceUrl = `${file.source_ref}#${kind}`
  if (await existingBySource(admin, 'deadlines', file.user_id, sourceUrl)) return
  const { error } = await admin.from('deadlines').insert({
    due_at: `${date}T12:00:00.000Z`,
    evidence_level: extraction.confidence >= 0.82 ? 'verified' : 'review',
    owner: extraction.authority,
    source_url: sourceUrl,
    status: 'open',
    title: kind === 'objection' ? `${extraction.title} — itiraz/bezwaar süresi` : `${extraction.title} — son tarih`,
    user_id: file.user_id,
  })
  if (error) throw new Error('deadline_save_failed')
}

async function persistNotification(admin: Admin, file: ProviderFile, extraction: Extraction) {
  if (!extraction.is_relevant && !extraction.action_required && !extraction.payment_required) return
  if (await existingBySource(admin, 'notifications', file.user_id, file.source_ref)) return
  const pieces = [
    extraction.summary_tr,
    extraction.amount_eur !== null ? `Tutar: €${extraction.amount_eur.toFixed(2)}.` : null,
    extraction.due_date ? `Son tarih: ${extraction.due_date}.` : null,
    extraction.objection_deadline ? `İtiraz/bezwaar: ${extraction.objection_deadline}.` : null,
    extraction.action_summary_tr,
  ].filter(Boolean)
  const { error } = await admin.from('notifications').insert({
    body: pieces.join(' '),
    severity: extraction.risk,
    source_url: file.source_ref,
    title: `${extraction.authority}: ${extraction.title}`,
    user_id: file.user_id,
  })
  if (error) throw new Error('notification_save_failed')
}

async function persistExtraction(admin: Admin, file: ProviderFile, accountEmail: string, filePayload: { buffer: ArrayBuffer; mimeType: string; sizeBytes: number }, extraction: Extraction) {
  const sha = await sha256Bytes(filePayload.buffer)
  const sourceRef = file.source_ref
  const documentPayload = {
    classification: extraction.document_type,
    confidence: extraction.confidence,
    extracted_data: {
      account_email: accountEmail,
      extraction,
      provider_file_id: file.provider_file_id,
      source_ref: sourceRef,
      web_url: file.web_url,
    },
    filename: file.name,
    mime_type: filePayload.mimeType,
    sensitivity: extraction.sensitive_data_seen ? 'highly_restricted' : 'restricted',
    sha256: sha,
    size_bytes: filePayload.sizeBytes,
    source_ref: sourceRef,
    source_type: 'drive',
    status: extraction.is_relevant ? 'review_required' : 'processed',
    storage_path: sourceRef,
    user_id: file.user_id,
  }
  const { data: documentRows, error: documentError } = await admin
    .from('documents')
    .upsert(documentPayload, { onConflict: 'user_id,sha256' })
    .select('id')
  if (documentError) throw new Error('document_save_failed')
  const documentId = (documentRows ?? [])[0]?.id
  if (!documentId) throw new Error('document_id_missing')

  const { error: fileError } = await admin
    .from('provider_files')
    .update({
      classification: extraction.document_type,
      document_id: documentId,
      extracted_at: new Date().toISOString(),
      extracted_data: {
        ...file.extracted_data,
        account_email: accountEmail,
        extraction,
        source_ref: sourceRef,
      },
      extraction_error_code: null,
      extraction_status: extraction.is_relevant ? 'extracted' : 'skipped',
      status: extraction.is_relevant ? 'review_required' : 'metadata',
    })
    .eq('id', file.id)
  if (fileError) throw new Error('provider_file_update_failed')

  await persistObligation(admin, file, documentId, extraction)
  await persistDeadline(admin, file, extraction, 'due', extraction.due_date)
  await persistDeadline(admin, file, extraction, 'objection', extraction.objection_deadline)
  await persistNotification(admin, file, extraction)
  await admin.from('audit_events').insert({
    actor: 'worker',
    event_type: 'document_extract_completed',
    metadata: { authority: extraction.authority, document_type: extraction.document_type, risk: extraction.risk },
    object_id: file.id,
    object_type: 'provider_file',
    user_id: file.user_id,
  })
  return documentId
}

async function markProcessing(admin: Admin, file: ProviderFile) {
  const { error } = await admin
    .from('provider_files')
    .update({
      extraction_attempts: file.extraction_attempts + 1,
      extraction_error_code: null,
      extraction_status: 'processing',
    })
    .eq('id', file.id)
    .in('extraction_status', ['pending', 'failed'])
  if (error) throw new Error('provider_file_lease_failed')
}

async function markFailed(admin: Admin, file: ProviderFile, code: string) {
  await admin
    .from('provider_files')
    .update({
      extraction_error_code: code.slice(0, 120),
      extraction_status: 'failed',
      status: 'failed',
    })
    .eq('id', file.id)
  await admin.from('audit_events').insert({
    actor: 'worker',
    event_type: 'document_extract_failed',
    metadata: { code: code.slice(0, 120), name: file.name },
    object_id: file.id,
    object_type: 'provider_file',
    user_id: file.user_id,
  })
}

async function candidateFiles(admin: Admin, userId: string | null, limit: number) {
  let query = admin
    .from('provider_files')
    .select('id,user_id,account_id,provider_file_id,name,mime_type,size_bytes,source_ref,web_url,extracted_data,extraction_attempts,document_id')
    .eq('provider', 'drive')
    .in('mime_type', Array.from(supportedMimeTypes))
    .in('extraction_status', ['pending', 'failed'])
    .lt('extraction_attempts', 3)
    .order('modified_at', { ascending: false, nullsFirst: false })
    .limit(limit)
  if (userId) query = query.eq('user_id', userId)
  const { data, error } = await query
  if (error) throw new Error('provider_files_query_failed')
  return (data ?? []) as ProviderFile[]
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })

  const admin = adminClient()
  const scope = await authorizationScope(request, admin)
  if (!scope) return json({ error: 'unauthorized' }, 401)

  const body = await request.json().catch(() => ({})) as { limit?: unknown }
  const requestedLimit = typeof body.limit === 'number' && Number.isInteger(body.limit) ? body.limit : maxFilesPerRun
  const limit = Math.max(1, Math.min(maxFilesPerRun, requestedLimit))

  let apiKey: string
  try {
    apiKey = await openAiKey(admin)
  } catch {
    return json({ error: 'ocr_not_configured' }, 503)
  }

  const files = await candidateFiles(admin, scope.userId, limit)
  const results: Array<{ documentId?: string; error?: string; fileId: string; status: string }> = []

  for (const file of files) {
    try {
      await markProcessing(admin, file)
      const { accessToken, accountEmail } = await accessTokenForFile(admin, file)
      const filePayload = await downloadDriveFile(file, accessToken)
      const extraction = await extractWithOpenAi(apiKey, file, filePayload)
      const documentId = await persistExtraction(admin, file, accountEmail, filePayload, extraction)
      results.push({ documentId, fileId: file.id, status: 'ok' })
    } catch (error) {
      const code = error instanceof Error ? error.message : 'document_extract_failed'
      await markFailed(admin, file, code)
      results.push({ error: code.slice(0, 120), fileId: file.id, status: 'failed' })
    }
  }

  return json({ completedAt: new Date().toISOString(), files: results })
})
