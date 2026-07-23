import { createClient } from 'npm:@supabase/supabase-js@2'
import { sha256Hex } from '../_shared/crypto.ts'
import { json } from '../_shared/http.ts'

function env(name: string) {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function adminClient() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
}

async function workerAuthorized(request: Request) {
  const supplied = request.headers.get('x-worker-secret')
  if (!supplied) return false
  return await sha256Hex(supplied) === await sha256Hex(env('WORKER_CRON_SECRET'))
}

function safeOfficialUrl(domain: string) {
  const normalized = domain.trim().toLowerCase()
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) return null
  return `https://${normalized}/`
}

function extractTitle(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  return title?.replace(/\s+/g, ' ').trim().slice(0, 240) || null
}

async function fetchOfficial(url: string) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'MuhAgent/0.1 official-source-monitor',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`http_${response.status}`)
  const text = await response.text()
  return {
    hash: await sha256Hex(text.slice(0, 1_000_000)),
    title: extractTitle(text),
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
  if (!await workerAuthorized(request)) return json({ error: 'unauthorized' }, 401)

  const admin = adminClient()
  const { data: sources, error } = await admin
    .from('source_catalog')
    .select('id,domain')
    .eq('enabled_by_default', true)
    .eq('trust', 'official')
    .order('id', { ascending: true })
    .limit(30)
  if (error) return json({ error: 'sources_query_failed' }, 500)

  const results: Array<{ sourceId: string; status: string }> = []
  for (const source of sources ?? []) {
    const url = safeOfficialUrl(source.domain)
    if (!url) {
      results.push({ sourceId: source.id, status: 'invalid_domain' })
      continue
    }

    try {
      const fetched = await fetchOfficial(url)
      const { error: insertError } = await admin.from('source_snapshots').upsert({
        content_ref: null,
        content_sha256: fetched.hash,
        source_id: source.id,
        title: fetched.title,
        url,
      }, { onConflict: 'url,content_sha256', ignoreDuplicates: true })
      if (insertError) throw new Error('snapshot_save_failed')
      results.push({ sourceId: source.id, status: 'ok' })
    } catch (error) {
      const code = error instanceof Error ? error.message : 'fetch_failed'
      results.push({ sourceId: source.id, status: code.slice(0, 80) })
    }
  }

  return json({ completedAt: new Date().toISOString(), sources: results })
})
