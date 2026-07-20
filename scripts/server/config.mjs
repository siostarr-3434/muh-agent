const localOrigins = new Set(['localhost', '127.0.0.1', '::1'])

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function parseOrigin(value, name) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute http(s) origin`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.replace(/\/$/, '')) {
    throw new Error(`${name} must contain only scheme, host, and optional port`)
  }
  return url.origin
}

export function loadRuntimeConfig(environment = process.env) {
  const port = Number(environment.PORT ?? environment.MUH_AGENT_PORT ?? 5173)
  const host = clean(environment.MUH_AGENT_HOST) || '127.0.0.1'
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT or MUH_AGENT_PORT must be a valid TCP port')

  const supabaseUrl = clean(environment.SUPABASE_URL)
  const supabasePublishableKey = clean(environment.SUPABASE_PUBLISHABLE_KEY)
  if (Boolean(supabaseUrl) !== Boolean(supabasePublishableKey)) {
    throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be configured together')
  }

  const live = Boolean(supabaseUrl)
  if (live) {
    const parsedSupabaseUrl = new URL(supabaseUrl)
    if (parsedSupabaseUrl.protocol !== 'https:' || !parsedSupabaseUrl.hostname.endsWith('.supabase.co')) {
      throw new Error('SUPABASE_URL must be an https://*.supabase.co URL')
    }
    if (!supabasePublishableKey.startsWith('sb_publishable_') && !supabasePublishableKey.startsWith('eyJ')) {
      throw new Error('SUPABASE_PUBLISHABLE_KEY has an unexpected format')
    }
  }

  const configuredOrigin = clean(environment.APP_ORIGIN)
  if (live && !configuredOrigin) throw new Error('APP_ORIGIN is required when Supabase is configured')
  const appOrigin = parseOrigin(configuredOrigin || `http://${host}:${port}`, 'APP_ORIGIN')
  const appUrl = new URL(appOrigin)
  if (live && appUrl.protocol !== 'https:' && !localOrigins.has(appUrl.hostname)) {
    throw new Error('APP_ORIGIN must use HTTPS outside local development')
  }

  return Object.freeze({
    appOrigin,
    cookieSecure: appUrl.protocol === 'https:',
    host,
    live,
    port,
    supabasePublishableKey,
    supabaseUrl,
  })
}
