export const securityHeaders = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
})

export function createResponseState() {
  return { cookies: new Map(), headers: {} }
}

function responseHeaders(state, extra = {}) {
  const headers = {
    ...securityHeaders,
    'Cache-Control': 'private, no-store, max-age=0',
    ...state?.headers,
    ...extra,
  }
  if (state?.cookies.size) headers['Set-Cookie'] = [...state.cookies.values()]
  return headers
}

export function writeJson(response, status, payload, state, extraHeaders = {}) {
  response.writeHead(status, responseHeaders(state, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  }))
  response.end(JSON.stringify(payload))
}

export function writeRedirect(response, location, state) {
  response.writeHead(303, responseHeaders(state, { Location: location }))
  response.end()
}

export function writeMethodNotAllowed(response, allowed, state) {
  writeJson(response, 405, { error: 'method_not_allowed' }, state, { Allow: allowed.join(', ') })
}

export async function readJson(request, maximumBytes = 16_384) {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    const error = new Error('content_type_not_supported')
    error.status = 415
    throw error
  }

  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    const error = new Error('payload_too_large')
    error.status = 413
    throw error
  }

  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximumBytes) {
      const error = new Error('payload_too_large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('invalid_json')
    error.status = 400
    throw error
  }
}

export function requireSameOrigin(request, appOrigin) {
  return request.headers.origin === appOrigin
}

export function decodePath(requestUrl) {
  try {
    return decodeURIComponent((requestUrl ?? '/').split('?')[0])
  } catch {
    return null
  }
}
