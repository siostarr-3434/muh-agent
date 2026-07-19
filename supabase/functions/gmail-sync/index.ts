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

async function syncAccount(admin: ReturnType<typeof adminClient>, account: { id: string; user_id: string; email: string }) {
  const { data: token } = await admin.from('email_tokens').select('refresh_token_ciphertext').eq('account_id', account.id).single()
  if (!token) throw new Error('token_missing')
  const accessToken = await refreshAccessToken(await decryptSecret(token.refresh_token_ciphertext, env('TOKEN_ENCRYPTION_KEY')))
  const list = await gmailJson('messages?labelIds=INBOX&maxResults=50', accessToken) as { messages?: Array<{ id: string; threadId?: string }> }
  let imported = 0

  for (const message of list.messages ?? []) {
    const detail = await gmailJson(`messages/${encodeURIComponent(message.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, accessToken) as { id?: string; threadId?: string; snippet?: string; internalDate?: string; labelIds?: string[]; payload?: { headers?: Array<{ name?: string; value?: string }> } }
    const { data: saved, error } = await admin.from('email_messages').upsert({
      user_id: account.user_id,
      account_id: account.id,
      provider_message_id: detail.id ?? message.id,
      thread_id: detail.threadId ?? message.threadId ?? null,
      from_address: header(detail.payload?.headers, 'From'),
      subject: header(detail.payload?.headers, 'Subject'),
      received_at: detail.internalDate ? new Date(Number(detail.internalDate)).toISOString() : null,
      snippet: detail.snippet ?? null,
      label_ids: detail.labelIds ?? [],
      sensitivity: 'restricted',
      processing_status: 'queued',
    }, { onConflict: 'account_id,provider_message_id', ignoreDuplicates: true }).select('id')
    if (error) throw new Error('message_save_failed')
    if ((saved ?? []).length > 0) imported += 1
  }

  await admin.from('email_accounts').update({ status: 'connected', last_sync_at: new Date().toISOString(), last_error_code: null }).eq('id', account.id)
  return imported
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
  if (!await workerAuthorized(request)) return json({ error: 'unauthorized' }, 401)
  const admin = adminClient()
  const { data: accounts, error } = await admin.from('email_accounts').select('id,user_id,email').eq('provider', 'gmail').eq('status', 'connected').limit(25)
  if (error) return json({ error: 'accounts_query_failed' }, 500)

  const results: Array<{ accountId: string; imported: number; status: string }> = []
  for (const account of accounts ?? []) {
    try {
      const imported = await syncAccount(admin, account)
      await admin.from('audit_events').insert({ user_id: account.user_id, actor: 'worker', event_type: 'gmail_sync_completed', object_type: 'email_account', object_id: account.id, metadata: { imported } })
      results.push({ accountId: account.id, imported, status: 'ok' })
    } catch (error) {
      const code = error instanceof Error ? error.message : 'sync_failed'
      await admin.from('email_accounts').update({ status: code === 'refresh_token_rejected' ? 'reauth_required' : 'error', last_error_code: code }).eq('id', account.id)
      await admin.from('audit_events').insert({ user_id: account.user_id, actor: 'worker', event_type: 'gmail_sync_failed', object_type: 'email_account', object_id: account.id, metadata: { code } })
      results.push({ accountId: account.id, imported: 0, status: 'failed' })
    }
  }

  return json({ accounts: results, completedAt: new Date().toISOString() })
})
