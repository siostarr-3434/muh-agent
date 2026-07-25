import { createClient } from 'npm:@supabase/supabase-js@2'
import { sha256Hex } from '../_shared/crypto.ts'
import { json } from '../_shared/http.ts'

const FETCH_TIMEOUT_MS = 6_000
const FETCH_BATCH_SIZE = 10
const MAX_TARGETS_PER_RUN = 120

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

function safeWatchUrl(value: string, domain: string) {
  try {
    const url = new URL(value)
    const normalizedDomain = domain.trim().toLowerCase()
    const hostname = url.hostname.toLowerCase()
    if (url.protocol !== 'https:') return null
    if (hostname !== normalizedDomain && !hostname.endsWith(`.${normalizedDomain}`)) return null
    return url.toString()
  } catch {
    return null
  }
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
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`http_${response.status}`)
  const text = await response.text()
  return {
    hash: await sha256Hex(text.slice(0, 1_000_000)),
    title: extractTitle(text),
  }
}

async function refreshTarget(admin: ReturnType<typeof adminClient>, target: { sourceId: string; url: string }) {
  try {
    const fetched = await fetchOfficial(target.url)
    const { error: insertError } = await admin.from('source_snapshots').upsert({
      content_ref: null,
      content_sha256: fetched.hash,
      source_id: target.sourceId,
      title: fetched.title,
      url: target.url,
    }, { onConflict: 'url,content_sha256', ignoreDuplicates: true })
    if (insertError) throw new Error('snapshot_save_failed')
    return { sourceId: target.sourceId, status: 'ok', url: target.url }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'fetch_failed'
    return { sourceId: target.sourceId, status: code.slice(0, 80), url: target.url }
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
    .in('trust', ['official', 'secondary'])
    .order('id', { ascending: true })
    .limit(80)
  if (error) return json({ error: 'sources_query_failed' }, 500)

  const sourcesById = new Map((sources ?? []).map((source) => [source.id, source]))
  const { data: watchPages, error: pagesError } = await admin
    .from('source_watch_pages')
    .select('source_id,url')
    .eq('enabled', true)
    .limit(120)
  if (pagesError && pagesError.code !== '42P01') return json({ error: 'watch_pages_query_failed' }, 500)

  const targets = new Map<string, { sourceId: string; url: string }>()
  for (const page of watchPages ?? []) {
    const source = sourcesById.get(page.source_id)
    if (!source) continue
    const url = safeWatchUrl(page.url, source.domain)
    if (url) targets.set(url, { sourceId: source.id, url })
  }
  for (const source of sources ?? []) {
    const url = safeOfficialUrl(source.domain)
    if (url) targets.set(url, { sourceId: source.id, url })
  }

  const results: Array<{ sourceId: string; status: string; url: string }> = []
  const targetList = Array.from(targets.values()).slice(0, MAX_TARGETS_PER_RUN)
  for (let index = 0; index < targetList.length; index += FETCH_BATCH_SIZE) {
    const batch = targetList.slice(index, index + FETCH_BATCH_SIZE)
    results.push(...await Promise.all(batch.map((target) => refreshTarget(admin, target))))
  }

  return json({ completedAt: new Date().toISOString(), sources: results })
})
