import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

test('production build includes installable app shell', async () => {
  const html = await readFile(resolve(root, 'dist/index.html'), 'utf8')
  const manifest = await readFile(resolve(root, 'dist/manifest.webmanifest'), 'utf8')
  const asset = await readFile(resolve(root, 'dist/assets/main.js'), 'utf8')

  assert.match(html, /manifest\.webmanifest/)
  assert.match(html, /assets\/main\.js/)
  assert.match(manifest, /"display": "standalone"/)
  assert.ok(asset.length > 100_000)
})

test('client bundle does not contain server secrets', async () => {
  const asset = await readFile(resolve(root, 'dist/assets/main.js'), 'utf8')
  for (const secretName of ['SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'OPENAI_API_KEY']) {
    assert.equal(asset.includes(secretName), false, `${secretName} leaked to client bundle`)
  }
  assert.equal(asset.includes('process.env.NODE_ENV'), false, 'Node environment reference leaked to browser bundle')
})
