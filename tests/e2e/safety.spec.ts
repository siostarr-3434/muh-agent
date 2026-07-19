import { expect, test } from '@playwright/test'

const officialHosts = new Set([
  'ind.nl',
  'cjib.nl',
  'belastingdienst.nl',
  'waterland.nl',
  'rechtspraak.nl',
  'rijksoverheid.nl',
])

test('health endpoint and browser responses have security headers', async ({ request }) => {
  const health = await request.get('/health')
  expect(health.status()).toBe(200)
  expect(await health.json()).toMatchObject({ status: 'ok', service: 'muh-agent' })

  const response = await request.get('/')
  expect(response.headers()['content-security-policy']).toContain("default-src 'self'")
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['x-frame-options']).toBe('DENY')
  expect(response.headers()['referrer-policy']).toBe('no-referrer')
})

test('demo runtime API is explicit and private-cache only', async ({ request }) => {
  const session = await request.get('/api/session')
  expect(session.status()).toBe(200)
  expect(await session.json()).toEqual({ authenticated: false, mode: 'demo' })
  expect(session.headers()['cache-control']).toContain('no-store')

  const dashboard = await request.get('/api/dashboard')
  expect(dashboard.status()).toBe(503)
  expect(await dashboard.json()).toMatchObject({ error: 'live_connection_not_configured', mode: 'demo' })
})

test('API routes reject unsupported methods and unknown paths', async ({ request }) => {
  const method = await request.post('/api/session', { data: {} })
  expect(method.status()).toBe(405)
  expect(method.headers().allow).toBe('GET')

  const missing = await request.get('/api/does-not-exist')
  expect(missing.status()).toBe(404)
})

test('critical approval remains a local demo action', async ({ page }) => {
  const externalRequests: string[] = []
  page.on('request', (request) => {
    const hostname = new URL(request.url()).hostname
    if (!['127.0.0.1', 'localhost'].includes(hostname)) externalRequests.push(request.url())
  })

  await page.goto('/')
  await expect(page.getByText('Şu anda gerçek Gmail, banka, DigiD veya belge bağlantısı yok.')).toBeVisible()
  await page.getByTestId('nav-approvals').click()
  await page.getByRole('button', { name: 'Demo onayı ver' }).first().click()

  await expect(page.getByRole('status')).toContainText('dış sistemde işlem yapılmadı')
  await expect(page.getByText('Demo onaylandı').first()).toBeVisible()
  expect(externalRequests).toEqual([])
})

test('official source links stay inside the allowlist', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('nav-sources').click()

  const links = page.locator('.source-card a')
  await expect(links).toHaveCount(officialHosts.size)
  for (const href of await links.evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href))) {
    const url = new URL(href)
    expect(url.protocol).toBe('https:')
    expect(officialHosts.has(url.hostname)).toBe(true)
  }
})

test('mobile layout has no horizontal page overflow', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Mobile viewport check')
  await page.goto('/')
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }))
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.width)
})

test('encoded traversal never returns project files', async ({ request }) => {
  const response = await request.get('/%2e%2e%2fpackage.json')
  expect(response.status()).toBe(400)
  expect(await response.text()).not.toContain('"name": "muh-agent"')
})
