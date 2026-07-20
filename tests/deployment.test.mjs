import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

test('Railway deployment uses the Docker health gate in Amsterdam', async () => {
  const config = JSON.parse(await readFile(resolve(root, 'railway.json'), 'utf8'))
  const dockerIgnore = await readFile(resolve(root, '.dockerignore'), 'utf8')
  const dockerfile = await readFile(resolve(root, 'Dockerfile'), 'utf8')

  assert.equal(config.build.builder, 'DOCKERFILE')
  assert.equal(config.build.dockerfilePath, 'Dockerfile')
  assert.equal(config.deploy.healthcheckPath, '/health')
  assert.equal(config.deploy.numReplicas, 1)
  assert.equal(config.deploy.region, 'europe-west4-drams3a')
  assert.equal(config.deploy.restartPolicyType, 'ON_FAILURE')
  assert.equal(config.deploy.sleepApplication, false)
  assert.match(dockerIgnore, /^\.railway\/$/m)
  assert.match(dockerfile, /PORT=8080/)
  assert.match(dockerfile, /process\.env\.PORT/)
})
