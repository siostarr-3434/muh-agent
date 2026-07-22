import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSetCookie } from 'cookie'
import { loadRuntimeConfig } from '../scripts/server/config.mjs'
import { requireSameOrigin } from '../scripts/server/http.mjs'
import { serializeAuthCookie } from '../scripts/server/supabase.mjs'

test('runtime config fails closed for partial or insecure live configuration', () => {
  assert.throws(() => loadRuntimeConfig({ SUPABASE_URL: 'https://example.supabase.co' }), /configured together/)
  assert.throws(() => loadRuntimeConfig({
    APP_ORIGIN: 'http://example.com',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_URL: 'https://example.supabase.co',
  }), /must use HTTPS/)

  const config = loadRuntimeConfig({
    APP_ORIGIN: 'https://muh.example.com',
    MUH_AGENT_HOST: '0.0.0.0',
    MUH_AGENT_PORT: '8080',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_URL: 'https://example.supabase.co',
  })
  assert.equal(config.live, true)
  assert.equal(config.cookieSecure, true)
})

test('runtime config prefers the hosting platform port', () => {
  const config = loadRuntimeConfig({
    MUH_AGENT_PORT: '8080',
    PORT: '12345',
  })

  assert.equal(config.port, 12345)
  assert.equal(config.appOrigin, 'http://127.0.0.1:12345')
})

test('auth cookies are host-only, HttpOnly, secure, and same-site', () => {
  const parsed = parseSetCookie(serializeAuthCookie({
    name: 'sb-session',
    options: { domain: 'attacker.example', httpOnly: false, path: '/unsafe', sameSite: 'none', secure: false },
    value: 'opaque-value',
  }, true))

  assert.equal(parsed.name, 'sb-session')
  assert.equal(parsed.value, 'opaque-value')
  assert.equal(parsed.domain, undefined)
  assert.equal(parsed.httpOnly, true)
  assert.equal(parsed.secure, true)
  assert.equal(parsed.sameSite, 'lax')
  assert.equal(parsed.path, '/')
})

test('same-origin validation is exact', () => {
  const request = { headers: { origin: 'https://muh.example.com' } }
  assert.equal(requireSameOrigin(request, 'https://muh.example.com'), true)
  assert.equal(requireSameOrigin(request, 'https://example.com'), false)
  assert.equal(requireSameOrigin({ headers: {} }, 'https://muh.example.com'), false)
})

test('server auth uses password login and no magic-link route', async () => {
  const api = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../scripts/server/api.mjs', import.meta.url), 'utf8'))

  assert.match(api, /\/api\/auth\/sign-in/)
  assert.match(api, /\/api\/auth\/password/)
  assert.match(api, /signInWithPassword/)
  assert.match(api, /updateUser/)
  assert.doesNotMatch(api, /signInWithOtp/)
  assert.doesNotMatch(api, /\/api\/auth\/request-link/)
})
