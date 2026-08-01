import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

async function readMigrationsSql() {
  const migrationsDirectory = resolve(root, 'supabase/migrations')
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort()
  return (await Promise.all(files.map((file) => readFile(resolve(migrationsDirectory, file), 'utf8')))).join('\n')
}

test('database policies are authenticated and approval execution is server-only', async () => {
  const sql = await readMigrationsSql()
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
  assert.match(config, /\[functions\.drive-sync\][\s\S]*?verify_jwt\s*=\s*false/)
  assert.match(config, /\[functions\.document-extract\][\s\S]*?verify_jwt\s*=\s*false/)
  assert.match(config, /\[functions\.life-watchdog\][\s\S]*?verify_jwt\s*=\s*false/)
  assert.match(config, /\[functions\.source-refresh\][\s\S]*?verify_jwt\s*=\s*false/)
  assert.match(config, /\[functions\.calendar-sync\][\s\S]*?verify_jwt\s*=\s*false/)
  assert.match(config, /\[functions\.approval-decision\][\s\S]*?verify_jwt\s*=\s*true/)
})

test('OAuth state consumption is single-use and race resistant', async () => {
  const callback = await readFile(resolve(root, 'supabase/functions/gmail-oauth-callback/index.ts'), 'utf8')
  assert.match(callback, /\.is\('consumed_at', null\)/)
  assert.match(callback, /\.gt\('expires_at'/)
  assert.match(callback, /\.select\([^)]*\)[\s\S]*?\.single\(\)/)
  assert.match(callback, /\.rpc\('connect_google_account'/)
  assert.match(callback, /tokens\.refresh_token/)
  assert.match(callback, /google_refresh_token_missing/)
  assert.match(callback, /scopeGranted/)
  assert.match(callback, /userinfo\.email/)
  assert.match(callback, /gmail_error/)
  assert.match(callback, /calendarRequested = oauthState\.scopes[\s\S]*?if \(!code \|\| requestUrl\.searchParams\.has\('error'\)\) return resultRedirect\('cancelled', undefined, calendarRequested\)/)
  assert.match(callback, /gmail_oauth_callback_failed/)
})

test('Gmail OAuth start validates configuration before creating an OAuth state', async () => {
  const start = await readFile(resolve(root, 'supabase/functions/gmail-oauth-start/index.ts'), 'utf8')
  const callback = await readFile(resolve(root, 'supabase/functions/gmail-oauth-callback/index.ts'), 'utf8')
  const configIndex = start.indexOf('const oauth = oauthConfig()')
  const stateInsertIndex = start.indexOf("from('oauth_states').insert")

  assert.ok(configIndex >= 0, 'OAuth configuration must be validated explicitly')
  assert.ok(stateInsertIndex > configIndex, 'OAuth state must not be created before configuration validation')
  assert.match(start, /GOOGLE_CLIENT_SECRET/)
  assert.match(start, /TOKEN_ENCRYPTION_KEY/)
  assert.match(start, /validateEncryptionKey/)
  assert.match(start, /\.eq\('provider', 'gmail'\)/)
  assert.match(start, /consume_audit_rate_limit/)
  assert.match(start, /\.lt\('expires_at'/)
  assert.match(start, /oauth_not_configured/)
  assert.match(start, /calendar\.events\.owned/)
  assert.match(start, /include_granted_scopes/)
  assert.match(start, /login_hint/)
  assert.match(start, /account_id:\s*includeCalendar/)
  assert.match(callback, /google_account_mismatch/)
  assert.match(callback, /oauthState\.account_id/)
  assert.match(callback, /const persistedScopes = \[\.\.\.new Set/)
  assert.match(callback, /p_scopes:\s*persistedScopes/)
})

test('Google Calendar sync is owner-scoped, private, idempotent, and audited', async () => {
  const calendar = await readFile(resolve(root, 'supabase/functions/calendar-sync/index.ts'), 'utf8')
  const migration = await readFile(resolve(root, 'supabase/migrations/0012_google_calendar_sync.sql'), 'utf8')
  const hardening = await readFile(resolve(root, 'supabase/migrations/0014_calendar_sync_hardening.sql'), 'utf8')
  const targetGuard = await readFile(resolve(root, 'supabase/migrations/0015_calendar_cron_target_guard.sql'), 'utf8')
  const failClosedGuard = await readFile(resolve(root, 'supabase/migrations/0016_calendar_cron_fail_closed.sql'), 'utf8')
  const targetPolicy = await readFile(resolve(root, 'supabase/migrations/0017_calendar_target_account_policy.sql'), 'utf8')
  const oauthStart = await readFile(resolve(root, 'supabase/functions/gmail-oauth-start/index.ts'), 'utf8')

  assert.match(calendar, /workerAuthorized/)
  assert.match(calendar, /client\.auth\.getUser\(token\)/)
  assert.match(calendar, /decryptSecret/)
  assert.match(calendar, /calendar\.events\.owned/)
  assert.match(calendar, /visibility:\s*'private'/)
  assert.match(calendar, /minutes:\s*connection\.reminder_minutes/)
  assert.match(calendar, /muhagent\$\{sourceType\}/)
  assert.match(calendar, /calendar_event_(created|updated)/)
  assert.match(calendar, /\.eq\('user_id', userId\)/)
  assert.match(calendar, /deleteGoogleEvent/)
  assert.match(calendar, /status:\s*'deleted'/)
  assert.match(calendar, /calendar_event_sync_started/)
  assert.match(calendar, /calendar_event_delete_started/)
  assert.doesNotMatch(calendar, /Belge \/ mesaj|Resmi ödeme|Taksit \/ plan|İtiraz:/)
  assert.match(calendar, /claim_calendar_connection/)
  assert.match(calendar, /\.in\('status', \['connected', 'error'\]\)/)
  assert.match(calendar, /invalid_grant/)
  assert.match(calendar, /calendarTargetEmail = 'siostarr@hairartclinics\.com'/)
  assert.match(calendar, /account\.email\.toLowerCase\(\) !== calendarTargetEmail/)
  assert.match(oauthStart, /data\.email\.toLowerCase\(\) !== calendarTargetEmail/)
  assert.doesNotMatch(calendar, /localStorage|sessionStorage/)

  assert.match(migration, /alter table public\.calendar_connections enable row level security/i)
  assert.match(migration, /alter table public\.calendar_event_links enable row level security/i)
  assert.match(migration, /grant select on public\.calendar_connections, public\.calendar_event_links to authenticated/i)
  assert.match(migration, /revoke all on function public\.connect_calendar_account[^;]*from public, anon, authenticated/i)
  assert.match(migration, /reminder_minutes integer not null default 2880/i)
  assert.match(migration, /unique \(account_id, source_type, source_id\)/i)
  assert.match(hardening, /connect_google_account/i)
  assert.match(hardening, /claim_calendar_connection/i)
  assert.match(hardening, /consume_audit_rate_limit/i)
  assert.match(hardening, /calendar_event_links_status_check[\s\S]*?'deleted'/i)
  assert.match(hardening, /muh_agent_supabase_url/i)
  assert.match(targetGuard, /expected_base_url constant text := 'https:\/\/uthtozqbacqjtaqitrsk\.supabase\.co'/i)
  assert.match(targetGuard, /is distinct from expected_base_url/i)
  assert.ok(failClosedGuard.indexOf("cron.unschedule('muh-agent-calendar-sync')") < failClosedGuard.indexOf('is distinct from expected_base_url'), 'Unsafe cron must be removed before target validation')
  assert.match(targetPolicy, /lower\(email\) = target_email/i)
})

test('document extraction uses custom auth and masks sensitive identifiers', async () => {
  const extract = await readFile(resolve(root, 'supabase/functions/document-extract/index.ts'), 'utf8')

  assert.match(extract, /workerAuthorized/)
  assert.match(extract, /admin\.auth\.getUser/)
  assert.match(extract, /openai_api_key_missing/)
  assert.match(extract, /BSN, tam IBAN, tam dosya numarası veya kimlik numarasını döndürme/)
  assert.match(extract, /payment_required/)
  assert.match(extract, /objection_deadline/)
  assert.match(extract, /paymentGuidanceFor/)
  assert.match(extract, /payment_guidance/)
  assert.match(extract, /betaling.*regeling|betalingsregeling/i)
  assert.match(extract, /persistObligation/)
  assert.match(extract, /persistDeadline/)
})

test('payment calendar shows official payment guidance and safe export', async () => {
  const app = await readFile(resolve(root, 'src/App.tsx'), 'utf8')
  const api = await readFile(resolve(root, 'src/api.ts'), 'utf8')
  const server = await readFile(resolve(root, 'scripts/server/api.mjs'), 'utf8')
  const migrations = await readMigrationsSql()

  assert.match(migrations, /payment_guidance\s+jsonb/i)
  assert.match(server, /payment_guidance/)
  assert.match(api, /payment_guidance/)
  assert.match(app, /Tek ödeme takvimi/)
  assert.match(app, /downloadPaymentCalendar/)
  assert.match(app, /muh-agent-odeme-takvimi\.ics/)
  assert.match(app, /Amsterdam Mijn Belastingen/)
  assert.match(app, /MijnDenHaag/)
  assert.match(app, /CJIB betalen/)
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
  assert.doesNotMatch(browserCode, /requestMagicLink|request-link|signInWithOtp/)
  assert.doesNotMatch(build, /PUBLIC_SUPABASE|SUPABASE_PUBLISHABLE_KEY/)
  assert.match(api, /credentials:\s*'same-origin'/)
  assert.match(api, /\/api\/auth\/sign-in/)
  assert.match(api, /\/api\/auth\/password/)
  assert.match(api, /\/api\/auth\/recover-password/)
})
