const baseHeaders = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
}

export function allowedOrigin(request: Request) {
  const configured = Deno.env.get('PUBLIC_APP_ORIGIN')
  const origin = request.headers.get('origin')
  if (!configured || !origin || origin !== configured) return null
  return origin
}

export function corsHeaders(request: Request) {
  const origin = allowedOrigin(request)
  if (!origin) return null
  return {
    'access-control-allow-headers': 'authorization, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-origin': origin,
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

export function json(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...baseHeaders, ...extraHeaders } })
}
