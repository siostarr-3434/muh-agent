import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

test('database policies are authenticated and approval execution is server-only', async () => {
  const sql = await readFile(resolve(root, 'supabase/migrations/0001_core.sql'), 'utf8')
  const policies = sql.match(/create policy[\s\S]*?;/gi) ?? []

  assert.ok(policies.length > 0, 'RLS policies are missing')
  for (const policy of policies) {
    assert.match(policy, /\bto authenticated\b/i, `Policy has no authenticated role: ${policy.split('\n')[0]}`)
    if (/\buser_id\b|auth\.uid\(\)/i.test(policy)) {
      assert.match(policy, /\(select auth\.uid\(\)\)/i, `Policy does not cache auth.uid(): ${policy.split('\n')[0]}`)
    }
  }

  assert.doesNotMatch(sql, /create policy "approvals own decisions"/i)
  assert.match(sql, /grant\s+select\s+on\s+[^;]*public\.approvals[^;]*to\s+authenticated/i)
  assert.match(sql, /create or replace function public\.decide_approval[\s\S]*?insert into public\.audit_events/i)
  assert.match(sql, /revoke all on function public\.decide_approval[^;]*from public, anon, authenticated/i)
})

test('Edge Function JWT boundaries are explicit', async () => {
  const config = await readFile(resolve(root, 'supabase/config.toml'), 'utf8')
  assert.match(config, /\[functions\.gmail-oauth-start\][\s\S]*?verify_jwt\s*=\s*true/)
  assert.match(config, /\[functions\.gmail-oauth-callback\][\s\S]*?verify_jwt\s*=\s*false/)
  assert.match(config, /\[functions\.gmail-sync\][\s\S]*?verify_jwt\s*=\s*false/)
  assert.match(config, /\[functions\.approval-decision\][\s\S]*?verify_jwt\s*=\s*true/)
})

test('OAuth state consumption is single-use and race resistant', async () => {
  const callback = await readFile(resolve(root, 'supabase/functions/gmail-oauth-callback/index.ts'), 'utf8')
  assert.match(callback, /\.is\('consumed_at', null\)/)
  assert.match(callback, /\.gt\('expires_at'/)
  assert.match(callback, /\.select\([^)]*\)\.single\(\)/)
  assert.match(callback, /\.rpc\('connect_gmail_account'/)
})

test('package versions are reproducible', async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  for (const [name, version] of Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
    assert.notEqual(version, 'latest', `${name} must be pinned`)
    assert.match(version, /^\d+\.\d+\.\d+/, `${name} must use an exact version`)
  }
})

test('browser code has no direct Supabase client or token storage', async () => {
  const app = await readFile(resolve(root, 'src/App.tsx'), 'utf8')
  const api = await readFile(resolve(root, 'src/api.ts'), 'utf8')
  const build = await readFile(resolve(root, 'scripts/build.mjs'), 'utf8')
  const browserCode = `${app}\n${api}`

  assert.doesNotMatch(browserCode, /localStorage|sessionStorage/)
  assert.doesNotMatch(browserCode, /@supabase\/(supabase-js|ssr)/)
  assert.doesNotMatch(build, /PUBLIC_SUPABASE|SUPABASE_PUBLISHABLE_KEY/)
  assert.match(api, /credentials:\s*'same-origin'/)
})
