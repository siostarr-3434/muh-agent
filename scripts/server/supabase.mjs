import { createServerClient } from '@supabase/ssr'
import { parseCookie, stringifySetCookie } from 'cookie'
import { createResponseState } from './http.mjs'

export function serializeAuthCookie({ name, value, options = {} }, secure) {
  return stringifySetCookie({
    ...options,
    domain: undefined,
    httpOnly: true,
    name,
    path: '/',
    sameSite: 'lax',
    secure,
    value,
  })
}

export function createSupabaseRequestClient(request, config) {
  const state = createResponseState()
  const incoming = parseCookie(request.headers.cookie ?? '')

  const client = createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'pkce',
      persistSession: true,
    },
    cookieOptions: {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: config.cookieSecure,
    },
    cookies: {
      encode: 'tokens-only',
      getAll() {
        return Object.entries(incoming)
          .filter((entry) => typeof entry[1] === 'string')
          .map(([name, value]) => ({ name, value }))
      },
      setAll(cookies, headers) {
        Object.assign(state.headers, headers ?? {})
        for (const { name, value, options } of cookies) {
          state.cookies.set(name, serializeAuthCookie({ name, value, options }, config.cookieSecure))
        }
      },
    },
  })

  return { client, state }
}
