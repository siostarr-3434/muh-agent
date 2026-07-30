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

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3) {
  let response: Response | null = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    response = await fetch(url, init)
    if (response.status !== 429 && response.status < 500) return response
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
  }
  return response!
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

async function workerAuthorized(request: Request) {
  const supplied = request.headers.get('x-worker-secret')
  if (!supplied) return false
  return await sha256Hex(supplied) === await sha256Hex(env('WORKER_CRON_SECRET'))
}

const driveFileLimit = 50
const driveInboxFolderName = 'Muh Agent Inbox'
const driveReadonlyScope = 'https://www.googleapis.com/auth/drive.readonly'
const driveMetadataQuery = [
  'trashed = false',
  'and',
  '(',
  "mimeType = 'application/pdf'",
  "or mimeType = 'application/vnd.google-apps.document'",
  "or mimeType = 'application/vnd.google-apps.spreadsheet'",
  "or mimeType = 'application/msword'",
  "or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'",
  "or mimeType = 'application/vnd.ms-excel'",
  "or mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'",
  "or mimeType = 'image/jpeg'",
  "or mimeType = 'image/png'",
  ')',
].join(' ')

type Admin = ReturnType<typeof adminClient>

interface DriveFile {
  id?: string
  mimeType?: string
  modifiedTime?: string
  name?: string
  size?: string
  webViewLink?: string
}

interface DriveFolder {
  id?: string
  name?: string
}

function compactText(...parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

function normalizeText(value: string) {
  return value.toLocaleLowerCase('nl-NL')
}

function safeWebUrl(value: string | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    if (!['drive.google.com', 'docs.google.com'].includes(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}

function parseSize(value: string | undefined) {
  if (!value) return null
  const size = Number(value)
  return Number.isSafeInteger(size) && size >= 0 ? size : null
}

function driveQueryString(value: string) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function classifyFile(file: DriveFile) {
  const raw = compactText(file.name, file.mimeType)
  const text = normalizeText(raw)
  const checks: Array<{ classification: string; authority: string; matches: string[] }> = [
    { authority: 'IND', classification: 'immigration', matches: ['ind', 'immigratie', 'naturalisatie', 'kennismigrant', 'verblijfsvergunning', 'residence', 'oturum'] },
    { authority: 'CJIB', classification: 'fine', matches: ['cjib', 'boete', 'bekeuring', 'verkeersboete', 'fine', 'ceza'] },
    { authority: 'Belastingdienst', classification: 'tax', matches: ['belastingdienst', 'belasting', 'aanslag', 'toeslag', 'btw', 'tax', 'vergi'] },
    { authority: 'Gemeente Waterland', classification: 'municipality', matches: ['waterland', 'gemeente', 'broek in waterland', 'municipality', 'belediye'] },
    { authority: 'Rechtspraak', classification: 'court', matches: ['rechtspraak', 'rechtbank', 'zitting', 'uitspraak', 'beroep', 'court', 'mahkeme'] },
    { authority: 'Politie', classification: 'police', matches: ['politie', 'police'] },
    { authority: 'UWV', classification: 'work_pregnancy', matches: ['uwv', 'zwangerschap', 'zwangerschapsverlof', 'wazo', 'pregnancy', 'hamile'] },
    { authority: 'SVB', classification: 'family', matches: ['svb', 'kinderbijslag', 'child benefit'] },
    { authority: 'Zorg', classification: 'health', matches: ['zorg', 'verzekering', 'kraamzorg', 'verloskundige', 'health', 'sigorta'] },
    { authority: 'DigiD / MijnOverheid', classification: 'government_portal', matches: ['digid', 'mijnoverheid', 'berichtenbox'] },
  ]
  const matched = checks.filter((check) => check.matches.some((match) => text.includes(match)))
  const tags = Array.from(new Set(matched.map((match) => match.classification)))
  const authorities = Array.from(new Set(matched.map((match) => match.authority)))
  return {
    authorities,
    classification: tags[0] ?? 'drive_document',
    relevant: tags.length > 0,
    tags,
  }
}

async function driveInboxFolders(accessToken: string) {
  const params = new URLSearchParams({
    fields: 'files(id,name)',
    includeItemsFromAllDrives: 'true',
    pageSize: '10',
    q: [
      'trashed = false',
      'and',
      "mimeType = 'application/vnd.google-apps.folder'",
      'and',
      `name = ${driveQueryString(driveInboxFolderName)}`,
    ].join(' '),
    supportsAllDrives: 'true',
  })
  const response = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error(`drive_folder_query_failed_${response.status}`)
  const payload = await response.json() as { files?: DriveFolder[] }
  return (payload.files ?? []).filter((folder) => folder.id).map((folder) => folder.id!)
}

async function driveFiles(accessToken: string, folderIds: string[]) {
  if (folderIds.length === 0) return []
  const parentQuery = folderIds.map((folderId) => `${driveQueryString(folderId)} in parents`).join(' or ')
  const params = new URLSearchParams({
    fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
    includeItemsFromAllDrives: 'true',
    orderBy: 'modifiedTime desc',
    pageSize: String(driveFileLimit),
    q: `(${parentQuery}) and ${driveMetadataQuery}`,
    supportsAllDrives: 'true',
  })
  const response = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error(`drive_api_failed_${response.status}`)
  const payload = await response.json() as { files?: DriveFile[] }
  return payload.files ?? []
}

async function syncFile(admin: Admin, account: { email: string; id: string; user_id: string }, file: DriveFile) {
  if (!file.id || !file.name || !file.mimeType) return 0
  const sourceRef = `drive://${account.id}/${file.id}`
  const triage = classifyFile(file)
  const now = new Date().toISOString()
  const { error } = await admin.from('provider_files').upsert({
    account_id: account.id,
    classification: triage.classification,
    extracted_data: {
      account_email: account.email,
      authorities: triage.authorities,
      source_ref: sourceRef,
      tags: triage.tags,
    },
    last_seen_at: now,
    mime_type: file.mimeType,
    modified_at: file.modifiedTime ?? null,
    name: file.name,
    provider: 'drive',
    provider_file_id: file.id,
    sensitivity: 'restricted',
    size_bytes: parseSize(file.size),
    source_ref: sourceRef,
    status: triage.relevant ? 'review_required' : 'metadata',
    user_id: account.user_id,
    web_url: safeWebUrl(file.webViewLink),
  }, { onConflict: 'account_id,provider_file_id' })
  if (error) throw new Error('drive_file_save_failed')
  return 1
}

async function syncAccount(admin: Admin, account: { email: string; id: string; scopes: string[]; user_id: string }) {
  if (!account.scopes.includes(driveReadonlyScope)) return { imported: 0, skipped: 'drive_scope_missing' }
  const { data: token } = await admin.from('email_tokens').select('refresh_token_ciphertext').eq('account_id', account.id).single()
  if (!token) throw new Error('token_missing')
  const accessToken = await refreshAccessToken(await decryptSecret(token.refresh_token_ciphertext, env('TOKEN_ENCRYPTION_KEY')))
  const folderIds = await driveInboxFolders(accessToken)
  if (folderIds.length === 0) return { imported: 0, skipped: 'drive_inbox_folder_missing' }
  let imported = 0
  for (const file of await driveFiles(accessToken, folderIds)) {
    imported += await syncFile(admin, account, file)
  }
  await admin.from('email_accounts').update({ last_error_code: null, status: 'connected' }).eq('id', account.id)
  return { imported, skipped: null }
}

async function syncAccountWithAudit(admin: Admin, account: { email: string; id: string; scopes: string[]; user_id: string }) {
  try {
    const result = await syncAccount(admin, account)
    await admin.from('audit_events').insert({ user_id: account.user_id, actor: 'worker', event_type: 'drive_sync_completed', object_type: 'email_account', object_id: account.id, metadata: result })
    return { accountId: account.id, imported: result.imported, skipped: result.skipped, status: 'ok' }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'drive_sync_failed'
    await admin.from('email_accounts').update({
      last_error_code: code,
      status: code === 'refresh_token_rejected' ? 'reauth_required' : 'connected',
    }).eq('id', account.id)
    await admin.from('audit_events').insert({ user_id: account.user_id, actor: 'worker', event_type: 'drive_sync_failed', object_type: 'email_account', object_id: account.id, metadata: { code } })
    return { accountId: account.id, imported: 0, skipped: null, status: 'failed' }
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
  if (!await workerAuthorized(request)) return json({ error: 'unauthorized' }, 401)

  const admin = adminClient()
  const { data: accounts, error } = await admin
    .from('email_accounts')
    .select('id,user_id,email,scopes')
    .eq('provider', 'gmail')
    .eq('status', 'connected')
    .order('created_at', { ascending: true })
    .limit(25)
  if (error) return json({ error: 'accounts_query_failed' }, 500)

  const driveAccounts = (accounts ?? []).filter((account) => account.scopes.includes(driveReadonlyScope))
  const results = await Promise.all(driveAccounts.map((account) => syncAccountWithAudit(admin, account)))

  return json({ accounts: results, completedAt: new Date().toISOString() })
})
