import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const image = 'postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'
const container = `muh-agent-postgres-${randomUUID().slice(0, 8)}`

function docker(args, input, acceptedStatuses = [0]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 10 * 1024 * 1024 })
  if (!acceptedStatuses.includes(result.status ?? -1)) {
    throw new Error(`docker ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`)
  }
  return result
}

function psql(sql, acceptedStatuses = [0], extraArgs = []) {
  return docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', ...extraArgs], sql, acceptedStatuses)
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const logResult = docker(['logs', container], undefined, [0])
    const initializationComplete = `${logResult.stdout}\n${logResult.stderr}`.includes('PostgreSQL init process complete; ready for start up.')
    const ready = initializationComplete
      && docker(['exec', container, 'pg_isready', '-U', 'postgres'], undefined, [0, 1, 2]).status === 0
    if (ready) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  throw new Error('Postgres test container did not become ready')
}

const bootstrap = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
`

const behaviorVerification = `
insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
insert into public.obligations (user_id, authority, title, category, amount)
values
  ('00000000-0000-4000-8000-000000000001', 'test', 'first user', 'fine', 10),
  ('00000000-0000-4000-8000-000000000002', 'test', 'second user', 'fine', 20);
insert into public.approvals (id, user_id, action_type, risk, payload)
values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'payment', 'high', '{"title":"test"}');
select * from public.decide_approval('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'approved');
select * from public.decide_approval('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'approved');
select public.connect_gmail_account('00000000-0000-4000-8000-000000000001', 'test@example.com', array['openid','email'], 'encrypted-test-token');
select json_build_object(
  'profile_trigger', (select count(*) from public.profiles),
  'approval_status', (select status from public.approvals where id = '10000000-0000-4000-8000-000000000001'),
  'approval_audit', (select count(*) from public.audit_events where event_type = 'approval_approved'),
  'gmail_token', (select count(*) from public.email_tokens),
  'gmail_audit', (select count(*) from public.audit_events where event_type = 'gmail_account_connected'),
  'public_tables_without_rls', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  'authenticated_can_decide', has_function_privilege('authenticated', 'public.decide_approval(uuid,uuid,text)', 'execute'),
  'authenticated_can_update_approvals', has_table_privilege('authenticated', 'public.approvals', 'update'),
  'service_role_can_decide', has_function_privilege('service_role', 'public.decide_approval(uuid,uuid,text)', 'execute'),
  'user_sources_source_fk_indexed', exists (
    select 1
    from pg_index i
    join pg_attribute a
      on a.attrelid = i.indrelid
      and a.attname = 'source_id'
    where i.indrelid = 'public.user_sources'::regclass
      and i.indisvalid
      and i.indisready
      and i.indkey[0] = a.attnum
  )
);
`

const rlsVerification = `
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false);
select count(*) from public.obligations;
`

try {
  docker(['run', '--rm', '--detach', '--name', container, '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', image])
  await waitForPostgres()
  psql(bootstrap)

  const migrationsDirectory = resolve(import.meta.dirname, '..', 'supabase', 'migrations')
  const migrationFiles = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort()
  assert.ok(migrationFiles.length > 0, 'No SQL migrations were found')

  for (let application = 0; application < 2; application += 1) {
    for (const migrationFile of migrationFiles) {
      const migration = await readFile(resolve(migrationsDirectory, migrationFile), 'utf8')
      psql(migration)
    }
  }

  const behavior = psql(behaviorVerification, [0], ['-A', '-t']).stdout
  const resultLine = behavior.split(/\r?\n/).findLast((line) => line.trim().startsWith('{'))
  if (!resultLine) throw new Error('Postgres verification did not return its JSON result')
  const result = JSON.parse(resultLine)

  const rlsRows = Number(psql(rlsVerification, [0], ['-A', '-t']).stdout.trim().split(/\r?\n/).at(-1))
  const missingToken = psql(`select public.connect_gmail_account('00000000-0000-4000-8000-000000000001', 'missing-token@example.com', array['openid'], null);`, [0, 3])
  if (missingToken.status === 0) throw new Error('Missing refresh token was unexpectedly accepted')
  const partialRows = Number(psql(`select count(*) from public.email_accounts where email = 'missing-token@example.com';`, [0], ['-A', '-t']).stdout.trim())

  const expected = {
    approval_audit: 1,
    approval_status: 'approved',
    authenticated_can_decide: false,
    authenticated_can_update_approvals: false,
    gmail_audit: 1,
    gmail_token: 1,
    profile_trigger: 2,
    public_tables_without_rls: 0,
    service_role_can_decide: true,
    user_sources_source_fk_indexed: true,
  }
  assert.deepEqual(result, expected, 'Unexpected migration verification result')
  if (rlsRows !== 1) throw new Error(`RLS exposed ${rlsRows} obligation rows instead of 1`)
  if (partialRows !== 0) throw new Error('Failed Gmail transaction left a partial account row')

  console.log(JSON.stringify({ migrationApplications: migrationFiles.length * 2, migrationFiles, partialRows, rlsVisibleRows: rlsRows, ...result }))
} finally {
  docker(['stop', container], undefined, [0, 1])
}
